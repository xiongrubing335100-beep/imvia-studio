import { createHmac } from "node:crypto";
import { readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const LOVART_BASE_URL = "https://lgw.lovart.ai";
const API_PREFIX = "/v1/openapi";

const FAILURE_MESSAGES = Object.freeze({
  AUTHENTICATION_FAILED: "Lovart authentication was rejected",
  UPSTREAM_RATE_LIMITED: "Lovart upstream rate limit was reached",
  UPSTREAM_UNAVAILABLE: "Lovart upstream is unavailable",
  UPSTREAM_UNREACHABLE: "Lovart upstream is unreachable",
  UPSTREAM_SCHEMA_UNRECOGNIZED: "Lovart upstream response was not recognized",
  UPSTREAM_SECURITY_REJECTED: "Lovart upstream security check failed",
  INVALID_LOVART_PROJECT: "The Lovart project is not available",
  LOCAL_FILE_UNAVAILABLE: "The local reference file is unavailable",
});

function failure(code, status = null) {
  const error = new Error(FAILURE_MESSAGES[code] || FAILURE_MESSAGES.UPSTREAM_UNAVAILABLE);
  error.code = code;
  if (status != null) error.status = status;
  return error;
}

function statusCode(status) {
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 429) return "UPSTREAM_RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return "UPSTREAM_SCHEMA_UNRECOGNIZED";
}

function unwrap(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
  }
  if (Object.hasOwn(payload, "code") && payload.code !== 0) {
    throw failure("UPSTREAM_UNAVAILABLE");
  }
  const data = Object.hasOwn(payload, "data") ? payload.data : payload;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
  }
  return data;
}

function signedHeaders({ method, path, accessKey, secretKey, now }) {
  const timestamp = String(Math.floor(now() / 1000));
  const signature = createHmac("sha256", secretKey)
    .update(`${method}\n${path}\n${timestamp}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Access-Key": accessKey,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
    "X-Signed-Method": method,
    "X-Signed-Path": path,
    "User-Agent": "IMVIA-Studio/0.3.0 LovartAdapter/1.0",
  };
}

export function createLovartClient({
  credentials,
  fetchImpl = globalThis.fetch,
  baseUrl = LOVART_BASE_URL,
  now = () => Date.now(),
  readFileImpl = defaultReadFile,
} = {}) {
  if (!credentials || typeof credentials.accessKey !== "string" || typeof credentials.secretKey !== "string") {
    throw new TypeError("Lovart credentials are required");
  }
  if (baseUrl !== LOVART_BASE_URL) throw new TypeError("Lovart base URL is fixed");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable");

  async function request(method, path, body, query = null) {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    let response;
    try {
      response = await fetchImpl(String(url), {
        method,
        headers: signedHeaders({ method, path, accessKey: credentials.accessKey, secretKey: credentials.secretKey, now }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
      });
    } catch {
      throw failure("UPSTREAM_UNREACHABLE");
    }
    if (!response || typeof response.status !== "number") throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
    let text;
    try {
      text = await response.text();
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", response.status);
    }
    if (!response.ok) throw failure(statusCode(response.status), response.status);
    return unwrap(payload);
  }

  async function uploadRequest(filePath) {
    const boundary = `imvia-${randomUUID()}`;
    let fileData;
    try {
      fileData = await readFileImpl(filePath);
    } catch {
      throw failure("LOCAL_FILE_UNAVAILABLE");
    }
    const filename = path.basename(filePath);
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename.replace(/[^a-z0-9._-]/giu, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([prefix, Buffer.from(fileData), suffix]);
    const requestPath = `${API_PREFIX}/file/upload`;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          ...signedHeaders({ method: "POST", path: requestPath, accessKey: credentials.accessKey, secretKey: credentials.secretKey, now }),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        redirect: "error",
      });
    } catch {
      throw failure("UPSTREAM_UNREACHABLE");
    }
    if (!response || typeof response.status !== "number") throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
    let text;
    try {
      text = await response.text();
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", response.status);
    }
    if (!response.ok) throw failure(statusCode(response.status), response.status);
    return unwrap(payload);
  }

  return Object.freeze({
    queryMode: () => request("POST", `${API_PREFIX}/mode/query`, {}),
    createProject: ({ project_name: projectName } = {}) => {
      const body = {
        project_id: "",
        canvas: "",
        project_cover_list: [],
        pic_count: 0,
        project_type: 3,
        ...(typeof projectName === "string" && projectName.trim() ? { project_name: projectName.trim() } : {}),
      };
      return request("POST", `${API_PREFIX}/project/save`, body).then((data) => {
        if (typeof data.project_id !== "string" || !data.project_id.trim()) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
        return { project_id: data.project_id.trim(), ...(typeof data.project_name === "string" ? { project_name: data.project_name } : {}) };
      });
    },
    validateProject: ({ project_id: projectId }) => request("GET", `${API_PREFIX}/project/validate`, undefined, { project_id: projectId }).then((data) => {
      if (data.valid !== true) throw failure("INVALID_LOVART_PROJECT");
      return { valid: true, ...(typeof data.project_name === "string" ? { project_name: data.project_name } : {}) };
    }),
    upload: ({ file_path: filePath }) => uploadRequest(filePath).then((data) => {
      if (typeof data.url !== "string" || !data.url.startsWith("https://")) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
      return { url: data.url };
    }),
    send: (input) => {
      const body = {
        prompt: input.prompt,
        project_id: input.project_id || "",
        ...(input.thread_id ? { thread_id: input.thread_id } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      };
      const toolConfig = {};
      if (input.prefer_models) toolConfig.prefer_tool_categories = input.prefer_models;
      if (input.include_tools?.length) toolConfig.include_tools = input.include_tools;
      if (Object.keys(toolConfig).length) body.tool_config = toolConfig;
      return request("POST", `${API_PREFIX}/chat`, body);
    },
    status: ({ thread_id: threadId }) => request("GET", `${API_PREFIX}/chat/status`, undefined, { thread_id: threadId }),
    result: ({ thread_id: threadId }) => request("GET", `${API_PREFIX}/chat/result`, undefined, { thread_id: threadId }),
    confirm: ({ thread_id: threadId }) => request("POST", `${API_PREFIX}/chat/confirm`, { thread_id: threadId }),
  });
}

export { FAILURE_MESSAGES as LOVART_FAILURE_MESSAGES };
