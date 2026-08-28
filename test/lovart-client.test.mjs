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
  assert.match(request.headers["Idempotency-Key"], /^[0-9a-f]{32}$/u);
});

test("provider business rejections preserve a sanitized submit-stage reason", async () => {
  const client = createLovartClient({
    credentials: { accessKey: "ak_private", secretKey: "sk_private" },
    fetchImpl: async () => response(200, {
      code: 2601,
      message: "unknown model I2Image 2 for ak_private and sk_private",
      data: null,
    }),
  });

  await assert.rejects(
    () => client.send({ prompt: "A portrait", project_id: "project-1" }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_UNAVAILABLE");
      assert.equal(error.operation, "submit");
      assert.equal(error.details.provider_code, 2601);
      assert.equal(error.details.operation, "submit");
      assert.equal(error.details.provider_message, "unknown model I2Image 2 for [REDACTED] and [REDACTED]");
      assert.match(error.message, /unknown model I2Image 2/u);
      assert.equal(error.message.includes("ak_private"), false);
      assert.equal(error.message.includes("sk_private"), false);
      return true;
    },
  );
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

test("createProject uses the official empty-project save contract", async () => {
  let request;
  const client = createLovartClient({
    credentials: { accessKey: "ak_test", secretKey: "sk_test" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { code: 0, data: { project_id: "project-new", project_name: "新项目" } });
    },
  });

  assert.deepEqual(await client.createProject({ project_name: "新项目" }), { project_id: "project-new", project_name: "新项目" });
  assert.equal(request.url, `${LOVART_BASE_URL}/v1/openapi/project/save`);
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    project_id: "",
    canvas: "",
    project_cover_list: [],
    pic_count: 0,
    project_type: 3,
    project_name: "新项目",
  });
  assert.equal(Object.hasOwn(request.options.headers, "X-Secret-Key"), false);
});

test("validateProject sends the exact project id and rejects an invalid project", async () => {
  let request;
  const client = createLovartClient({
    credentials: { accessKey: "ak_test", secretKey: "sk_test" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { code: 0, data: { valid: false, project_name: "" } });
    },
  });

  await assert.rejects(client.validateProject({ project_id: "project-missing" }), (error) => error.code === "INVALID_LOVART_PROJECT");
  assert.equal(request.url, `${LOVART_BASE_URL}/v1/openapi/project/validate?project_id=project-missing`);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.body, undefined);
});

test("upload sends a signed multipart request without putting keys in the body", async () => {
  let request;
  const client = createLovartClient({
    credentials: { accessKey: "ak_test", secretKey: "sk_private" },
    readFileImpl: async () => Buffer.from("file-bytes"),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { code: 0, data: { url: "https://cdn.lovart.ai/file-1" } });
    },
  });

  assert.deepEqual(await client.upload({ file_path: "/tmp/reference.png" }), { url: "https://cdn.lovart.ai/file-1" });
  assert.equal(request.url, `${LOVART_BASE_URL}/v1/openapi/file/upload`);
  assert.equal(request.options.method, "POST");
  assert.match(request.options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  const body = Buffer.from(request.options.body).toString("utf8");
  assert.match(body, /filename="reference\.png"/);
  assert.match(body, /file-bytes/);
  assert.equal(body.includes("sk_private"), false);
});
