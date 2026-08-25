import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startHttpServer } from "../src/http/server.js";
import { createAdapterRegistry } from "../src/providers/adapter-registry.js";
import { createConnectionStore } from "../src/providers/connection-store.js";
import { createProviderConnectionService } from "../src/providers/provider-connection-service.js";
import { createProviderRegistry } from "../src/providers/provider-registry.js";

const externalDescriptor = {
  id: "external-api", display_name: "External API", kind: "discovered", adapter_id: null,
  capabilities: ["image", "video"], models: [], credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }],
};
const legacyDescriptor = {
  id: "fixture-api", display_name: "Fixture API", kind: "generic_rest", capabilities: ["image"],
  models: [{ id: "legacy-image", name: "Legacy Image" }], credential_fields: [{ id: "api_key", label: "API key", secret: true, required: true }],
};
const mutationHeaders = Object.freeze({
  "content-type": "application/json",
  "x-imvia-workbench-session": "fixture-session",
  "x-imvia-workbench-token": "fixture-token",
});

async function json(response) { return { status: response.status, body: await response.json() }; }
function fixtureAdapter() {
  return {
    id: "fixture-images", version: "1", async discover() { return {}; },
    classifyModel: () => ({ capabilities: ["image"], compatibility: "confirmed" }), estimateCost: () => ({ status: "unknown" }),
    validateConnection: async () => ({}), submit: async () => ({}), poll: async () => ({}), cancel: async () => ({}), importResults: async () => ({}),
  };
}
async function startFixture(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-provider-http-"));
  const registry = createProviderRegistry({ builtIns: [externalDescriptor, legacyDescriptor] });
  let nextId = 0;
  const connectionStore = createConnectionStore({ dataDirectory, registry, id: () => `fixture-connection-${++nextId}` });
  const adapterRegistry = createAdapterRegistry({ adapters: [fixtureAdapter()] });
  const discoveryService = {
    async discover({ base_url, credential }) {
      assert.equal(base_url, "https://api.example.test/v1"); assert.equal(credential.api_key, "only-in-native-helper");
      return { protocol: "fixture", adapter_id: "fixture-images", adapter_version: "1", provider_label: "Fixture API", models_endpoint: "https://api.example.test/v1/models", catalog: { digest: "fixture-catalog", discovered_at: "2026-08-25T00:00:00.000Z", models: [{ id: "image-1", display_name: "Image One", capabilities: ["image"], compatibility: "confirmed", source: "api", raw_index: 0 }], counts: { total: 1, confirmed: 1, unconfirmed: 0, unsupported: 0 } } };
    },
  };
  const credentialService = {
    async configure({ connection_id, fields, validate, onState }) { assert.match(connection_id, /^external-api-fixture-connection-/u); assert.equal(fields[0].id, "api_key"); onState("opening"); onState("validating"); assert.deepEqual(await validate({ api_key: "only-in-native-helper" }), { accepted: true, code: "CONNECTED" }); return { status: "connected", code: "CONNECTED" }; },
    async read() { return { api_key: "only-in-native-helper" }; }, async clear() { return { status: "setup_required", code: "SETUP_REQUIRED" }; },
  };
  const providerConnectionService = createProviderConnectionService({ connectionStore, credentialService, discoveryService, adapterRegistry });
  const bridgeService = { async validateSessionToken({ session_id, open_token }) { assert.equal(session_id, "fixture-session"); assert.equal(open_token, "fixture-token"); } };
  const server = await startHttpServer({ dataDirectory, port: 0, providerRegistry: registry, connectionStore, providerConnectionService, bridgeService });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { server, connectionStore };
}
async function sseThroughCompletion(response) {
  const reader = response.body.getReader();
  let output = "";
  while (!output.includes('"stage":"completed"')) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return output;
}

test("provider HTTP exposes the modern discovery lifecycle without legacy mappings or credentials", async (context) => {
  const { server, connectionStore } = await startFixture(context);
  const legacy = await connectionStore.create({ provider_id: "fixture-api", name: "Legacy", base_url: "https://legacy.example.test", endpoint_mappings: { submit: { path: "/generate" } }, settings: { timeout: 1 } });
  for (const field of ["provider_id", "capabilities", "models", "endpoint_mappings", "settings", "api_key", "secret_key"]) {
    const rejected = await json(await fetch(`${server.url}/api/v1/connections`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ name: "Rejected", base_url: "api.example.test/v1", [field]: field === "api_key" ? "private" : [] }) }));
    assert.equal(rejected.status, 400, field); assert.equal(rejected.body.error.code, "VALIDATION_FAILED", field);
  }
  const created = await json(await fetch(`${server.url}/api/v1/connections`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ name: "Mix API", base_url: "api.example.test/v1" }) }));
  assert.equal(created.status, 201); assert.equal(created.body.data.connection.enabled, false); assert.equal(created.body.data.connection.name, "Mix API"); assert.equal(JSON.stringify(created.body).includes("endpoint_mappings"), false); assert.equal(JSON.stringify(created.body).includes("credential_ref"), false);
  const events = await fetch(`${server.url}/api/v1/events`);
  const configured = await json(await fetch(`${server.url}/api/v1/connections/${created.body.data.connection.connection_id}/credentials`, { method: "POST", headers: mutationHeaders }));
  assert.equal(configured.status, 200); assert.equal(configured.body.data.connection.enabled, true); assert.equal(configured.body.data.discovery.model_count, 1); assert.deepEqual(configured.body.data.connection.catalog.models.map(({ id, name }) => [id, name]), [["image-1", "Image One"]]);
  const initialRevision = configured.body.data.connection.config_revision;
  const initialCatalogRevision = configured.body.data.connection.model_catalog_revision;
  const disabled = await json(await fetch(`${server.url}/api/v1/connections/${created.body.data.connection.connection_id}`, { method: "PATCH", headers: mutationHeaders, body: JSON.stringify({ enabled: false }) }));
  assert.equal(disabled.status, 200); assert.equal(disabled.body.data.connection.enabled, false); assert.equal(disabled.body.data.connection.config_revision, initialRevision); assert.equal(disabled.body.data.connection.model_catalog_revision, initialCatalogRevision);
  const enabled = await json(await fetch(`${server.url}/api/v1/connections/${created.body.data.connection.connection_id}`, { method: "PATCH", headers: mutationHeaders, body: JSON.stringify({ enabled: true }) }));
  assert.equal(enabled.status, 200); assert.equal(enabled.body.data.connection.enabled, true); assert.equal(enabled.body.data.connection.config_revision, initialRevision); assert.equal(enabled.body.data.connection.model_catalog_revision, initialCatalogRevision);
  const eventChunk = await sseThroughCompletion(events);
  assert.match(eventChunk, /"stage":"credential_setup"/u); assert.match(eventChunk, /"stage":"discovering"/u); assert.match(eventChunk, /"stage":"completed"/u);
  for (const event of eventChunk.matchAll(/^data: (.+)$/gmu)) assert.deepEqual(Object.keys(JSON.parse(event[1])).sort(), ["code", "connection_id", "model_count", "stage", "status"]);
  const rediscovered = await json(await fetch(`${server.url}/api/v1/connections/${created.body.data.connection.connection_id}/discover`, { method: "POST", headers: mutationHeaders }));
  assert.equal(rediscovered.status, 200); assert.equal(rediscovered.body.data.discovery.status, "connected");
  const refreshed = await json(await fetch(`${server.url}/api/v1/connections/${created.body.data.connection.connection_id}/models/refresh`, { method: "POST", headers: mutationHeaders }));
  assert.equal(refreshed.status, 200); assert.deepEqual(refreshed.body.data.catalog.models.map(({ id, name }) => [id, name]), [["image-1", "Image One"]]);
  const listed = await json(await fetch(`${server.url}/api/v1/connections`));
  const legacyPublic = listed.body.data.connections.find((connection) => connection.connection_id === legacy.connection_id);
  assert.equal(legacyPublic.legacy, true); assert.equal(JSON.stringify(listed.body).includes("endpoint_mappings"), false); assert.equal(JSON.stringify(listed.body).includes("settings"), false); assert.equal(JSON.stringify(listed.body).includes("credential_ref"), false); assert.equal(JSON.stringify(listed.body).includes("only-in-native-helper"), false);
});
