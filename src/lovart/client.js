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

function sanitizeProviderMessage(value, secrets = []) {
  if (typeof value !== "string") return null;
  let sanitized = value;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  sanitized = sanitized
    .replace(/\b(?:ak|sk)_[a-z0-9_-]+\b/giu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 256);
  return sanitized || null;
}

function failure(code, {
  status = null,
  operation = null,
  providerCode = null,
  providerMessage = null,
  secrets = [],
} = {}) {
  const safeProviderMessage = sanitizeProviderMessage(providerMessage, secrets);
  const defaultMessage = FAILURE_MESSAGES[code] || FAILURE_MESSAGES.UPSTREAM_UNAVAILABLE;
  const message = code === "UPSTREAM_UNAVAILABLE" && safeProviderMessage
    ? `Lovart rejected the request: ${safeProviderMessage}`
    : defaultMessage;
  const error = new Error(message);
  error.code = code;
  if (status != null) error.status = status;
  if (operation) error.operation = operation;
  const details = {};
  if (operation) details.operation = operation;
  if (status != null) details.http_status = status;
  if (typeof providerCode === "string" || typeof providerCode === "number") details.provider_code = providerCode;
  if (safeProviderMessage) details.provider_message = safeProviderMessage;
  if (Object.keys(details).length) error.details = details;
  return error;
}

function statusCode(status) {
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 429) return "UPSTREAM_RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return "UPSTREAM_SCHEMA_UNRECOGNIZED";
}

function unwrap(payload, context = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", context);
  }
  if (Object.hasOwn(payload, "code") && payload.code !== 0) {
    throw failure("UPSTREAM_UNAVAILABLE", {
      ...context,
      providerCode: payload.code,
      providerMessage: payload.message,
    });
  }
  const data = Object.hasOwn(payload, "data") ? payload.data : payload;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", context);
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

  const secrets = [credentials.accessKey, credentials.secretKey];

  async function request(method, path, body, query = null, operation = "request") {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    let response;
    try {
      const headers = signedHeaders({ method, path, accessKey: credentials.accessKey, secretKey: credentials.secretKey, now });
      if (method === "POST") headers["Idempotency-Key"] = randomUUID().replaceAll("-", "");
      response = await fetchImpl(String(url), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
      });
    } catch {
      throw failure("UPSTREAM_UNREACHABLE", { operation });
    }
    if (!response || typeof response.status !== "number") throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", { operation });
    let text;
    try {
      text = await response.text();
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", { operation, status: response.status });
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", { operation, status: response.status });
    }
    const context = {
      operation,
      status: response.status,
      providerCode: payload?.code,
      providerMessage: payload?.message,
      secrets,
    };
    if (!response.ok) throw failure(statusCode(response.status), context);
    return unwrap(payload, context);
  }

  async function uploadRequest(filePath) {
    const boundary = `imvia-${randomUUID()}`;
    let fileData;
    try {
      fileData = await readFileImpl(filePath);
    } catch {
      throw failure("LOCAL_FILE_UNAVAILABLE", { operation: "upload" });
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
          "Idempotency-Key": randomUUID().replaceAll("-", ""),
        },
        body,
        redirect: "error",
      });
    } catch {
      throw failure("UPSTREAM_UNREACHABLE", { operation: "upload" });
    }
    if (!response || typeof response.status !== "number") throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", { operation: "upload" });
    let text;
    try {
      text = await response.text();
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", { operation: "upload", status: response.status });
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", { operation: "upload", status: response.status });
    }
    const context = {
      operation: "upload",
      status: response.status,
      providerCode: payload?.code,
      providerMessage: payload?.message,
      secrets,
    };
    if (!response.ok) throw failure(statusCode(response.status), context);
    return unwrap(payload, context);
  }

  return Object.freeze({
    queryMode: () => request("POST", `${API_PREFIX}/mode/query`, {}, null, "connect"),
    createProject: ({ project_name: projectName } = {}) => {
      const body = {
        project_id: "",
        canvas: "",
        project_cover_list: [],
        pic_count: 0,
        project_type: 3,
        ...(typeof projectName === "string" && projectName.trim() ? { project_name: projectName.trim() } : {}),
      };
      return request("POST", `${API_PREFIX}/project/save`, body, null, "project_create").then((data) => {
        if (typeof data.project_id !== "string" || !data.project_id.trim()) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED");
        return { project_id: data.project_id.trim(), ...(typeof data.project_name === "string" ? { project_name: data.project_name } : {}) };
      });
    },
    validateProject: ({ project_id: projectId }) => request("GET", `${API_PREFIX}/project/validate`, undefined, { project_id: projectId }, "project_validate").then((data) => {
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
      return request("POST", `${API_PREFIX}/chat`, body, null, "submit");
    },
    status: ({ thread_id: threadId }) => request("GET", `${API_PREFIX}/chat/status`, undefined, { thread_id: threadId }, "status"),
    result: ({ thread_id: threadId }) => request("GET", `${API_PREFIX}/chat/result`, undefined, { thread_id: threadId }, "result"),
    confirm: ({ thread_id: threadId }) => request("POST", `${API_PREFIX}/chat/confirm`, { thread_id: threadId }, null, "confirm"),
  });
}

export { FAILURE_MESSAGES as LOVART_FAILURE_MESSAGES };
