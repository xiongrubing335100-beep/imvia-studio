import assert from "node:assert/strict";
import test from "node:test";
import { assertSingleProvider, resolveGenerationProvider } from "../src/domain/lovart-routing-policy.js";

test("routes only explicit or evidenced continuation context to Lovart", () => {
  assert.equal(resolveGenerationProvider({ activation: { source: "codex_explicit" } }), "lovart");
  assert.equal(resolveGenerationProvider({ activation: { source: "workbench_action" } }), "lovart");
  assert.equal(resolveGenerationProvider({ activation: { source: "codex_context_continuation", parent_job_id: "job-1" } }), "lovart");
  assert.equal(resolveGenerationProvider({ activation: { source: "codex_context_continuation", artifact_id: "artifact-1" } }), "lovart");
  assert.equal(resolveGenerationProvider({}), "codex_imagegen");
  assert.equal(resolveGenerationProvider({ activation: { source: "other" } }), "codex_imagegen");
});

test("rejects continuation without lineage and invalid multi-provider selection", () => {
  assert.throws(() => resolveGenerationProvider({ activation: { source: "codex_context_continuation" } }), (error) => error.code === "INVALID_CONTINUATION_PARENT");
  assert.equal(assertSingleProvider("lovart"), "lovart");
  assert.equal(assertSingleProvider("codex_imagegen"), "codex_imagegen");
  assert.throws(() => assertSingleProvider("both"), (error) => error.code === "PROVIDER_SELECTION_INVALID");
});
