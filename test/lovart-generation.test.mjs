import test from "node:test";
import assert from "node:assert/strict";

import { createGenerationService } from "../src/lovart/generation-service.js";

function credentialService() {
  return {
    async connect({ validate }) { return { status: "connected", checked_at: "2026-08-21T00:00:00.000Z", ...(await validate({ accessKey: "ak_test", secretKey: "sk_test" })).accepted ? {} : { status: "setup_required" } }; },
    async status() { return { status: "connected", checked_at: "2026-08-21T00:00:00.000Z" }; },
    async getCredentials() { return { accessKey: "ak_test", secretKey: "sk_test" }; },
  };
}

test("connect checks Lovart mode after the native credential flow", async () => {
  let queried = 0;
  const service = createGenerationService({
    credentialService: credentialService(),
    clientFactory: () => ({
      async queryMode() { queried += 1; return { models: [] }; },
    }),
  });

  assert.deepEqual(await service.connect(), {
    status: "connected",
    checked_at: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(queried, 1);
});

test("generate sends once, polls, and returns completed Lovart results", async () => {
  const calls = [];
  const client = {
    async send(input) { calls.push(["send", input]); return { thread_id: "thread-1", project_id: "project-1" }; },
    async status() { calls.push(["status"]); return { status: calls.length > 2 ? "done" : "running" }; },
    async result() { calls.push(["result"]); return { items: [{ artifacts: [{ type: "image", content: "https://cdn/image.png" }] }] }; },
  };
  const service = createGenerationService({ credentialService: credentialService(), clientFactory: () => client, sleep: async () => {} });

  const result = await service.generate({ prompt: "A red apple" });
  assert.equal(result.final_status, "done");
  assert.equal(result.thread_id, "thread-1");
  assert.equal(result.items[0].artifacts[0].type, "image");
  assert.equal(calls.filter(([name]) => name === "send").length, 1);
});

test("pending cost is returned without automatic confirmation", async () => {
  let confirmed = false;
  const client = {
    async send() { return { thread_id: "thread-cost", project_id: "project-1" }; },
    async status() { return { status: "done" }; },
    async result() { return { pending_confirmation: { amount: 12, unit: "credits" }, items: [] }; },
    async confirm() { confirmed = true; },
  };
  const service = createGenerationService({ credentialService: credentialService(), clientFactory: () => client, sleep: async () => {} });

  const result = await service.generate({ prompt: "A premium video" });
  assert.equal(result.final_status, "pending_confirmation");
  assert.deepEqual(result.pending_confirmation, { amount: 12, unit: "credits" });
  assert.equal(confirmed, false);
});

test("confirm is a separate explicit operation and returns the final result", async () => {
  const calls = [];
  const client = {
    async confirm(threadId) { calls.push(["confirm", threadId]); return { thread_id: threadId }; },
    async status() { calls.push(["status"]); return { status: "done" }; },
    async result() { calls.push(["result"]); return { items: [{ artifacts: [] }] }; },
  };
  const service = createGenerationService({ credentialService: credentialService(), clientFactory: () => client, sleep: async () => {} });

  const result = await service.confirm({ thread_id: "thread-cost" });
  assert.equal(result.final_status, "done");
  assert.deepEqual(calls, [["confirm", { thread_id: "thread-cost" }], ["status"], ["result"]]);
});
