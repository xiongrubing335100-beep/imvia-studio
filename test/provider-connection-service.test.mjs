import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdapterRegistry } from "../src/providers/adapter-registry.js";
import { createConnectionStore } from "../src/providers/connection-store.js";
import { createProviderConnectionService } from "../src/providers/provider-connection-service.js";
import { createProviderRegistry } from "../src/providers/provider-registry.js";

const descriptor = { id: "external-api", display_name: "External API", kind: "discovered", adapter_id: null, capabilities: ["image", "video"], models: [], credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }] };
const catalog = (models = [{ id: "image-1" }]) => ({ digest: `digest-${models.length}`, discovered_at: "2026-08-25T00:00:00.000Z", models, counts: { total: models.length, confirmed: models.length, unconfirmed: 0, unsupported: 0 } });
const recognized = (models) => ({ protocol: "fixture", adapter_id: "fixture-images", adapter_version: "1", provider_label: "Fixture", models_endpoint: "https://api.example.test/v1/models", catalog: catalog(models) });

function adapter() {
  return { id: "fixture-images", version: "1", async discover() { return {}; }, classifyModel: () => ({ capabilities: ["image"], compatibility: "confirmed" }), estimateCost: () => ({}), validateConnection: async () => ({}), submit: async () => ({}), poll: async () => ({}), cancel: async () => ({}), importResults: async () => ({}) };
}

async function fixture(context, { result = recognized(), configure, read, clear } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-connection-service-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(dataDirectory, { recursive: true, force: true })); });
  const registry = createProviderRegistry({ builtIns: [descriptor] });
  let nextConnection = 0;
  const connectionStore = createConnectionStore({ dataDirectory, registry, id: () => `modern-connection-${++nextConnection}` });
  const adapterRegistry = createAdapterRegistry({ adapters: [adapter()] });
  const calls = [];
  const credentialService = {
    async status() { return { status: "setup_required" }; },
    async configure(options) { calls.push(["configure", options.connection_id]); return configure ? configure(options) : (await options.validate({ api_key: "private-key" }), { status: "connected", code: "CONNECTED" }); },
    async read({ credential_ref }) { calls.push(["read", credential_ref]); return read ? read({ credential_ref }) : { api_key: "private-key" }; },
    async clear({ credential_ref }) { calls.push(["clear", credential_ref]); return clear ? clear({ credential_ref }) : { status: "setup_required", code: "SETUP_REQUIRED" }; },
  };
  const discoveryService = { async discover(input) { calls.push(["discover", input.base_url]); if (result instanceof Error) throw result; return result; } };
  return { calls, connectionStore, service: createProviderConnectionService({ connectionStore, credentialService, discoveryService, adapterRegistry }) };
}

test("creates a draft before secure configuration and atomically connects a recognized catalog", async (context) => {
  const { calls, service } = await fixture(context);
  const draft = await service.createDraft({ name: "", base_url: "api.example.test/v1" });
  const connected = await service.configureAndDiscover({ connection_id: draft.connection_id });
  assert.equal(connected.status, "connected");
  assert.equal(connected.enabled, true);
  assert.deepEqual(calls.map(([operation]) => operation), ["configure", "discover"]);
});

test("recognizes an empty catalog without rejecting the key and cleans up credentials on removal", async (context) => {
  const { calls, service } = await fixture(context, { result: recognized([]) });
  const draft = await service.createDraft({ name: "Empty", base_url: "api.example.test" });
  const empty = await service.configureAndDiscover({ connection_id: draft.connection_id });
  assert.equal(empty.status, "no_models");
  assert.equal(empty.enabled, false);
  await service.remove({ connection_id: draft.connection_id });
  assert.equal(calls.some(([operation]) => operation === "clear"), true);
});

test("derives isolated modern credential profiles and never configures or clears a sibling profile", async (context) => {
  const { calls, connectionStore, service } = await fixture(context);
  await assert.rejects(service.createDraft({ name: "Rejected", base_url: "api.example.test", credential_ref: "foreign-profile" }), (error) => error.code === "VALIDATION_FAILED");
  const first = await service.createDraft({ name: "First", base_url: "api.example.test" });
  const second = await service.createDraft({ name: "Second", base_url: "second.example.test" });
  assert.notEqual(first.credential_ref, second.credential_ref);
  assert.equal(first.credential_ref, `external-api-${first.connection_id}`);
  await service.configureAndDiscover({ connection_id: first.connection_id });
  await service.remove({ connection_id: first.connection_id });
  assert.deepEqual(calls.filter(([operation]) => operation === "configure" || operation === "clear"), [
    ["configure", first.credential_ref], ["clear", first.credential_ref],
  ]);
  assert.equal(await connectionStore.get(second.connection_id) !== null, true);
});

test("retains a modern connection when private credential cleanup fails", async (context) => {
  const { connectionStore, service } = await fixture(context, { clear: async () => ({ status: "setup_required", code: "CREDENTIAL_STORE_DENIED" }) });
  const draft = await service.createDraft({ name: "Protected", base_url: "api.example.test" });
  await assert.rejects(service.remove({ connection_id: draft.connection_id }), (error) => error.code === "CREDENTIAL_STORE_DENIED");
  assert.equal(await connectionStore.get(draft.connection_id) !== null, true);
});

test("records a redacted failed draft when credential setup cannot produce a recognized discovery", async (context) => {
  const { connectionStore, service } = await fixture(context, { configure: async () => ({ status: "setup_required", code: "SETUP_CANCELLED" }) });
  const draft = await service.createDraft({ name: "Retry", base_url: "api.example.test" });
  const failed = await service.configureAndDiscover({ connection_id: draft.connection_id });
  assert.equal(failed.status, "failed");
  assert.equal((await connectionStore.get(draft.connection_id)).last_discovery.code, "SETUP_CANCELLED");
});

test("does not invalidate a usable catalog when its refresh fails", async (context) => {
  const { connectionStore, service } = await fixture(context, { read: async () => { throw Object.assign(new Error("offline"), { code: "UPSTREAM_UNREACHABLE" }); } });
  const draft = await service.createDraft({ name: "Refresh", base_url: "api.example.test" });
  await service.configureAndDiscover({ connection_id: draft.connection_id });
  const original = await connectionStore.get(draft.connection_id);
  await service.refreshModels({ connection_id: draft.connection_id });
  const retained = await connectionStore.get(draft.connection_id);
  assert.equal(retained.status, "connected");
  assert.equal(retained.enabled, true);
  assert.deepEqual(retained.model_catalog, original.model_catalog);
});

test("updates the display name without invalidation and requires rediscovery after an address change", async (context) => {
  const { calls, service } = await fixture(context);
  const draft = await service.createDraft({ name: "Start", base_url: "api.example.test/v1" });
  const connected = await service.configureAndDiscover({ connection_id: draft.connection_id });
  const renamed = await service.update({ connection_id: draft.connection_id, name: "Display only" });
  assert.equal(renamed.config_revision, connected.config_revision);
  assert.equal(renamed.enabled, true);
  const moved = await service.update({ connection_id: draft.connection_id, base_url: "new.example.test/v1/" });
  assert.equal(moved.base_url, "https://new.example.test/v1");
  assert.equal(moved.status, "draft");
  assert.equal(moved.enabled, false);
  assert.equal(moved.config_revision, connected.config_revision + 1);
  const retried = await service.configureAndDiscover({ connection_id: draft.connection_id });
  assert.equal(retried.config_revision, moved.config_revision);
  assert.equal(calls.filter(([operation]) => operation === "discover").at(-1)[1], "https://new.example.test/v1");
});
