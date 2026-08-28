import { DomainError } from "../../domain/errors.js";
import { modelDiscoveryCandidates } from "../provider-url.js";
import { safeProviderJsonRequest } from "../safe-provider-http.js";

export const KNOWN_IMAGE_IDS = new Set(["gpt-image-1", "dall-e-2", "dall-e-3"]);

function failure(status) {
  if (status === 401 || status === 403) return new DomainError("AUTHENTICATION_FAILED", "API Key 无效或没有读取模型的权限。");
  if (status === 429) return new DomainError("UPSTREAM_RATE_LIMITED", "API 请求过于频繁，请稍后重试。");
  if (status >= 500) return new DomainError("UPSTREAM_UNAVAILABLE", "外部 API 暂时不可用。");
  return new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "该 API 暂不支持自动识别。");
}

function sanitizedEntries(data) {
  if (!Array.isArray(data)) throw failure(200);
  return data.flatMap((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model) || typeof model.id !== "string") return [];
    const entry = { id: model.id };
    if (typeof model.name === "string") entry.name = model.name;
    return [entry];
  });
}

function headers(credential) {
  const apiKey = credential?.api_key;
  return Object.freeze({
    accept: "application/json",
    ...(typeof apiKey === "string" && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  });
}

function joinApiPath(baseUrl, path) {
  const base = String(baseUrl ?? "").replace(/\/+$/u, "");
  const suffix = String(path ?? "").replace(/^\/+/u, "");
  return `${base}/${suffix}`;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined && item !== null));
}

function schemaError(message = "The provider returned an unrecognized image response.") {
  return new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", message);
}

function postFailure(status) {
  return failure(status);
}

async function postImages({ request, url, apiKey, body }) {
  const input = {
    method: "POST",
    url,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(typeof apiKey === "string" && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    // The bundled safe request boundary writes JSON over HTTPS. Keeping the
    // object for injected requests makes the trusted request contract easy to
    // inspect in tests without exposing any additional caller-controlled data.
    body: request === safeProviderJsonRequest ? JSON.stringify(body) : body,
  };
  let response;
  try {
    response = await request(input);
  } catch (error) {
    if (error?.code === "UPSTREAM_SECURITY_REJECTED") throw new DomainError("UPSTREAM_SECURITY_REJECTED", "Provider request was rejected by the network safety policy.");
    if (error?.code === "UPSTREAM_TIMEOUT") throw new DomainError("UPSTREAM_TIMEOUT", "Provider request timed out.");
    throw new DomainError("UPSTREAM_UNAVAILABLE", "External API is temporarily unavailable.");
  }
  if (!response || typeof response.status !== "number") throw schemaError();
  if (response.status < 200 || response.status >= 300) throw postFailure(response.status);
  if (!response.json || typeof response.json !== "object" || Array.isArray(response.json)) throw schemaError();
  return response.json;
}

function normalizeImageArtifact(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw schemaError("The provider returned an invalid image item.");
  const sourceUrl = typeof item.url === "string" && item.url ? item.url : undefined;
  const base64 = typeof item.b64_json === "string" && item.b64_json ? item.b64_json : undefined;
  if (!sourceUrl && !base64) throw schemaError("The provider returned an image without URL or base64 data.");
  const mimeType = typeof item.mime_type === "string" && item.mime_type ? item.mime_type : "image/png";
  const sourceArtifactId = typeof item.id === "string" && item.id ? item.id : `image-${index + 1}`;
  return {
    kind: "image",
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(base64 ? { base64 } : {}),
    mime_type: mimeType,
    source_artifact_id: sourceArtifactId,
  };
}

export function createOpenAiCompatibleImagesAdapter({ request = safeProviderJsonRequest } = {}) {
  if (typeof request !== "function") throw new DomainError("VALIDATION_FAILED", "Provider request must be a function.", { field: "request" });
  const classifyModel = (model) => KNOWN_IMAGE_IDS.has(model?.id)
    ? { capabilities: ["image"], compatibility: "confirmed" }
    : { capabilities: ["image"], compatibility: "unconfirmed" };
  const discover = async ({ base_url, credential } = {}) => {
    const candidates = modelDiscoveryCandidates(base_url);
    for (const url of candidates) {
      const response = await request({ method: "GET", url, headers: headers(credential) });
      if (!response || typeof response.status !== "number") throw failure(200);
      if (response.status === 404) continue;
      if (response.status < 200 || response.status >= 300) throw failure(response.status);
      if (!response.json || typeof response.json !== "object" || Array.isArray(response.json)) throw failure(response.status);
      if (!Array.isArray(response.json.data)) throw failure(response.status);
      return Object.freeze({
        protocol: "openai-compatible",
        provider_label: "OpenAI-compatible",
        models_endpoint: url,
        entries: sanitizedEntries(response.json.data),
      });
    }
    throw new DomainError("NOT_FOUND", "No recognized models endpoint was found.");
  };
  return Object.freeze({
    id: "openai-images",
    version: "1",
    discover,
    classifyModel,
    estimateCost: () => Object.freeze({ status: "unknown" }),
    async validateConnection(input) {
      const result = await discover({ base_url: input?.connection?.base_url, credential: input?.credential });
      return Object.freeze({ accepted: true, protocol: result.protocol });
    },
    async submit({ connection, credential, snapshot, onProgress }) {
      onProgress?.({ stage: "submitted", progress: 5 });
      const result = await postImages({
        request,
        url: joinApiPath(connection?.base_url, "images/generations"),
        apiKey: credential?.api_key,
        body: compact({
          model: snapshot?.model,
          prompt: snapshot?.prompt,
          n: snapshot?.settings?.count,
          size: snapshot?.settings?.size,
        }),
      });
      return { synchronous: true, status: "succeeded", result, known_free: false };
    },
    async poll({ result }) {
      return result;
    },
    async cancel() {
      return { cancelled: false, unsupported: true };
    },
    async importResults({ result }) {
      if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.data)) throw schemaError();
      const artifacts = result.data.map((item, index) => normalizeImageArtifact(item, index));
      if (!artifacts.length) throw schemaError("The provider returned no images.");
      return { artifacts };
    },
  });
}
