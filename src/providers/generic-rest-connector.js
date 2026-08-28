import { DomainError } from "../domain/errors.js";
import { renderRequestTemplate, requestTemplateUsesSnapshotToken } from "./request-template.js";
import { readResponsePath } from "./response-path.js";

const SUCCESS_STATES = new Set(["succeeded", "success", "completed", "complete", "done"]);
const FAILURE_STATES = new Set(["failed", "failure", "cancelled", "canceled", "error"]);
const CONNECTOR_FAILURE = Symbol("connector_failure");

function failure(code, operation, status) {
  const error = new DomainError(code, code.replaceAll("_", " ").toLowerCase(), {
    operation,
    ...(status === undefined ? {} : { http_status: status }),
  });
  Object.defineProperty(error, CONNECTOR_FAILURE, { value: true });
  return error;
}

function fail(message, field) { throw new DomainError("VALIDATION_FAILED", message, { field }); }

function operations(connection) {
  const mappings = connection?.endpoint_mappings ?? connection?.operations;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) fail("Connection endpoint mappings are required.", "endpoint_mappings");
  return mappings;
}

function getOperation(connection, name, required = true) {
  const operation = operations(connection)[name];
  if ((!operation || typeof operation !== "object" || Array.isArray(operation)) && required) fail(`Connection ${name} operation is required.`, `endpoint_mappings.${name}`);
  return operation;
}

function setting(connection, name, fallback) {
  const value = connection?.settings?.[name];
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function approvedCredential(connection, credential) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) fail("Credential values must be an object.", "credential");
  const fields = connection?.provider_descriptor?.credential_fields;
  if (!Array.isArray(fields)) {
    if (Object.keys(credential).length) fail("Connection credential field declarations are required.", "connection.provider_descriptor.credential_fields");
    return {};
  }
  const allowed = new Set(fields.map((field) => field?.id).filter((id) => typeof id === "string"));
  const output = {};
  for (const [id, value] of Object.entries(credential)) {
    if (!allowed.has(id)) fail("Credential field is not declared for this connection.", `credential.${id}`);
    output[id] = value;
  }
  return output;
}

function pathFor(operation, name) {
  return operation?.[name] ?? operation?.response?.[name];
}

function providerError(status) {
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 429) return "UPSTREAM_RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return "VALIDATION_FAILED";
}

async function bodyPayload(response, operation, readBody) {
  if (response.status === 204 || response.status === 205) return undefined;
  let text;
  try { text = await readBody(() => response.text()); }
  catch (error) {
    if (error?.[CONNECTOR_FAILURE]) throw error;
    throw failure("UPSTREAM_UNAVAILABLE", operation, response.status);
  }
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", operation, response.status); }
}

function templateFor(connection, operation) {
  const request = operation.request && typeof operation.request === "object" ? operation.request : operation;
  return {
    ...request,
    base_url: connection?.base_url,
    allow_private_network: connection?.allow_private_network === true,
  };
}

function declaredSubmitMetadata(operation) {
  // A value is eligible for injection only when the data-only endpoint
  // template actually names it.  This keeps router metadata out of provider
  // requests unless the saved connection explicitly opted in.
  return {
    idempotency_key: requestTemplateUsesSnapshotToken(operation, "idempotency_key"),
    snapshot_digest: requestTemplateUsesSnapshotToken(operation, "snapshot_digest"),
  };
}

function snapshotWithDeclaredSubmitMetadata(snapshot, input, operation) {
  const output = { ...(snapshot ?? {}) };
  const declared = declaredSubmitMetadata(operation);
  if (declared.idempotency_key && typeof input.idempotency_key === "string" && input.idempotency_key) {
    output.idempotency_key = input.idempotency_key;
  }
  if (declared.snapshot_digest && typeof input.snapshot_digest === "string" && input.snapshot_digest) {
    output.snapshot_digest = input.snapshot_digest;
  }
  return output;
}

function outputValue(value, operation, key) {
  const path = pathFor(operation, key);
  return path === undefined ? undefined : readResponsePath(value, path);
}

function idFrom(value, operation) {
  const id = outputValue(value, operation, "task_id_path") ?? outputValue(value, operation, "id_path");
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  return String(id);
}

function safeKind(value, fallback = "image") {
  return value === "video" || value === "audio" || value === "file" || value === "image" ? value : fallback;
}

function normalizeArtifact(item, index) {
  const raw = typeof item === "string" ? { url: item } : item;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", "result");
  const sourceUrl = typeof raw.source_url === "string" ? raw.source_url : typeof raw.url === "string" ? raw.url : undefined;
  const base64 = typeof raw.base64 === "string" ? raw.base64 : typeof raw.data_base64 === "string" ? raw.data_base64 : undefined;
  const mimeType = typeof raw.mime_type === "string" ? raw.mime_type : typeof raw.mime === "string" ? raw.mime : null;
  if (!sourceUrl && !base64 && raw.file === undefined && raw.local_path === undefined) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", "result");
  const kind = safeKind(raw.kind, mimeType?.startsWith("video/") ? "video" : mimeType?.startsWith("audio/") ? "audio" : "image");
  return {
    kind,
    mime_type: mimeType,
    source_url: sourceUrl ?? (base64 ? `data:${mimeType ?? "application/octet-stream"};base64,${base64}` : null),
    source_artifact_id: typeof raw.source_artifact_id === "string" ? raw.source_artifact_id : typeof raw.artifact_id === "string" ? raw.artifact_id : typeof raw.id === "string" ? raw.id : `artifact-${index + 1}`,
    metadata: raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata) ? raw.metadata : {},
    ...(base64 ? { data_base64: base64 } : {}),
    ...(raw.file !== undefined ? { file: raw.file } : {}),
    ...(raw.local_path !== undefined ? { local_path: raw.local_path } : {}),
  };
}

function artifactsFrom(result) {
  const list = Array.isArray(result) ? result : result?.artifacts ?? result?.outputs ?? result?.results ?? [result];
  if (!Array.isArray(list) || !list.length) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", "result");
  return list.map(normalizeArtifact);
}

export function createGenericRestConnector({ fetchImpl = globalThis.fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable");
  if (typeof sleep !== "function" || typeof now !== "function") throw new TypeError("sleep and now are required functions");

  async function request({ connection, operation, name, credential, snapshot, attachments, timeoutMs }) {
    const rendered = renderRequestTemplate({ template: templateFor(connection, operation), credential: approvedCredential(connection, credential ?? {}), snapshot, attachments });
    const controller = new AbortController();
    const requestTimeout = Math.max(0, Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, setting(connection, "request_timeout_ms", 30_000)));
    let timeoutId;
    const expired = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(failure("UPSTREAM_UNAVAILABLE", name));
      }, requestTimeout);
    });
    try {
      const beforeDeadline = (work) => Promise.race([Promise.resolve().then(work), expired]);
      const response = await beforeDeadline(() => fetchImpl(rendered.url, { method: rendered.method, headers: rendered.headers, ...(rendered.body === undefined ? {} : { body: rendered.body }), redirect: "error", signal: controller.signal }));
      if (!response || typeof response.status !== "number" || typeof response.text !== "function") throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", name);
      if (!response.ok) throw failure(providerError(response.status), name, response.status);
      return await bodyPayload(response, name, beforeDeadline);
    } catch (error) {
      if (error?.[CONNECTOR_FAILURE]) throw error;
      throw failure("UPSTREAM_UNAVAILABLE", name);
    }
    finally { clearTimeout(timeoutId); }
  }

  async function validateConnection(input) {
    const operation = getOperation(input.connection, "validate");
    const definition = operation.request && typeof operation.request === "object" ? operation.request : operation;
    const method = typeof definition.method === "string" ? definition.method.toUpperCase() : "GET";
    if (method !== "GET" && method !== "HEAD") fail("Connection validation must use GET or HEAD.", `endpoint_mappings.validate${operation.request ? ".request" : ""}.method`);
    const payload = await request({ ...input, operation, name: "validate" });
    const accepted = outputValue(payload, operation, "ok_path");
    if (accepted === false) throw failure("AUTHENTICATION_FAILED", "validate");
    if (accepted !== undefined && typeof accepted !== "boolean") throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", "validate");
    return { accepted: accepted ?? true, code: "CONNECTED" };
  }

  async function submit(input) {
    const upload = getOperation(input.connection, "upload", false);
    const uploadedSnapshot = { ...(input.snapshot ?? {}) };
    if (upload && Array.isArray(input.attachments) && input.attachments.length) {
      for (const attachment of input.attachments) {
        input.onProgress?.({ stage: "uploading" });
        const payload = await request({ ...input, snapshot: uploadedSnapshot, attachments: [attachment], operation: upload, name: "upload" });
        const value = outputValue(payload, upload, "result_path") ?? outputValue(payload, upload, "upload_id_path");
        if (value === undefined || (typeof value !== "string" && typeof value !== "number")) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", "upload");
        if (typeof attachment.handle === "string" && attachment.handle) uploadedSnapshot[attachment.handle] = value;
      }
    }
    const operation = getOperation(input.connection, "submit");
    const payload = await request({ ...input, snapshot: snapshotWithDeclaredSubmitMetadata(uploadedSnapshot, input, operation), operation, name: "submit" });
    input.onProgress?.({ stage: "submitted" });
    const taskId = idFrom(payload, operation);
    const knownFree = outputValue(payload, operation, "known_free_path");
    if (knownFree !== undefined && typeof knownFree !== "boolean") throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", "submit");
    const costMetadata = knownFree === true ? { known_free: true } : {};
    if (taskId) return { task_id: taskId, status: "submitted", ...costMetadata };
    const result = outputValue(payload, operation, "result_path");
    if (result === undefined) throw failure("UPSTREAM_SCHEMA_UNRECOGNIZED", "submit");
    return { status: "succeeded", result, ...costMetadata };
  }

  async function poll(input) {
    if (typeof input.task_id !== "string" || !input.task_id) fail("task_id is required.", "task_id");
    const operation = getOperation(input.connection, "status");
    const timeout = setting(input.connection, "timeout_ms", 120_000);
    const started = now();
    let wait = Math.max(1, setting(input.connection, "poll_interval_ms", 1_000));
    while (true) {
      const beforeRequest = timeout - (now() - started);
      if (beforeRequest <= 0) throw failure("UPSTREAM_UNAVAILABLE", "status");
      const snapshot = { ...(input.snapshot ?? {}), task_id: input.task_id };
      const payload = await request({ ...input, snapshot, operation, name: "status", timeoutMs: beforeRequest });
      const state = outputValue(payload, operation, "status_path");
      const progress = outputValue(payload, operation, "progress_path");
      const result = outputValue(payload, operation, "result_path");
      input.onProgress?.({ stage: "generating", ...(typeof progress === "number" && Number.isFinite(progress) && progress >= 0 && progress <= 100 ? { progress } : {}) });
      const normalized = typeof state === "string" ? state.toLowerCase() : result === undefined ? "generating" : "succeeded";
      if (SUCCESS_STATES.has(normalized)) return { task_id: input.task_id, status: "succeeded", ...(result === undefined ? {} : { result }) };
      if (FAILURE_STATES.has(normalized)) throw failure(normalized.startsWith("cancel") ? "VALIDATION_FAILED" : "UPSTREAM_UNAVAILABLE", "status");
      const remaining = timeout - (now() - started);
      if (remaining <= 0) throw failure("UPSTREAM_UNAVAILABLE", "status");
      await sleep(Math.min(wait, remaining));
      wait = Math.min(wait * 2, 10_000);
    }
  }

  async function cancel(input) {
    if (typeof input.task_id !== "string" || !input.task_id) fail("task_id is required.", "task_id");
    const operation = getOperation(input.connection, "cancel", false);
    if (!operation) return { task_id: input.task_id, cancelled: false };
    await request({ ...input, snapshot: { ...(input.snapshot ?? {}), task_id: input.task_id }, operation, name: "cancel" });
    return { task_id: input.task_id, cancelled: true };
  }

  async function importResults(input) {
    let result = input.result;
    if (result === undefined) {
      const operation = getOperation(input.connection, "result", false);
      if (!operation || typeof input.task_id !== "string") fail("Result data is required.", "result");
      const payload = await request({ ...input, snapshot: { ...(input.snapshot ?? {}), task_id: input.task_id }, operation, name: "result" });
      result = outputValue(payload, operation, "result_path") ?? payload;
    }
    return { artifacts: artifactsFrom(result) };
  }

  return Object.freeze({ validateConnection, submit, poll, cancel, importResults });
}
