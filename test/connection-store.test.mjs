import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConnectionStore } from "../src/providers/connection-store.js";
import { createProviderRegistry } from "../src/providers/provider-registry.js";

const adapter = Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, async () => ({ ok: true })]));
const descriptor = {
  id: "generic", display_name: "Generic", kind: "generic_rest", capabilities: ["image"],
  models: [{ id: "image-v1", capabilities: ["image"] }], credential_fields: [
    { id: "api_key", label: "API Key", secret: true, required: true },
    { id: "authorization", label: "Authorization", secret: true, required: false },
    { id: "bearer_token", label: "Bearer Token", secret: true, required: false },
    { id: "session_cookie", label: "Session Cookie", secret: true, required: false },
    { id: "account", label: "Account", secret: false, required: false },
  ],
};
const externalDescriptor = {
  id: "external-api", display_name: "External API", kind: "discovered", capabilities: ["image", "video"], models: [], adapter_id: null,
  credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }],
};

async function fixture(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-connections-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(dataDirectory, { recursive: true, force: true })); });
  const registry = createProviderRegistry({ builtIns: [descriptor, externalDescriptor], adapters: [{ id: "rest", adapter }] });
  return { dataDirectory, store: createConnectionStore({ dataDirectory, registry }) };
}

const input = (name = "Primary") => ({
  name,
  provider_id: "generic",
  base_url: "https://api.example.test",
  endpoint_mappings: { submit: { method: "POST", path: "/jobs" }, poll: { method: "GET", path: "/jobs/{id}" } },
  capabilities: ["image"],
  models: ["image-v1"],
  credential_ref: "profile-primary",
  enabled: true,
  settings: { poll_interval_ms: 1_000, timeout_ms: 30_000, concurrency_limit: 1 },
});

const discoveryFixture = ({ digest = "catalog-a", adapter_id = "fixture-images", adapter_version = "1", models = [{ id: "image-v1" }] } = {}) => ({
  protocol: "fixture", adapter_id, adapter_version, provider_label: "Fixture", models_endpoint: "https://api.example.test/v1/models",
  catalog: { digest, discovered_at: "2026-08-25T00:00:00.000Z", models, counts: { total: models.length, confirmed: models.length, unconfirmed: 0, unsupported: 0 } },
});

const catalogFixture = ({ digest = "catalog-b", models = [{ id: "image-v2" }] } = {}) => ({
  digest, discovered_at: "2026-08-25T01:00:00.000Z", models, counts: { total: models.length, confirmed: models.length, unconfirmed: 0, unsupported: 0 },
});

test("creates private, secret-free connection profiles with UUIDs and revision one", async (context) => {
  const { dataDirectory, store } = await fixture(context);
  const created = await store.create(input());
  assert.match(created.connection_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(created.config_revision, 1);
  assert.equal(created.provider_descriptor.id, "generic");
  assert.deepEqual(await store.get(created.connection_id), created);

  const file = path.join(dataDirectory, "provider-connections-v1.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const serialized = await readFile(file, "utf8");
  assert.equal(serialized.includes("api_key"), true, "descriptor metadata is allowed");
  assert.equal(serialized.includes("private-secret-value"), false);
});

test("rejects secret-bearing input and duplicate names without changing the file", async (context) => {
  const { dataDirectory, store } = await fixture(context);
  await store.create(input());
  const file = path.join(dataDirectory, "provider-connections-v1.json");
  const before = await readFile(file, "utf8");
  await assert.rejects(store.create({ ...input("Secret"), api_key: "private-secret-value" }), (error) => error.code === "VALIDATION_FAILED");
  await assert.rejects(store.create({ ...input("Nested Secret"), settings: { authentication: { authorization: "private-authorization" } } }), (error) => error.code === "VALIDATION_FAILED");
  await assert.rejects(store.create({ ...input("Mapped Secret"), endpoint_mappings: { submit: { bearer_token: "private-bearer" } } }), (error) => error.code === "VALIDATION_FAILED");
  await assert.rejects(store.create({ ...input("Cookie Secret"), settings: { chain: [{ session_cookie: "private-cookie" }] } }), (error) => error.code === "VALIDATION_FAILED");
  await assert.rejects(store.create(input(" primary ")), (error) => error.code === "VALIDATION_FAILED");
  assert.equal(await readFile(file, "utf8"), before);
});

test("serializes concurrent atomic updates and deletes only the selected profile", async (context) => {
  const { store } = await fixture(context);
  const first = await store.create(input("One"));
  const second = await store.create({ ...input("Two"), credential_ref: "profile-two" });
  await Promise.all([
    store.update(first.connection_id, { enabled: false }),
    store.update(first.connection_id, { settings: { poll_interval_ms: 2_000 } }),
  ]);
  const updated = await store.get(first.connection_id);
  assert.equal(updated.config_revision, 3);
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.settings, { poll_interval_ms: 2_000 });
  await store.markTested(first.connection_id, { status: "connected", code: "CONNECTED" });
  assert.equal((await store.get(first.connection_id)).last_test.code, "CONNECTED");
  await store.markTested(first.connection_id, { status: "failed", code: "AUTHENTICATION_FAILED", message: "private-bearer was rejected" });
  assert.deepEqual(Object.keys((await store.get(first.connection_id)).last_test).sort(), ["code", "status", "tested_at"]);
  await store.remove(first.connection_id);
  assert.equal(await store.get(first.connection_id), null);
  assert.equal((await store.get(second.connection_id)).name, "Two");
});

test("migrates the existing state file, makes a private backup, and preserves legacy custom REST mappings", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-connections-migration-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(dataDirectory, { recursive: true, force: true })); });
  const registry = createProviderRegistry({ builtIns: [descriptor, externalDescriptor], adapters: [{ id: "rest", adapter }] });
  const legacy = { connection_id: "legacy-connection", ...input("Legacy"), config_revision: 3, created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z", last_test: null };
  await writeFile(path.join(dataDirectory, "provider-connections-v1.json"), `${JSON.stringify({ schema_version: "provider-connections-v1", connections: [legacy] }, null, 2)}\n`, { mode: 0o600 });
  const store = createConnectionStore({ dataDirectory, registry });

  const [migrated] = await store.list();
  assert.equal(migrated.legacy, true);
  assert.deepEqual(migrated.endpoint_mappings, legacy.endpoint_mappings);
  assert.deepEqual(migrated.settings, legacy.settings);
  const migratedFile = await readFile(path.join(dataDirectory, "provider-connections-v1.json"), "utf8");
  assert.match(migratedFile, /"schema_version": "provider-connections-v2"/);
  const backup = path.join(dataDirectory, "provider-connections-v1.json.backup-vprovider-connections-v1-to-vprovider-connections-v2");
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(backup, "utf8")).connections[0].endpoint_mappings, legacy.endpoint_mappings);
});

test("creates safe modern drafts and keeps catalog changes separate from execution configuration", async (context) => {
  const { store } = await fixture(context);
  const draft = await store.createDraft({ name: "", base_url: "api.example.test/v1" });
  assert.equal(draft.name, "api.example.test");
  assert.equal(draft.name_source, "hostname");
  assert.equal(draft.base_url, "https://api.example.test/v1");
  assert.match(draft.credential_ref, /^external-api-/);
  assert.equal(draft.status, "draft");
  assert.equal(draft.enabled, false);
  assert.equal(Object.hasOwn(draft, "endpoint_mappings"), false);
  assert.equal(Object.hasOwn(draft, "settings"), false);
  const duplicate = await store.createDraft({ name: "", base_url: "api.example.test/v1" });
  assert.equal(duplicate.name, "api.example.test 2");

  const connected = await store.completeDiscovery(draft.connection_id, discoveryFixture());
  assert.equal(connected.status, "connected");
  assert.equal(connected.enabled, true);
  assert.equal(connected.model_catalog_revision, 1);
  const refreshed = await store.replaceCatalog(draft.connection_id, catalogFixture());
  assert.equal(refreshed.config_revision, connected.config_revision);
  assert.equal(refreshed.model_catalog_revision, connected.model_catalog_revision + 1);
  const changedCredentials = await store.markCredentialsChanged(draft.connection_id);
  assert.equal(changedCredentials.config_revision, refreshed.config_revision + 1);
  const adapterChanged = await store.completeDiscovery(draft.connection_id, discoveryFixture({ adapter_id: "other-images" }));
  assert.equal(adapterChanged.config_revision, changedCredentials.config_revision + 1);
  await assert.rejects(store.createDraft({ name: "Escalate", base_url: "api.example.test", credential_ref: "profile-another-connection" }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "credential_ref");
});

test("updates modern display names without invalidation and restarts discovery after an address change", async (context) => {
  const { store } = await fixture(context);
  const draft = await store.createDraft({ name: "Original", base_url: "api.example.test/v1" });
  const connected = await store.completeDiscovery(draft.connection_id, discoveryFixture());
  const renamed = await store.updateModern(draft.connection_id, { name: "Renamed" });
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.enabled, true);
  assert.equal(renamed.config_revision, connected.config_revision);
  const moved = await store.updateModern(draft.connection_id, { base_url: "new.example.test/v1/" });
  assert.equal(moved.base_url, "https://new.example.test/v1");
  assert.equal(moved.status, "draft");
  assert.equal(moved.enabled, false);
  assert.equal(moved.model_catalog, null);
  assert.equal(moved.config_revision, connected.config_revision + 1);
  const retried = await store.completeDiscovery(draft.connection_id, discoveryFixture());
  assert.equal(retried.config_revision, moved.config_revision, "same trusted adapter does not add a second address revision");
  assert.equal(retried.status, "connected");
});

test("toggles a discovered modern connection without changing its configuration or catalog revision", async (context) => {
  const { store } = await fixture(context);
  const draft = await store.createDraft({ name: "Toggle", base_url: "api.example.test/v1" });
  const connected = await store.completeDiscovery(draft.connection_id, discoveryFixture());
  const disabled = await store.updateModern(draft.connection_id, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, "connected");
  assert.equal(disabled.config_revision, connected.config_revision);
  assert.equal(disabled.model_catalog_revision, connected.model_catalog_revision);
  const enabled = await store.updateModern(draft.connection_id, { enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.config_revision, connected.config_revision);
  assert.equal(enabled.model_catalog_revision, connected.model_catalog_revision);
  await assert.rejects(store.updateModern(draft.connection_id, { enabled: "yes" }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "enabled");
  const unrecognized = await store.createDraft({ name: "Draft", base_url: "draft.example.test/v1" });
  await assert.rejects(store.updateModern(unrecognized.connection_id, { enabled: true }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "enabled");
});

test("retains failed drafts safely and disables recognized empty catalogs", async (context) => {
  const { store } = await fixture(context);
  const draft = await store.createDraft({ name: "No models", base_url: "https://models.example.test" });
  const empty = await store.completeDiscovery(draft.connection_id, discoveryFixture({ models: [] }));
  assert.equal(empty.status, "no_models");
  assert.equal(empty.enabled, false);
  const failed = await store.failDiscovery(draft.connection_id, { code: "AUTHENTICATION_FAILED" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.enabled, false);
  assert.deepEqual(failed.last_discovery, { status: "failed", code: "AUTHENTICATION_FAILED" });
});
