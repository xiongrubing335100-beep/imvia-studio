import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import https from "node:https";
import { normalizeProviderBaseUrl, modelDiscoveryCandidates } from "../src/providers/provider-url.js";
import { requestPinnedHttps, safeProviderJsonRequest } from "../src/providers/safe-provider-http.js";

test("normalizes a domain and builds bounded OpenAI model candidates", () => {
  assert.equal(normalizeProviderBaseUrl("api.example.test/v1/"), "https://api.example.test/v1");
  assert.deepEqual(modelDiscoveryCandidates("https://api.example.test/v1"), ["https://api.example.test/v1/models"]);
  assert.deepEqual(modelDiscoveryCandidates("https://api.example.test"), ["https://api.example.test/v1/models", "https://api.example.test/models"]);
});

test("rejects credentials, query, fragment, and non-HTTPS URLs", () => {
  for (const value of ["http://api.example.test", "https://user:pass@api.example.test", "https://api.example.test?a=1", "https://api.example.test/#x"]) {
    assert.throws(() => normalizeProviderBaseUrl(value), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "base_url");
  }
});

test("rejects every private DNS answer before transport", async () => {
  let calls = 0;
  await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/v1/models", lookup: async () => [{ address: "203.0.113.10", family: 4 }, { address: "127.0.0.1", family: 4 }], transport: async () => { calls += 1; } }), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
  assert.equal(calls, 0);
});

test("rejects cross-origin redirects and oversized JSON bodies", async () => {
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/models", lookup, transport: async () => ({ status: 302, headers: { location: "https://other.example.test/models" }, text: async () => "" }) }), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
  await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/models", lookup, maximum_bytes: 3, transport: async () => ({ status: 200, headers: {}, text: async () => "{}{}" }) }), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
});

test("hard-caps caller limits and includes DNS resolution in the timeout", async () => {
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  let calls = 0;
  await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/models", lookup, maximum_redirects: 99, transport: async () => { calls += 1; return { status: 302, headers: { location: "/models" }, text: async () => "" }; } }), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
  assert.equal(calls, 3);
  await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/models", lookup, maximum_bytes: 2_000_000, transport: async () => ({ status: 200, headers: {}, text: async () => "x".repeat(1_000_001) }) }), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
  await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/models", timeout_ms: 10, lookup: async () => new Promise(() => {}) }), (error) => error.code === "UPSTREAM_TIMEOUT");
});

test("consumes Node IncomingMessage-shaped streams and follows same-origin redirects", async () => {
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  const responses = [
    Object.assign(Readable.from(["redirect body"]), { statusCode: 302, headers: { location: "/v1/models" } }),
    Object.assign(Readable.from([JSON.stringify({ data: [{ id: "model-1" }] })]), { statusCode: 200, headers: { "content-type": "application/json" } }),
  ];
  const result = await safeProviderJsonRequest({ url: "https://api.example.test/models", lookup, transport: async () => responses.shift() });
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/json");
  assert.deepEqual(result.json, { data: [{ id: "model-1" }] });
});

test("destroys a slow Node response stream when the overall timeout expires", async () => {
  const lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  let stream;
  const transport = async () => {
    stream = Readable.from((async function* () { await new Promise((resolve) => setTimeout(resolve, 100)); yield "{}"; })());
    return Object.assign(stream, { statusCode: 200, headers: {} });
  };
  await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/models", lookup, timeout_ms: 10, transport }), (error) => error.code === "UPSTREAM_TIMEOUT");
  assert.equal(stream.destroyed, true);
});

test("cleans ClientRequest listeners after response headers arrive", async () => {
  const originalRequest = https.request;
  class FakeRequest extends EventEmitter {
    write() {}
    end() { queueMicrotask(() => this.emit("response", Object.assign(Readable.from(["{}"]), { statusCode: 200, headers: {} }))); }
    destroy() { this.destroyed = true; }
  }
  let request;
  https.request = (url, options, callback) => {
    request = new FakeRequest();
    request.on("response", callback);
    return request;
  };
  try {
    await requestPinnedHttps(new URL("https://api.example.test/models"), { lookup: async () => [] });
    assert.equal(request.listenerCount("error"), 1);
    assert.equal(request.listenerCount("timeout"), 0);
    assert.equal(request.listenerCount("close"), 1);
    assert.doesNotThrow(() => request.emit("error", new Error("late response error")));
    assert.equal(request.listenerCount("error"), 0);
    assert.equal(request.listenerCount("close"), 0);
  } finally {
    https.request = originalRequest;
  }
});

test("cleans listeners when a nonstandard request invokes response synchronously", async () => {
  const originalRequest = https.request;
  class SyncRequest extends EventEmitter {
    write() {}
    end() {}
    destroy() { this.destroyed = true; }
  }
  let request;
  https.request = (url, options, callback) => {
    request = new SyncRequest();
    callback(Object.assign(Readable.from(["{}"]), { statusCode: 200, headers: {} }));
    return request;
  };
  try {
    const response = await requestPinnedHttps(new URL("https://api.example.test/models"), {});
    assert.equal(response.statusCode, 200);
    assert.equal(request.listenerCount("error"), 1);
    assert.equal(request.listenerCount("timeout"), 0);
    assert.equal(request.listenerCount("close"), 1);
    assert.doesNotThrow(() => request.emit("error", new Error("late synchronous response error")));
    assert.equal(request.listenerCount("error"), 0);
    assert.equal(request.listenerCount("close"), 0);
  } finally {
    https.request = originalRequest;
  }
});

test("cleans listeners when timeout destroys a request without emitting events", async () => {
  const originalRequest = https.request;
  class SilentRequest extends EventEmitter {
    write() {}
    end() {}
    destroy() { this.destroyed = true; }
  }
  let request;
  https.request = () => { request = new SilentRequest(); return request; };
  try {
    await assert.rejects(safeProviderJsonRequest({ url: "https://api.example.test/models", timeout_ms: 10, lookup: async () => [{ address: "203.0.113.10", family: 4 }] }), (error) => error.code === "UPSTREAM_TIMEOUT");
    assert.equal(request.destroyed, true);
    assert.equal(request.listenerCount("error"), 1);
    assert.equal(request.listenerCount("timeout"), 0);
    assert.equal(request.listenerCount("close"), 1);
    assert.doesNotThrow(() => request.emit("error", new Error("late destroy error")));
    assert.equal(request.listenerCount("error"), 0);
    assert.equal(request.listenerCount("close"), 0);
  } finally {
    https.request = originalRequest;
  }
});
