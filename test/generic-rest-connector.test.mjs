import test from "node:test";
import assert from "node:assert/strict";

import { renderRequestTemplate, requestTemplateUsesSnapshotToken } from "../src/providers/request-template.js";
import { readResponsePath } from "../src/providers/response-path.js";
import { createGenericRestConnector } from "../src/providers/generic-rest-connector.js";
import { DomainError } from "../src/domain/errors.js";

const secret = "never-log-this-secret";

test("renders only declared scalar data into an HTTPS JSON request", () => {
  const rendered = renderRequestTemplate({
    template: {
      base_url: "https://api.example.test/v1",
      path: "/images/{{snapshot.model_id}}",
      method: "POST",
      headers: { Authorization: "Bearer {{credential.api_key}}", "X-Mode": "{{snapshot.mode}}" },
      body: { prompt: "{{snapshot.prompt}}", count: "{{snapshot.count}}" },
    },
    snapshot: { model_id: "image-1", mode: "image", prompt: "red fox", count: 2, hidden: { nested: true } },
    credential: { api_key: secret, unused: "must-not-leak" },
    attachments: [],
  });
  assert.equal(rendered.url, "https://api.example.test/images/image-1");
  assert.equal(rendered.method, "POST");
  assert.equal(rendered.headers.Authorization, `Bearer ${secret}`);
  assert.equal(rendered.headers["Content-Type"], "application/json");
  assert.equal(rendered.body, JSON.stringify({ prompt: "red fox", count: 2 }));
});

test("rejects insecure and private endpoints unless a connection explicitly permits them", () => {
  const request = { template: { base_url: "http://api.example.test", path: "/test" }, snapshot: {}, credential: {}, attachments: [] };
  assert.throws(() => renderRequestTemplate(request), (error) => error.code === "VALIDATION_FAILED" && !error.message.includes(secret));
  assert.throws(() => renderRequestTemplate({ ...request, template: { base_url: "https://127.0.0.1", path: "/test" } }), (error) => error.code === "VALIDATION_FAILED");
  assert.equal(renderRequestTemplate({ ...request, template: { base_url: "https://127.0.0.1", path: "/test", allow_private_network: true } }).url, "https://127.0.0.1/test");
});

test("rejects undeclared, non-scalar, and whole-object template tokens without exposing credentials", () => {
  const request = { template: { base_url: "https://api.example.test", headers: { Authorization: `Bearer ${secret}` }, path: "/{{snapshot.hidden}}" }, snapshot: { hidden: { bad: true } }, credential: { api_key: secret }, attachments: [] };
  assert.throws(() => renderRequestTemplate(request), (error) => error.code === "VALIDATION_FAILED" && !error.message.includes(secret));
  assert.throws(() => renderRequestTemplate({ ...request, template: { base_url: "https://api.example.test", path: "/{{credential}}" } }), (error) => error.code === "VALIDATION_FAILED");
  assert.throws(() => renderRequestTemplate({ ...request, template: { base_url: "https://api.example.test", path: "/{{credential.unknown}}" } }), (error) => error.code === "VALIDATION_FAILED");
});

test("renders managed attachments as multipart fields without serializing their local path", () => {
  const attachment = new Blob(["pixel"], { type: "image/png" });
  const rendered = renderRequestTemplate({
    template: { base_url: "https://api.example.test", path: "/upload", method: "POST", multipart: { fields: { prompt: "{{snapshot.prompt}}" }, files: { image: "{{attachment.input}}" } } },
    snapshot: { prompt: "fox" }, credential: {}, attachments: [{ id: "input", handle: "artifact-input", file: attachment, filename: "fox.png", local_path: "/private/not-for-provider.png" }],
  });
  assert.ok(rendered.body instanceof FormData);
  assert.equal(rendered.body.get("prompt"), "fox");
  assert.equal(rendered.body.get("image").name, "fox.png");
});

test("reads dotted response paths including array indexes and returns undefined for absent paths", () => {
  const response = { data: { tasks: [{ id: "first" }, { id: "second", outputs: ["https://cdn.example.test/x.png"] }] } };
  assert.equal(readResponsePath(response, "data.tasks[1].outputs[0]"), "https://cdn.example.test/x.png");
  assert.equal(readResponsePath(response, "data.tasks[2].id"), undefined);
});

function response(status, payload) {
  return { status, ok: status >= 200 && status < 300, async text() { return typeof payload === "string" ? payload : JSON.stringify(payload); } };
}

function connection(mappings, settings = {}) {
  return { base_url: "https://api.example.test/v1", endpoint_mappings: mappings, settings, provider_descriptor: { credential_fields: [{ id: "api_key", label: "API key", secret: true, required: true }] } };
}

test("validates through its declared read-only endpoint without submitting a job", async () => {
  const seen = [];
  const connector = createGenericRestConnector({ fetchImpl: async (url, init) => { seen.push({ url, method: init.method }); return response(200, { data: { ok: true } }); } });
  const result = await connector.validateConnection({ connection: connection({ validate: { method: "GET", path: "/health", ok_path: "data.ok" } }), credential: { api_key: secret }, snapshot: {}, attachments: [], onProgress() {} });
  assert.deepEqual(result, { accepted: true, code: "CONNECTED" });
  assert.deepEqual(seen, [{ url: "https://api.example.test/health", method: "GET" }]);
});

test("returns synchronous results and preserves every artifact when importing", async () => {
  const connector = createGenericRestConnector({ fetchImpl: async () => response(200, { data: { artifacts: [
    { id: "image-1", url: "https://cdn.example.test/one.png", mime_type: "image/png", kind: "image" },
    { id: "image-2", url: "https://cdn.example.test/two.png", mime_type: "image/png", kind: "image" },
  ] } }) });
  const submitted = await connector.submit({ connection: connection({ submit: { method: "POST", path: "/generate", body: { prompt: "{{snapshot.prompt}}" }, result_path: "data.artifacts" } }), credential: {}, snapshot: { prompt: "two foxes" }, attachments: [], onProgress() {} });
  assert.equal(submitted.status, "succeeded");
  const imported = await connector.importResults({ connection: {}, credential: {}, snapshot: {}, attachments: [], onProgress() {}, result: submitted.result });
  assert.deepEqual(imported.artifacts.map(({ kind, mime_type, source_url, source_artifact_id }) => ({ kind, mime_type, source_url, source_artifact_id })), [
    { kind: "image", mime_type: "image/png", source_url: "https://cdn.example.test/one.png", source_artifact_id: "image-1" },
    { kind: "image", mime_type: "image/png", source_url: "https://cdn.example.test/two.png", source_artifact_id: "image-2" },
  ]);
});

test("places only explicitly templated idempotency metadata on the provider submit request", async () => {
  const seen = [];
  const connector = createGenericRestConnector({ fetchImpl: async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return response(200, { data: { artifacts: [{ id: "wire-result", url: "https://cdn.example.test/wire.png" }] } });
  } });
  const profile = connection({
    submit: {
      method: "POST", path: "/generate",
      headers: { "Idempotency-Key": "{{snapshot.idempotency_key}}" },
      body: { prompt: "{{snapshot.prompt}}", request_digest: "{{snapshot.snapshot_digest}}" },
      result_path: "data.artifacts",
    },
  });
  await connector.submit({ connection: profile, credential: {}, snapshot: { prompt: "fox" }, attachments: [], idempotency_key: "same-retry-key", snapshot_digest: "frozen-digest", onProgress() {} });
  assert.equal(seen[0].headers["Idempotency-Key"], "same-retry-key");
  assert.deepEqual(JSON.parse(seen[0].body), { prompt: "fox", request_digest: "frozen-digest" });

  const noTemplate = connection({ submit: { method: "POST", path: "/generate", body: { prompt: "{{snapshot.prompt}}" }, result_path: "data.artifacts" } });
  await connector.submit({ connection: noTemplate, credential: {}, snapshot: { prompt: "fox" }, attachments: [], idempotency_key: "must-not-be-rendered", snapshot_digest: "must-not-be-rendered", onProgress() {} });
  assert.equal(seen[1].headers["Idempotency-Key"], undefined);
  assert.equal(seen[1].body.includes("must-not-be-rendered"), false);
});

test("does not treat response mappings as an idempotency request declaration", async () => {
  const seen = [];
  const connector = createGenericRestConnector({ fetchImpl: async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return response(200, { task: { id: "response-only-task" } });
  } });
  await connector.submit({
    connection: connection({
      submit: {
        method: "POST", path: "/generate", body: { prompt: "{{snapshot.prompt}}" },
        task_id_path: "task.id", result_path: "{{snapshot.idempotency_key}}",
      },
    }),
    credential: {}, snapshot: { prompt: "fox" }, attachments: [], idempotency_key: "response-only-key", snapshot_digest: "response-only-digest", onProgress() {},
  });
  assert.equal(JSON.stringify(seen[0]).includes("response-only-key"), false);
  assert.equal(JSON.stringify(seen[0]).includes("response-only-digest"), false);
});

test("does not treat an idempotency token-shaped JSON object key as a request declaration", async () => {
  const seen = [];
  const connector = createGenericRestConnector({ fetchImpl: async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    return response(200, { task: { id: "key-only-task" } });
  } });
  await connector.submit({
    connection: connection({ submit: { method: "POST", path: "/generate", body: { "{{snapshot.idempotency_key}}": "constant" }, task_id_path: "task.id" } }),
    credential: {}, snapshot: {}, attachments: [], idempotency_key: "key-must-not-inject", snapshot_digest: "digest-must-not-inject", onProgress() {},
  });
  assert.equal(JSON.stringify(seen[0]).includes("key-must-not-inject"), false);
  assert.equal(JSON.stringify(seen[0]).includes("digest-must-not-inject"), false);
  assert.deepEqual(JSON.parse(seen[0].body), { "{{snapshot.idempotency_key}}": "constant" });
});

test("matches multipart idempotency declaration rules to the renderer", () => {
  assert.equal(requestTemplateUsesSnapshotToken({
    multipart: { files: { upload: "{{snapshot.idempotency_key}}" } },
  }, "idempotency_key"), false);
  assert.equal(requestTemplateUsesSnapshotToken({
    multipart: { fields: { nested: { value: "{{snapshot.idempotency_key}}" } } },
  }, "idempotency_key"), false);
  assert.equal(requestTemplateUsesSnapshotToken({
    multipart: { fields: { idempotency_key: "{{snapshot.idempotency_key}}" } },
  }, "idempotency_key"), true);
});

test("uploads before submitting and polls an asynchronous task through completion", async () => {
  const seen = [];
  let clock = 0;
  const connector = createGenericRestConnector({
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async (url, init) => {
      seen.push(`${init.method} ${url}`);
      if (url.endsWith("/upload")) return response(200, { file: { id: "upload-1" } });
      if (url.endsWith("/generate")) return response(200, { task: { id: "task-1" } });
      return response(200, { state: "succeeded", progress: 100, outputs: [{ id: "output-1", url: "https://cdn.example.test/out.png" }] });
    },
  });
  const profile = connection({
    upload: { method: "POST", path: "/upload", multipart: { files: { file: "{{attachment.source}}" } }, result_path: "file.id" },
    submit: { method: "POST", path: "/generate", body: { file_id: "{{snapshot.upload_source}}" }, task_id_path: "task.id" },
    status: { method: "GET", path: "/tasks/{{snapshot.task_id}}", status_path: "state", progress_path: "progress", result_path: "outputs" },
  }, { poll_interval_ms: 1, timeout_ms: 100 });
  const progress = [];
  const submitted = await connector.submit({ connection: profile, credential: {}, snapshot: {}, attachments: [{ id: "source", handle: "upload_source", file: new Blob(["input"]), filename: "input.png" }], onProgress: (event) => progress.push(event.stage) });
  const polled = await connector.poll({ connection: profile, credential: {}, snapshot: {}, attachments: [], task_id: submitted.task_id, onProgress: (event) => progress.push(event.stage) });
  assert.deepEqual(seen, ["POST https://api.example.test/upload", "POST https://api.example.test/generate", "GET https://api.example.test/tasks/task-1"]);
  assert.equal(polled.status, "succeeded");
  assert.ok(progress.includes("uploading") && progress.includes("submitted") && progress.includes("generating"));
});

test("maps provider rate limits and malformed successful responses to stable errors without secrets", async () => {
  const rateLimited = createGenericRestConnector({ fetchImpl: async () => response(429, { error: `bad ${secret}` }) });
  const request = { connection: connection({ submit: { method: "POST", path: "/generate" } }), credential: { api_key: secret }, snapshot: {}, attachments: [], onProgress() {} };
  await assert.rejects(rateLimited.submit(request), (error) => error.code === "UPSTREAM_RATE_LIMITED" && !error.message.includes(secret));
  const malformed = createGenericRestConnector({ fetchImpl: async () => response(200, "not-json") });
  await assert.rejects(malformed.submit(request), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
});

test("uses the configured cancellation endpoint for an asynchronous task", async () => {
  const seen = [];
  const connector = createGenericRestConnector({ fetchImpl: async (url, init) => { seen.push(`${init.method} ${url}`); return response(204, ""); } });
  const result = await connector.cancel({ connection: connection({ cancel: { method: "DELETE", path: "/tasks/{{snapshot.task_id}}" } }), credential: {}, snapshot: {}, attachments: [], task_id: "task-9", onProgress() {} });
  assert.deepEqual(result, { task_id: "task-9", cancelled: true });
  assert.deepEqual(seen, ["DELETE https://api.example.test/tasks/task-9"]);
});

test("rejects write validation mappings before any provider request", async () => {
  let calls = 0;
  const connector = createGenericRestConnector({ fetchImpl: async () => { calls += 1; return response(200, { ok: true }); } });
  await assert.rejects(
    connector.validateConnection({ connection: connection({ validate: { method: "POST", path: "/generate" } }), credential: {}, snapshot: {}, attachments: [], onProgress() {} }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "endpoint_mappings.validate.method",
  );
  assert.equal(calls, 0);
});

test("rejects attachment tokens in JSON requests without serializing local paths", () => {
  const localPath = "/private/managed-input.png";
  assert.throws(() => renderRequestTemplate({
    template: { base_url: "https://api.example.test", path: "/generate", method: "POST", body: { input: "{{attachment.source}}" } },
    snapshot: {}, credential: {}, attachments: [{ id: "source", file: new Blob(["image"]), local_path: localPath }],
  }), (error) => error.code === "VALIDATION_FAILED" && !error.message.includes(localPath));
});

test("rejects IPv4-mapped, link-local, and unique-local IPv6 endpoints unless explicitly allowed", () => {
  for (const host of ["[::ffff:127.0.0.1]", "[fe90::1]", "[fd12:3456::1]"]) {
    assert.throws(() => renderRequestTemplate({ template: { base_url: `https://${host}`, path: "/health" }, snapshot: {}, credential: {}, attachments: [] }), (error) => error.code === "VALIDATION_FAILED");
    const rendered = renderRequestTemplate({ template: { base_url: `https://${host}`, path: "/health", allow_private_network: true }, snapshot: {}, credential: {}, attachments: [] });
    assert.equal(new URL(rendered.url).hostname, new URL(`https://${host}`).hostname);
  }
});

test("rejects credentials absent from the descriptor allowlist before rendering a provider request", async () => {
  let calls = 0;
  const connector = createGenericRestConnector({ fetchImpl: async () => { calls += 1; return response(200, { data: { artifacts: [] } }); } });
  await assert.rejects(
    connector.submit({
      connection: { ...connection({ submit: { method: "POST", path: "/generate", headers: { Authorization: "Bearer {{credential.unlisted}}" }, result_path: "data.artifacts" } }), provider_descriptor: { credential_fields: [{ id: "api_key", label: "API key", secret: true, required: true }] } },
      credential: { api_key: secret, unlisted: "must-not-be-usable" }, snapshot: {}, attachments: [], onProgress() {},
    }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "credential.unlisted",
  );
  assert.equal(calls, 0);
});

test("publishes only fixed stages and finite percentage progress", async () => {
  const progress = [];
  const connector = createGenericRestConnector({ fetchImpl: async () => response(200, { state: "succeeded", progress: 37, outputs: [{ url: "https://cdn.example.test/result.png" }] }) });
  const result = await connector.poll({
    connection: connection({ status: { method: "GET", path: "/tasks/{{snapshot.task_id}}", status_path: "state", progress_path: "progress", result_path: "outputs" } }),
    credential: { api_key: secret }, snapshot: {}, attachments: [], task_id: "task-1", onProgress: (event) => progress.push(event),
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(progress, [{ stage: "generating", progress: 37 }]);
  assert.equal(JSON.stringify(progress).includes(secret), false);
});

test("maps 5xx and 400 provider replies to stable public errors", async () => {
  const request = { connection: connection({ submit: { method: "POST", path: "/generate" } }), credential: {}, snapshot: {}, attachments: [], onProgress() {} };
  await assert.rejects(createGenericRestConnector({ fetchImpl: async () => response(503, { error: "offline" }) }).submit(request), (error) => error.code === "UPSTREAM_UNAVAILABLE");
  await assert.rejects(createGenericRestConnector({ fetchImpl: async () => response(400, { error: "bad input" }) }).submit(request), (error) => error.code === "VALIDATION_FAILED");
});

test("maps a declared failed provider state without publishing its raw state", async () => {
  const progress = [];
  const connector = createGenericRestConnector({ fetchImpl: async () => response(200, { state: "failed", progress: "secret-state-detail" }) });
  await assert.rejects(
    connector.poll({ connection: connection({ status: { method: "GET", path: "/tasks/{{snapshot.task_id}}", status_path: "state", progress_path: "progress" } }), credential: {}, snapshot: {}, attachments: [], task_id: "task-1", onProgress: (event) => progress.push(event) }),
    (error) => error.code === "UPSTREAM_UNAVAILABLE",
  );
  assert.deepEqual(progress, [{ stage: "generating" }]);
});

test("bounds each poll wait to the remaining timeout and does not issue a second request", async () => {
  let clock = 0;
  let calls = 0;
  const waits = [];
  const connector = createGenericRestConnector({
    now: () => clock,
    sleep: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
    fetchImpl: async () => { calls += 1; return response(200, { state: "running" }); },
  });
  await assert.rejects(
    connector.poll({ connection: connection({ status: { method: "GET", path: "/tasks/{{snapshot.task_id}}", status_path: "state" } }, { poll_interval_ms: 10, timeout_ms: 5 }), credential: {}, snapshot: {}, attachments: [], task_id: "task-1", onProgress() {} }),
    (error) => error.code === "UPSTREAM_UNAVAILABLE",
  );
  assert.deepEqual(waits, [5]);
  assert.equal(calls, 1);
});

test("gives each provider fetch an abort signal", async () => {
  let signal;
  const connector = createGenericRestConnector({ fetchImpl: async (_url, init) => { signal = init.signal; return response(200, { data: { ok: true } }); } });
  await connector.validateConnection({ connection: connection({ validate: { method: "GET", path: "/health", ok_path: "data.ok" } }, { request_timeout_ms: 25 }), credential: {}, snapshot: {}, attachments: [], onProgress() {} });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("imports result-endpoint Base64 and managed-file results without dropping either artifact", async () => {
  const managedFile = { handle: "managed-file" };
  const connector = createGenericRestConnector({ fetchImpl: async () => response(200, { data: { results: [
    { id: "inline-1", base64: "cGl4ZWw=", mime: "image/png" },
    { id: "file-1", file: managedFile, mime_type: "video/mp4", kind: "video" },
  ] } }) });
  const imported = await connector.importResults({
    connection: connection({ result: { method: "GET", path: "/tasks/{{snapshot.task_id}}/result", result_path: "data.results" } }), credential: {}, snapshot: {}, attachments: [], task_id: "task-1", onProgress() {},
  });
  assert.deepEqual(imported.artifacts.map(({ kind, source_artifact_id, source_url, file }) => ({ kind, source_artifact_id, source_url, file })), [
    { kind: "image", source_artifact_id: "inline-1", source_url: "data:image/png;base64,cGl4ZWw=", file: undefined },
    { kind: "video", source_artifact_id: "file-1", source_url: null, file: managedFile },
  ]);
});

test("rejects malformed token delimiters rather than forwarding them as literal request data", () => {
  assert.throws(() => renderRequestTemplate({
    template: { base_url: "https://api.example.test", path: "/generate", method: "POST", body: { prompt: "{{snapshot.prompt" } },
    snapshot: { prompt: "fox" }, credential: {}, attachments: [],
  }), (error) => error.code === "VALIDATION_FAILED" && error.details.field === "body.prompt");
});

test("maps rejected response body reads to a stable redacted upstream error", async () => {
  const bodySecret = "sk-body-read-secret";
  const connector = createGenericRestConnector({ fetchImpl: async () => ({ status: 200, ok: true, async text() { throw new Error(`body failed: ${bodySecret}`); } }) });
  await assert.rejects(
    connector.validateConnection({ connection: connection({ validate: { method: "GET", path: "/health", ok_path: "data.ok" } }), credential: {}, snapshot: {}, attachments: [], onProgress() {} }),
    (error) => error.code === "UPSTREAM_UNAVAILABLE" && !error.message.includes(bodySecret) && !JSON.stringify(error.details).includes(bodySecret),
  );
});

test("propagates provider-sourced known-free metadata from a declared response path", async () => {
  const connector = createGenericRestConnector({ fetchImpl: async () => response(200, { data: { task_id: "task-1", known_free: true } }) });
  const submitted = await connector.submit({
    connection: connection({ submit: { method: "POST", path: "/generate", task_id_path: "data.task_id", known_free_path: "data.known_free" } }),
    credential: {},
    snapshot: { prompt: "fixture" },
    attachments: [],
    onProgress() {},
  });
  assert.deepEqual(submitted, { task_id: "task-1", status: "submitted", known_free: true });
});

test("bounds a hanging successful response body read to the request deadline", async () => {
  const connector = createGenericRestConnector({ fetchImpl: async () => ({ status: 200, ok: true, text: async () => new Promise(() => {}) }) });
  const result = await Promise.race([
    connector.validateConnection({ connection: connection({ validate: { method: "GET", path: "/health", ok_path: "data.ok" } }, { request_timeout_ms: 5 }), credential: {}, snapshot: {}, attachments: [], onProgress() {} }).then(
      () => ({ code: "UNEXPECTED_SUCCESS" }),
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve({ code: "OUTER_TIMEOUT" }), 40)),
  ]);
  assert.equal(result.code, "UPSTREAM_UNAVAILABLE");
});

test("returns undefined for malformed response paths rather than tokenizing them permissively", () => {
  const payload = { data: { secret: true, rows: [{ id: "first" }] } };
  for (const path of ["data[", "data]", "data..secret", "data[foo]", "data.[0]", "data.rows[0", "data.rows[0]]"]) {
    assert.equal(readResponsePath(payload, path), undefined);
  }
  assert.equal(readResponsePath(payload, "data.rows[0].id"), "first");
});

test("redacts DomainErrors thrown by response body readers instead of trusting their code or details", async () => {
  const bodySecret = "sk-untrusted-domain-error";
  const untrusted = new DomainError("AUTHENTICATION_FAILED", `provider body contains ${bodySecret}`, { provider_token: bodySecret, nested: { secret: bodySecret } });
  const connector = createGenericRestConnector({ fetchImpl: async () => ({ status: 200, ok: true, async text() { throw untrusted; } }) });
  await assert.rejects(
    connector.validateConnection({ connection: connection({ validate: { method: "GET", path: "/health", ok_path: "data.ok" } }), credential: {}, snapshot: {}, attachments: [], onProgress() {} }),
    (error) => error.code === "UPSTREAM_UNAVAILABLE"
      && error.message === "upstream unavailable"
      && JSON.stringify(error.details) === JSON.stringify({ operation: "validate", http_status: 200 })
      && !error.message.includes(bodySecret)
      && !JSON.stringify(error.details).includes(bodySecret),
  );
});
