import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiCompatibleImagesAdapter } from "../src/providers/adapters/openai-compatible-images.js";

function response(status, json) {
  return { status, headers: new Headers(), json };
}

test("discovers OpenAI-compatible models with read-only GET requests", async () => {
  const calls = [];
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async (input) => {
    calls.push([input.method, input.url]);
    return response(200, { data: [{ id: "gpt-image-1" }, { id: "vendor-model", name: "Vendor Model" }] });
  } });

  const result = await adapter.discover({ base_url: "https://api.example.test/v1", credential: { api_key: "secret" } });

  assert.deepEqual(calls, [["GET", "https://api.example.test/v1/models"]]);
  assert.deepEqual(result.entries, [{ id: "gpt-image-1" }, { id: "vendor-model", name: "Vendor Model" }]);
  assert.equal(result.protocol, "openai-compatible");
  assert.equal(result.models_endpoint, "https://api.example.test/v1/models");
});

test("tries model candidates in order and stops at the first recognized response", async () => {
  const calls = [];
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async (input) => {
    calls.push(input);
    return input.url.endsWith("/v1/models")
      ? response(404, { error: "missing" })
      : response(200, { data: [{ id: "vendor model", name: "Vendor Model" }] });
  } });

  const result = await adapter.discover({ base_url: "https://api.example.test/platform", credential: { api_key: "secret" } });

  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["GET", "https://api.example.test/platform/v1/models"],
    ["GET", "https://api.example.test/platform/models"],
  ]);
  assert.equal(result.entries[0].id, "vendor model");
  assert.equal(result.entries[0].name, "Vendor Model");
});

test("rejects HTML and unknown JSON model responses", async () => {
  for (const value of [undefined, { object: "list", items: [] }]) {
    const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => response(200, value) });
    await assert.rejects(
      adapter.discover({ base_url: "https://api.example.test/v1", credential: { api_key: "secret" } }),
      (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED",
    );
  }
});

test("maps rejected model discovery responses to stable errors", async () => {
  for (const [status, code] of [[401, "AUTHENTICATION_FAILED"], [403, "AUTHENTICATION_FAILED"], [429, "UPSTREAM_RATE_LIMITED"], [500, "UPSTREAM_UNAVAILABLE"]]) {
    const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => response(status, { error: "not public" }) });
    await assert.rejects(
      adapter.discover({ base_url: "https://api.example.test/v1", credential: { api_key: "secret" } }),
      (error) => error.code === code,
    );
  }
});

test("classifies only known image IDs as confirmed and never claims video", () => {
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => response(200, { data: [] }) });
  assert.deepEqual(adapter.classifyModel({ id: "gpt-image-1" }), { capabilities: ["image"], compatibility: "confirmed" });
  assert.deepEqual(adapter.classifyModel({ id: "vendor-video-looking-model" }), { capabilities: ["image"], compatibility: "unconfirmed" });
  assert.deepEqual(adapter.estimateCost({}), { status: "unknown" });
});

test("submits the frozen raw model to the standard image endpoint", async () => {
  const seen = [];
  const progress = [];
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async (input) => {
    seen.push(input);
    return response(200, { data: [{ url: "https://cdn.example.test/1.png" }] });
  } });
  const result = await adapter.submit({
    connection: { base_url: "https://api.example.test/v1" },
    credential: { api_key: "secret" },
    snapshot: { model: "provider-image-v9", prompt: "paint a fox", settings: { count: 2, size: "1024x1024" } },
    attachments: [{ ignored: true }],
    onProgress: (event) => progress.push(event),
  });

  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "https://api.example.test/v1/images/generations");
  assert.equal(seen[0].headers.authorization, "Bearer secret");
  assert.deepEqual(seen[0].body, { model: "provider-image-v9", prompt: "paint a fox", n: 2, size: "1024x1024" });
  assert.deepEqual(progress, [{ stage: "submitted", progress: 5 }]);
  assert.deepEqual(result, { synchronous: true, status: "succeeded", result: { data: [{ url: "https://cdn.example.test/1.png" }] }, known_free: false });
});

test("omits automatic count and size values from the standard request", async () => {
  const seen = [];
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async (input) => {
    seen.push(input);
    return response(200, { data: [{ url: "https://cdn.example.test/auto.png" }] });
  } });
  await adapter.submit({
    connection: { base_url: "https://api.example.test/v1" },
    credential: { api_key: "secret" },
    snapshot: { model: "provider-image-v9", prompt: "paint a fox", settings: { count_mode: "auto", count: null, size: null } },
    attachments: [],
    onProgress() {},
  });
  assert.deepEqual(seen[0].body, { model: "provider-image-v9", prompt: "paint a fox" });
});

test("does not make a provider request while estimating generic image cost", async () => {
  let calls = 0;
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => { calls += 1; return response(500, {}); } });
  assert.deepEqual(await adapter.estimateCost({ snapshot: { model: "provider-image-v9" } }), { status: "unknown" });
  assert.equal(calls, 0);
});

test("imports URL and b64_json image results in provider order", async () => {
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => response(200, { data: [] }) });
  const imported = await adapter.importResults({ result: {
    data: [
      { url: "https://cdn.example.test/one.png", revised_prompt: "ignored" },
      { b64_json: "cGl4ZWw=", mime_type: "image/jpeg" },
    ],
  } });
  assert.deepEqual(imported.artifacts, [
    { kind: "image", source_url: "https://cdn.example.test/one.png", mime_type: "image/png", source_artifact_id: "image-1" },
    { kind: "image", base64: "cGl4ZWw=", mime_type: "image/jpeg", source_artifact_id: "image-2" },
  ]);
});

test("rejects empty, malformed, and unusable image results", async () => {
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => response(200, { data: [] }) });
  for (const result of [{}, { data: [] }, { data: [{}] }, { data: "not-an-array" }]) {
    await assert.rejects(adapter.importResults({ result }), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
  }
});

test("maps image submission failures to stable redacted errors", async () => {
  for (const [status, code] of [[401, "AUTHENTICATION_FAILED"], [403, "AUTHENTICATION_FAILED"], [429, "UPSTREAM_RATE_LIMITED"], [500, "UPSTREAM_UNAVAILABLE"]]) {
    const secret = "sk-image-secret";
    const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => response(status, { error: secret }) });
    await assert.rejects(
      adapter.submit({ connection: { base_url: "https://api.example.test/v1" }, credential: { api_key: secret }, snapshot: { model: "vendor-image", prompt: "fox" }, attachments: [], onProgress() {} }),
      (error) => error.code === code && !error.message.includes(secret) && !JSON.stringify(error.details).includes(secret),
    );
  }
});

test("returns synchronous results unchanged and does not claim cancellation support", async () => {
  const result = { data: [{ url: "https://cdn.example.test/one.png" }] };
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async () => response(200, result) });
  assert.deepEqual(await adapter.poll({ result }), result);
  assert.deepEqual(await adapter.cancel({ task_id: "unused" }), { cancelled: false, unsupported: true });
});
