import test from "node:test";
import assert from "node:assert/strict";
import { createProviderRegistry } from "../src/providers/provider-registry.js";

const adapter = Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, () => ({})]));
const lovart = { id: "lovart", display_name: "Lovart", kind: "adapter", capabilities: ["image", "video"], models: [{ id: "image-model", capabilities: ["image"] }, { id: "video-model", capabilities: ["video"] }], adapter_id: "lovart", credential_fields: [] };
test("registers and filters providers", () => {
  const registry = createProviderRegistry({ builtIns: [{ ...lovart, adapter }], adapters: [{ id: "rest", adapter }] });
  registry.register({ id: "generic", display_name: "Generic", kind: "generic_rest", capabilities: ["image"], models: ["image-model"], credential_fields: [] });
  assert.equal(registry.get("lovart").display_name, "Lovart");
  assert.equal(registry.modelsFor("lovart", { mode: "video" })[0].id, "video-model");
  assert.equal(registry.list().length, 2);
  assert.equal(typeof registry.resolve("lovart").adapter.submit, "function");
  assert.throws(() => registry.get("missing"), (error) => error.code === "NOT_FOUND");
  assert.throws(() => registry.register(lovart), (error) => error.code === "VALIDATION_FAILED");
  const generic = { id: "inline", display_name: "Inline", kind: "generic_rest", capabilities: ["image"], models: [], credential_fields: [] };
  assert.throws(() => registry.register({ ...generic, adapter }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "adapter");
  assert.throws(() => registry.register({ descriptor: generic, adapter }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "adapter");
  assert.throws(() => registry.register({ descriptor: { ...generic, adapter } }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "adapter");
});
