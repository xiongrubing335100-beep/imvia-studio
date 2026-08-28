import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultProviderRegistry } from "../src/providers/default-providers.js";

test("production defaults preserve Lovart and legacy REST while offering a catalog-driven external API", () => {
  const registry = createDefaultProviderRegistry();
  assert.deepEqual(registry.list().map((provider) => provider.id), ["lovart", "external-api", "custom-rest"]);
  const external = registry.get("external-api");
  assert.equal(external.kind, "discovered");
  assert.equal(external.adapter_id, null);
  assert.deepEqual(external.models, []);
  assert.deepEqual(external.capabilities, ["image", "video"]);
  assert.deepEqual(external.credential_fields, [{ id: "api_key", label: "API Key", secret: true, required: true }]);
  const generic = registry.get("custom-rest");
  assert.equal(generic.kind, "generic_rest");
  assert.deepEqual(generic.capabilities, ["image", "video"]);
  assert.deepEqual(generic.models.map((model) => model.id), ["Auto"]);
  assert.deepEqual(generic.credential_fields, [{ id: "api_key", label: "API Key", secret: true, required: true }]);
});
