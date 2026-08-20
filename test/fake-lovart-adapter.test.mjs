import assert from "node:assert/strict";
import test from "node:test";
import { createFakeLovartAdapter } from "./support/fake-lovart-adapter.mjs";

test("records exact ordered calls and returns scripted responses", async () => {
  const adapter = createFakeLovartAdapter({ name: "adapter-unit", script: [
    { tool: "lovart_upload", response: { upload_id: "up-1" } },
    { tool: "lovart_generate", response: { kind: "generation_started", thread_id: "thread-1" } },
  ] });
  assert.deepEqual(await adapter.lovart_upload({ reference_id: "ref-1" }), { upload_id: "up-1" });
  assert.deepEqual(await adapter.lovart_generate({ prompt: "exact prompt", uploads: ["up-1"] }), { kind: "generation_started", thread_id: "thread-1" });
  assert.deepEqual(adapter.ledger.map((entry) => entry.tool), ["lovart_upload", "lovart_generate"]);
  assert.equal(adapter.ledger[1].arguments.prompt, "exact prompt");
  adapter.assertComplete();
});

test("fails immediately on an unexpected tool and never falls back", async () => {
  const adapter = createFakeLovartAdapter({ name: "strict", script: [{ tool: "lovart_generate", response: { kind: "generation_started" } }] });
  await assert.rejects(() => adapter.lovart_confirm({ confirmation_id: "wrong" }), /Expected lovart_generate, received lovart_confirm/);
  assert.equal(adapter.ledger.length, 0);
});
