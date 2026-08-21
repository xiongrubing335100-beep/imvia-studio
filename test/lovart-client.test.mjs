import test from "node:test";
import assert from "node:assert/strict";

import { createLovartClient, LOVART_BASE_URL } from "../src/lovart/client.js";

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test("queryMode signs the fixed Lovart endpoint and sends an empty body", async () => {
  let request;
  const client = createLovartClient({
    credentials: { accessKey: "ak_test", secretKey: "sk_test" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { code: 0, data: { models: [] } });
    },
    now: () => 1_700_000_000_000,
  });

  assert.deepEqual(await client.queryMode(), { models: [] });
  assert.equal(request.url, `${LOVART_BASE_URL}/v1/openapi/mode/query`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.body, "{}");
  assert.equal(request.options.headers["X-Access-Key"], "ak_test");
  assert.equal(request.options.headers["X-Timestamp"], "1700000000");
  assert.equal(request.options.headers["X-Signed-Path"], "/v1/openapi/mode/query");
  assert.match(request.options.headers["X-Signature"], /^[0-9a-f]{64}$/);
});

test("send maps the workbench generation input to the official request shape", async () => {
  let request;
  const client = createLovartClient({
    credentials: { accessKey: "ak_test", secretKey: "sk_test" },
    fetchImpl: async (_url, options) => {
      request = options;
      return response(200, { code: 0, data: { thread_id: "thread-1" } });
    },
  });

  assert.deepEqual(await client.send({
    prompt: "A red apple",
    project_id: "project-1",
    thread_id: "thread-0",
    mode: "fast",
    prefer_models: { IMAGE: ["generate_image_midjourney"] },
    include_tools: ["generate_image_midjourney"],
  }), { thread_id: "thread-1" });
  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    prompt: "A red apple",
    project_id: "project-1",
    thread_id: "thread-0",
    mode: "fast",
    tool_config: {
      prefer_tool_categories: { IMAGE: ["generate_image_midjourney"] },
      include_tools: ["generate_image_midjourney"],
    },
  });
});

test("HTTP authentication failures are stable and never include secrets", async () => {
  const client = createLovartClient({
    credentials: { accessKey: "ak_private", secretKey: "sk_private" },
    fetchImpl: async () => response(401, { message: "invalid ak_private sk_private" }),
  });

  await assert.rejects(client.queryMode(), (error) => {
    assert.equal(error.code, "AUTHENTICATION_FAILED");
    assert.equal(error.message, "Lovart authentication was rejected");
    assert.equal(error.message.includes("ak_private"), false);
    assert.equal(error.message.includes("sk_private"), false);
    return true;
  });
});

test("invalid JSON maps to a redacted upstream schema error", async () => {
  const client = createLovartClient({
    credentials: { accessKey: "ak_test", secretKey: "sk_test" },
    fetchImpl: async () => ({ status: 200, ok: true, async text() { return "not-json"; } }),
  });

  await assert.rejects(client.queryMode(), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
});
