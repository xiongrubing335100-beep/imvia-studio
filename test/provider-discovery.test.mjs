import assert from "node:assert/strict";
import test from "node:test";

import { createAdapterRegistry } from "../src/providers/adapter-registry.js";
import { createProviderDiscoveryService } from "../src/providers/provider-discovery.js";

function adapter({ id = "fixture-images", version = "1", discover, classifyModel = () => ({ capabilities: ["image"], compatibility: "confirmed" }) } = {}) {
  return {
    id,
    version,
    discover: discover ?? (async () => ({ protocol: "fixture", provider_label: "Fixture", models_endpoint: "https://api.example.test/models", entries: [{ id: "fixture-model" }] })),
    classifyModel,
    estimateCost: () => ({ status: "unknown" }),
    validateConnection: async () => ({}),
    submit: async () => ({}),
    poll: async () => ({}),
    cancel: async () => ({}),
    importResults: async () => ({}),
  };
}

test("rejects duplicate trusted adapter IDs and requires an exact version lookup", () => {
  assert.throws(
    () => createAdapterRegistry({ adapters: [adapter(), adapter({ version: "2" })] }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "adapter.id",
  );

  const registry = createAdapterRegistry({ adapters: [adapter()] });
  assert.equal(registry.get("fixture-images", "1").version, "1");
  assert.throws(() => registry.get("fixture-images", "2"), (error) => error.code === "NOT_FOUND");
  assert.deepEqual(registry.list(), [{ id: "fixture-images", version: "1" }]);
  assert.ok(Object.isFrozen(registry.list()[0]));
});

test("discovery passes only address and credential to trusted adapters and returns a normalized catalog", async () => {
  let received;
  const registry = createAdapterRegistry({ adapters: [adapter({ discover: async (input) => {
    received = input;
    return {
      protocol: "fixture",
      provider_label: "Fixture",
      models_endpoint: "https://api.example.test/v1/models",
      entries: [{ id: "model-id", name: "Model Name", internal_token: "must-not-escape" }],
      raw_response: { credential: "must-not-escape" },
    };
  } })] });
  const service = createProviderDiscoveryService({ adapterRegistry: registry, now: () => "2026-08-25T00:00:00.000Z" });

  const result = await service.discover({ base_url: "https://api.example.test/v1", credential: { api_key: "secret" } });

  assert.deepEqual(received, { base_url: "https://api.example.test/v1", credential: { api_key: "secret" } });
  assert.deepEqual(result, {
    protocol: "fixture",
    adapter_id: "fixture-images",
    adapter_version: "1",
    provider_label: "Fixture",
    models_endpoint: "https://api.example.test/v1/models",
    catalog: {
      revision_input: '[{"capabilities":["image"],"compatibility":"confirmed","display_name":"Model Name","id":"model-id","raw_index":0,"source":"api"}]',
      discovered_at: "2026-08-25T00:00:00.000Z",
      digest: "0015ededff0ff45511c868550b623f33c1b715f1c2aaa20828b0598c2c3a4c41",
      models: [{ id: "model-id", display_name: "Model Name", capabilities: ["image"], compatibility: "confirmed", source: "api", raw_index: 0 }],
      counts: { total: 1, confirmed: 1, unconfirmed: 0, unsupported: 0 },
    },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("internal_token"), false);
});

test("continues only after an unrecognized adapter response and stops on authentication failures", async () => {
  let secondCalls = 0;
  const schema = Object.assign(new Error("unknown"), { code: "UPSTREAM_SCHEMA_UNRECOGNIZED" });
  const registry = createAdapterRegistry({ adapters: [
    adapter({ id: "first", discover: async () => { throw schema; } }),
    adapter({ id: "second", discover: async () => { secondCalls += 1; return { protocol: "second", provider_label: "Second", models_endpoint: "https://api.example.test/models", entries: [] }; } }),
  ] });
  const discovered = await registry.discover({ base_url: "https://api.example.test", credential: { api_key: "secret" } });
  assert.equal(discovered.adapter_id, "second");
  assert.equal(secondCalls, 1);

  const authentication = Object.assign(new Error("rejected"), { code: "AUTHENTICATION_FAILED" });
  const blocked = createAdapterRegistry({ adapters: [
    adapter({ id: "auth", discover: async () => { throw authentication; } }),
    adapter({ id: "never", discover: async () => { secondCalls += 1; return null; } }),
  ] });
  await assert.rejects(blocked.discover({ base_url: "https://api.example.test", credential: { api_key: "secret" } }), (error) => error.code === "AUTHENTICATION_FAILED");
  assert.equal(secondCalls, 1);
});
