import test from "node:test";
import assert from "node:assert/strict";
import { createProviderDescriptor, validateAdapter, validateConnectionConfig } from "../src/providers/connector-contract.js";

const valid = { id: "lovart", display_name: "Lovart", kind: "adapter", capabilities: ["image", "video"], models: [{ id: "auto", capabilities: ["image", "video"] }], adapter_id: "lovart", credential_fields: [{ id: "api_key", label: "API key", secret: true, required: true }] };
const adapter = Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, () => ({})]));

test("normalizes and freezes a provider descriptor", () => {
  const descriptor = createProviderDescriptor(valid);
  assert.equal(descriptor.id, "lovart");
  assert.ok(Object.isFrozen(descriptor));
});
test("rejects invalid ids, duplicate models, capabilities and credential fields", () => {
  for (const [input, field] of [[{ ...valid, id: "Bad" }, "id"], [{ ...valid, models: ["x", "x"] }, "models.1.id"], [{ ...valid, capabilities: ["audio"] }, "capabilities"], [{ ...valid, capabilities: ["image"], models: [{ id: "x", capabilities: ["video"] }] }, "models.0.capabilities"], [{ ...valid, credential_fields: [{ id: "../secret", label: "x", secret: true, required: true }] }, "credential_fields.0.id"], [{ ...valid, credential_fields: [{ id: "key", label: "x", secret: true, required: true, extra: true }] }, "credential_fields.0"]]) {
    assert.throws(() => createProviderDescriptor(input), (error) => error.code === "VALIDATION_FAILED" && error.details.field === field);
  }
});
test("rejects incomplete adapters", () => assert.throws(() => validateAdapter({}), (error) => error.code === "VALIDATION_FAILED" && error.details.field.endsWith("validateConnection")));
test("enforces adapter request shape and returns recursively redacted results", async () => {
  const checked = validateAdapter(Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, (input) => ({ ok: true, seen: input.snapshot, api_key: "secret-value", nested: { token: "secret-value", text: "keep secret-value hidden" } })])));
  const input = { connection: {}, credential: { api_key: "secret-value" }, snapshot: { job_id: "j1" }, attachments: [], onProgress: () => {} };
  assert.deepEqual(await checked.submit(input), { ok: true, seen: input.snapshot, nested: { text: "keep [REDACTED] hidden" } });
  assert.throws(() => checked.poll({}), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "adapter.poll.input.connection");
  const asyncResult = validateAdapter(Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, async () => ({ nested: [{ password: "secret-value", value: "secret-value" }] })])));
  assert.deepEqual(await asyncResult.submit(input), { nested: [{ value: "[REDACTED]" }] });
  const primitive = validateAdapter(Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, () => "secret-value"]))).submit;
  assert.throws(() => primitive(input), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "adapter.submit.result");
});
test("normalizes secure connection config and rejects non-HTTPS", () => {
  const config = validateConnectionConfig({ provider_id: "lovart", base_url: "https://api.example.test/v1", label: "Demo" });
  assert.equal(config.base_url, "https://api.example.test/v1");
  assert.ok(Object.isFrozen(config));
  assert.throws(() => validateConnectionConfig({ provider_id: "lovart", base_url: "http://api.example.test" }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "base_url");
});
test("deep-freezes nested metadata and does not retain secret input fields", () => {
  const descriptor = createProviderDescriptor({ ...valid, secret: "do-not-return", models: [{ id: "x", capabilities: ["image"], secret: "nested-secret" }] });
  assert.ok(Object.isFrozen(descriptor.models[0]));
  assert.equal(Object.hasOwn(descriptor, "secret"), false);
  assert.equal(Object.hasOwn(descriptor.models[0], "secret"), false);
});
test("rejects inline adapters on generic REST descriptors", () => {
  assert.throws(
    () => createProviderDescriptor({ ...valid, id: "generic", display_name: "Generic", kind: "generic_rest", adapter_id: null, adapter }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "adapter",
  );
});
test("accepts catalog-driven discovered providers without static models or an execution adapter", () => {
  const descriptor = createProviderDescriptor({ id: "external-api", display_name: "外部 API", kind: "discovered", adapter_id: null, capabilities: ["image", "video"], models: [], credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }] });
  assert.equal(descriptor.kind, "discovered");
  assert.equal(descriptor.adapter_id, null);
  assert.deepEqual(descriptor.models, []);
});
