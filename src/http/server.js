import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbenchService, DomainError } from "../domain/workbench-service.js";

const DEFAULT_WORKBENCH_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../workbench/dist");
const WORKBENCH_MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
});

function body(request) {
  return new Promise((resolve, reject) => {
    let value = "";
    request.on("data", (chunk) => { value += chunk; if (value.length > 1_000_000) reject(new Error("Request body is too large.")); });
    request.on("end", () => { try { resolve(value ? JSON.parse(value) : {}); } catch { reject(new DomainError("VALIDATION_FAILED", "Request body must be valid JSON.")); } });
    request.on("error", reject);
  });
}
function binaryBody(request, maximumBytes = 50_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new DomainError("VALIDATION_FAILED", "Uploaded workbench media is too large.", { maximum_bytes: maximumBytes }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const WORKBENCH_UPLOAD_EXTENSIONS = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
});
function send(response, status, payload) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(payload)); }
function envelope(data) { return { api_version: "1", ok: true, data }; }
const CREDENTIAL_TEMPLATE = /\{\{credential\.[a-z][a-z0-9._-]{0,63}\}\}/u;
const CREDENTIAL_TEMPLATES = /\{\{credential\.[a-z][a-z0-9._-]{0,63}\}\}/gu;
function safeCredentialTemplate(value) {
  if (typeof value !== "string" || !CREDENTIAL_TEMPLATE.test(value)) return false;
  const remainder = value.replace(CREDENTIAL_TEMPLATES, "");
  return !remainder.includes("{{") && !remainder.includes("}}");
}
function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:credential(?:[-_]?values)?|secret(?:[-_]?key)?|access[-_]?key|api[-_]?key|authorization|bearer|token|password|private[-_]?key)/i.test(key)) {
      if (safeCredentialTemplate(item)) safe[key] = item;
      continue;
    }
    safe[key] = redactSensitive(item);
  }
  return safe;
}
const ACTIONABLE_ERROR_MESSAGES = Object.freeze({
  VALIDATION_FAILED: "请求参数不符合要求，请检查 API 地址和连接信息后重试。",
  NOT_FOUND: "未找到指定的 API 连接，请刷新后重试。",
  CONTEXT_UNAVAILABLE: "API 连接服务暂不可用，请稍后重试。",
  AUTHENTICATION_FAILED: "API Key 无效或没有读取模型的权限，请重新配置。",
  UPSTREAM_UNREACHABLE: "无法连接到外部 API，请检查地址和网络后重试。",
  UPSTREAM_SECURITY_REJECTED: "外部 API 地址不符合安全策略，请使用可公开访问的 HTTPS 地址。",
  UPSTREAM_RATE_LIMITED: "外部 API 请求过于频繁，请稍后重试。",
  UPSTREAM_UNAVAILABLE: "外部 API 暂时不可用，请稍后重试。",
  UPSTREAM_SCHEMA_UNRECOGNIZED: "该 API 暂不支持自动识别，请确认其兼容的模型接口。",
});
function errorPayload(error) { const known = error instanceof DomainError; return { api_version: "1", ok: false, error: { code: known ? error.code : "STORE_UNAVAILABLE", message: known ? (ACTIONABLE_ERROR_MESSAGES[error.code] ?? error.message) : "本地工作台服务暂不可用。", retryable: known && ["REVISION_CONFLICT", "STATUS_CONFLICT"].includes(error.code), details: known ? redactSensitive(error.details) : {} } }; }
function redactedConnection(value) {
  const connected = value?.status === "connected" || value?.state === "connected";
  const code = typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : null;
  if (value?.state) return { state: connected ? "connected" : value.state, ...(code ? { code } : {}), ...(value.checked_at ? { checked_at: value.checked_at } : {}) };
  return { status: connected ? "connected" : "not_connected", ...(code ? { code } : {}) };
}
function redactCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return null;
  const models = Array.isArray(catalog.models) ? catalog.models.flatMap((model) => {
    const id = typeof model === "string" ? model : model?.id;
    if (typeof id !== "string" || !id) return [];
    const name = typeof model?.display_name === "string" && model.display_name
      ? model.display_name
      : typeof model?.name === "string" && model.name ? model.name : id;
    return [{ id, name, capabilities: Array.isArray(model?.capabilities) ? model.capabilities.filter((item) => item === "image" || item === "video") : [], compatibility: ["confirmed", "unconfirmed", "unsupported"].includes(model?.compatibility) ? model.compatibility : "unsupported" }];
  }) : [];
  const counts = catalog.counts && typeof catalog.counts === "object" && !Array.isArray(catalog.counts)
    ? Object.fromEntries(["total", "confirmed", "unconfirmed", "unsupported"].map((key) => [key, Number.isInteger(catalog.counts[key]) && catalog.counts[key] >= 0 ? catalog.counts[key] : 0]))
    : { total: models.length, confirmed: models.filter((model) => model.compatibility === "confirmed").length, unconfirmed: models.filter((model) => model.compatibility === "unconfirmed").length, unsupported: models.filter((model) => model.compatibility === "unsupported").length };
  return {
    ...(typeof catalog.digest === "string" ? { digest: catalog.digest } : {}),
    ...(typeof catalog.discovered_at === "string" ? { discovered_at: catalog.discovered_at } : {}),
    models,
    counts,
  };
}
function redactProviderConnection(profile) {
  if (!profile || typeof profile !== "object") return profile;
  const legacyCatalog = profile.legacy === true && Array.isArray(profile.models)
    ? { models: profile.models.map((id) => ({ id, name: id, capabilities: profile.capabilities ?? [], compatibility: "unsupported" })) }
    : null;
  return {
    connection_id: profile.connection_id,
    name: profile.name,
    provider_id: profile.provider_id,
    legacy: profile.legacy === true,
    capabilities: profile.capabilities ?? [],
    ...(profile.base_url ? { base_url: profile.base_url } : {}),
    ...(typeof profile.status === "string" ? { status: profile.status } : {}),
    ...(typeof profile.protocol === "string" ? { protocol: profile.protocol } : {}),
    ...(typeof profile.adapter_id === "string" ? { adapter: { id: profile.adapter_id, ...(typeof profile.adapter_version === "string" ? { version: profile.adapter_version } : {}) } } : {}),
    ...(typeof profile.provider_label === "string" ? { provider_label: profile.provider_label } : {}),
    ...(Number.isInteger(profile.model_catalog_revision) ? { model_catalog_revision: profile.model_catalog_revision } : {}),
    ...(typeof profile.model_catalog_digest === "string" ? { model_catalog_digest: profile.model_catalog_digest } : {}),
    ...(typeof profile.last_discovered_at === "string" ? { last_discovered_at: profile.last_discovered_at } : {}),
    ...(profile.model_catalog || legacyCatalog ? { catalog: redactCatalog(profile.model_catalog ?? legacyCatalog) } : {}),
    enabled: profile.enabled === true,
    config_revision: profile.config_revision,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    ...(profile.last_test ? { last_test: { status: profile.last_test.status, code: profile.last_test.code, tested_at: profile.last_test.tested_at } } : {}),
  };
}
function discoverySummary(connection) {
  const catalog = redactCatalog(connection?.model_catalog);
  return {
    status: typeof connection?.status === "string" ? connection.status : "failed",
    code: typeof connection?.last_discovery?.code === "string" ? connection.last_discovery.code : null,
    model_count: catalog?.models.length ?? 0,
    ...(typeof connection?.protocol === "string" ? { protocol: connection.protocol } : {}),
    ...(connection?.adapter_id ? { adapter: { id: connection.adapter_id, ...(connection.adapter_version ? { version: connection.adapter_version } : {}) } } : {}),
  };
}
function validateModernCreate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("VALIDATION_FAILED", "连接信息必须是对象。", { field: "body" });
  const allowed = new Set(["name", "base_url"]);
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) throw new DomainError("VALIDATION_FAILED", "新建连接只能包含名称和 API 地址。", { field: unsupported });
  return value;
}
function redactProviderStatus(value) {
  return {
    status: typeof value?.status === "string" ? value.status : "setup_required",
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
    ...(typeof value?.checked_at === "string" ? { checked_at: value.checked_at } : {}),
  };
}
function providerDescriptorPublic(descriptor) {
  return {
    id: descriptor.id,
    display_name: descriptor.display_name,
    kind: descriptor.kind,
    capabilities: descriptor.capabilities,
    models: descriptor.models,
    credential_fields: descriptor.credential_fields,
  };
}
function redactArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  const { local_path: _localPath, source_url: _sourceUrl, ...safe } = artifact;
  return { ...safe, content_url: `/api/v1/artifacts/${encodeURIComponent(artifact.id)}/content` };
}
function redactJob(job) {
  if (!job || typeof job !== "object") return job;
  const safe = { ...job };
  if (safe.snapshot && typeof safe.snapshot === "object") {
    safe.snapshot = { ...safe.snapshot, attachments: [] };
  }
  return safe;
}
function redactState(state) {
  if (!state || typeof state !== "object") return state;
  return {
    ...state,
    ...(Array.isArray(state.jobs) ? { jobs: state.jobs.map(redactJob) } : {}),
    ...(Array.isArray(state.artifacts) ? { artifacts: state.artifacts.map(redactArtifact) } : {}),
  };
}
function redactOrchestratorResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    ...(result.job ? { job: redactJob(result.job) } : {}),
    ...(Array.isArray(result.artifacts) ? { artifacts: result.artifacts.map(redactArtifact) } : {}),
    ...(result.results ? { results: result.results.map((item) => item?.artifact ? { ...item, artifact: redactArtifact(item.artifact) } : item) } : {}),
  };
}
function requestSessionId(request, url) {
  const header = request.headers["x-imvia-workbench-session"];
  return (typeof header === "string" && header.trim()) || url.searchParams.get("session") || null;
}
function requestSessionToken(request, url) {
  const header = request.headers["x-imvia-workbench-token"];
  return (typeof header === "string" && header.trim()) || url.searchParams.get("bridge_token") || null;
}

async function serveWorkbench(response, pathname, workbenchDirectory) {
  let relativePath;
  if (pathname === "/workbench" || pathname === "/workbench/") relativePath = "index.html";
  else if (pathname.startsWith("/assets/")) relativePath = pathname.slice(1);
  else return false;

  const root = path.resolve(workbenchDirectory);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    send(response, 404, { api_version: "1", ok: false, error: { code: "NOT_FOUND", message: "Workbench asset not found.", retryable: false, details: {} } });
    return true;
  }
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    const contents = await readFile(candidate);
    response.writeHead(200, {
      "content-type": WORKBENCH_MIME_TYPES[path.extname(candidate).toLowerCase()] || "application/octet-stream",
      "cache-control": path.basename(candidate) === "index.html" || path.basename(candidate).startsWith("imvia-lovart-")
        ? "no-store"
        : "public, max-age=31536000, immutable",
    });
    response.end(contents);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function errorStatus(error) {
  if (!(error instanceof DomainError)) return 400;
  if (["REVISION_CONFLICT", "STATUS_CONFLICT"].includes(error.code)) return 409;
  if (error.code === "NOT_FOUND") return 404;
  return 400;
}

export async function startHttpServer({ dataDirectory, service: providedService, projectContextService = null, orchestrator = null, bridgeService = null, port = 0, workbenchDirectory = DEFAULT_WORKBENCH_DIRECTORY, lovartConnection = null, providerRegistry = null, connectionStore = null, providerCredentialService = null, providerConnectionService = null, providerConnectionTester = null, providerExecutionRouter = null } = {}) {
  const service = providedService || createWorkbenchService({ dataDirectory });
  const eventClients = new Set();
  let eventId = 0;
  const publish = (event, data) => {
    eventId += 1;
    const message = `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of eventClients) client.write(message);
  };
  const unsubscribe = service.subscribe((event) => publish(event.type, event.data));
  const unsubscribeLovart = typeof lovartConnection?.subscribe === "function"
    ? lovartConnection.subscribe((event) => publish(event.type, event.data))
    : () => {};
  const unsubscribeBridge = typeof bridgeService?.subscribe === "function"
    ? bridgeService.subscribe((event) => publish(event.type, event.data))
    : () => {};
  const validateWorkbenchMutation = async (request, url) => {
    if (typeof bridgeService?.validateSessionToken !== "function") return;
    const sessionId = requestSessionId(request, url);
    if (!sessionId) throw new DomainError("VALIDATION_FAILED", "workbench session is required.", { field: "session" });
    await bridgeService.validateSessionToken({ session_id: sessionId, open_token: requestSessionToken(request, url) });
  };
  const publishConnectionProgress = (connection, stage, status, code = null) => {
    const catalog = redactCatalog(connection?.model_catalog);
    publish("provider.connection_progress", {
      connection_id: connection?.connection_id,
      stage,
      status,
      code: typeof code === "string" ? code : null,
      model_count: catalog?.models.length ?? 0,
    });
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(302, { location: "/workbench?imvia=live", "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/workbench/bootstrap.js") {
        let connection = { state: "setup_required", code: "SETUP_REQUIRED" };
        if (typeof lovartConnection?.status === "function") {
          try { connection = redactedConnection(await lovartConnection.status()); } catch { connection = { state: "failed", code: "HELPER_NOT_PACKAGED" }; }
        }
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(`window.__IMVIA_LOVART_STATUS__=${JSON.stringify(connection)};`);
        return;
      }
      if (request.method === "POST" && url.pathname === "/workbench/lovart/connect") {
        // Keep the legacy endpoint safe for older workbench bundles, but never
        // use form navigation here. A 303 would reload the page while the
        // native credential dialog is still active and can make user input
        // appear to disappear. The current bundle uses the JSON API below;
        // this compatibility route returns the same redacted envelope.
        const action = lovartConnection?.retry || lovartConnection?.connect;
        if (typeof action !== "function") return send(response, 503, { api_version: "1", ok: false, error: { code: "CONNECTION_UNAVAILABLE", message: "Lovart connection service is unavailable.", retryable: true, details: {} } });
        return send(response, 200, envelope(redactedConnection(await action.call(lovartConnection))));
      }
      if (request.method === "GET" && await serveWorkbench(response, url.pathname, workbenchDirectory)) return;
      if (request.method === "GET" && url.pathname === "/api/v1/health") return send(response, 200, envelope({ status: "ok", bind: "127.0.0.1" }));
      if (request.method === "GET" && url.pathname === "/api/v1/workbench/session") {
        if (!bridgeService?.getSessionStatus) throw new DomainError("BRIDGE_UNAVAILABLE", "Workbench conversation bridge is unavailable.");
        const sessionId = requestSessionId(request, url);
        if (!sessionId) throw new DomainError("VALIDATION_FAILED", "workbench session is required.", { field: "session" });
        if (bridgeService?.validateSessionToken) await bridgeService.validateSessionToken({ session_id: sessionId, open_token: requestSessionToken(request, url) });
        return send(response, 200, envelope(await bridgeService.getSessionStatus({ session_id: sessionId })));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/lovart/status") {
        if (typeof lovartConnection?.status !== "function") return send(response, 503, { api_version: "1", ok: false, error: { code: "CONNECTION_UNAVAILABLE", message: "Lovart connection service is unavailable.", retryable: true, details: {} } });
        return send(response, 200, envelope(redactedConnection(await lovartConnection.status())));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/lovart/projects") {
        if (!projectContextService?.list) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart project context service is unavailable.");
        return send(response, 200, envelope(await projectContextService.list()));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/lovart/projects/select") {
        if (!projectContextService?.select) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart project context service is unavailable.");
        return send(response, 200, envelope(await projectContextService.select(await body(request))));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/lovart/projects/remember") {
        if (!projectContextService?.remember) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart project context service is unavailable.");
        return send(response, 200, envelope(await projectContextService.remember(await body(request))));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/lovart/projects/create") {
        if (!projectContextService?.create) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart project context service is unavailable.");
        return send(response, 200, envelope(await projectContextService.create(await body(request))));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/lovart/connect") {
        const action = lovartConnection?.retry || lovartConnection?.connect;
        if (typeof action !== "function") return send(response, 503, { api_version: "1", ok: false, error: { code: "CONNECTION_UNAVAILABLE", message: "Lovart connection service is unavailable.", retryable: true, details: {} } });
        return send(response, 200, envelope(redactedConnection(await action.call(lovartConnection))));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/lovart/disconnect") {
        if (typeof lovartConnection?.disconnect !== "function") return send(response, 503, { api_version: "1", ok: false, error: { code: "CONNECTION_UNAVAILABLE", message: "Lovart connection service is unavailable.", retryable: true, details: {} } });
        return send(response, 200, envelope(redactedConnection(await lovartConnection.disconnect())));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/providers") {
        if (!providerRegistry?.list) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider registry is unavailable.");
        const mode = url.searchParams.get("mode");
        if (mode && !["image", "video"].includes(mode)) throw new DomainError("VALIDATION_FAILED", "Provider mode is invalid.", { field: "mode" });
        return send(response, 200, envelope({ providers: providerRegistry.list().filter((provider) => !mode || provider.capabilities.includes(mode)).map(providerDescriptorPublic) }));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/connections") {
        if (!connectionStore?.list) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection store is unavailable.");
        return send(response, 200, envelope({ connections: (await connectionStore.list()).map(redactProviderConnection) }));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/connections") {
        if (!providerConnectionService?.createDraft) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection lifecycle service is unavailable.");
        await validateWorkbenchMutation(request, url);
        const connection = await providerConnectionService.createDraft(validateModernCreate(await body(request)));
        return send(response, 201, envelope({ connection: redactProviderConnection(connection) }));
      }
      const providerConnectionMatch = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)$/);
      if (providerConnectionMatch && request.method === "PATCH") {
        if (!connectionStore?.update) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection store is unavailable.");
        await validateWorkbenchMutation(request, url);
        const connectionId = decodeURIComponent(providerConnectionMatch[1]);
        const current = await connectionStore.get(connectionId);
        if (!current) throw new DomainError("NOT_FOUND", "The provider connection does not exist.", { connection_id: connectionId });
        const patch = await body(request);
        const connection = current.legacy === true
          ? await connectionStore.update(connectionId, patch)
          : await providerConnectionService?.update?.({ connection_id: connectionId, ...patch });
        if (!connection) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection lifecycle service is unavailable.");
        return send(response, 200, envelope({ connection: redactProviderConnection(connection) }));
      }
      if (providerConnectionMatch && request.method === "DELETE") {
        if (!connectionStore?.remove) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection store is unavailable.");
        await validateWorkbenchMutation(request, url);
        const connectionId = decodeURIComponent(providerConnectionMatch[1]);
        const current = await connectionStore.get(connectionId);
        if (!current) throw new DomainError("NOT_FOUND", "The provider connection does not exist.", { connection_id: connectionId });
        const connection = current.legacy === true
          ? await connectionStore.remove(connectionId)
          : await providerConnectionService?.remove?.({ connection_id: connectionId });
        if (!connection) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection lifecycle service is unavailable.");
        return send(response, 200, envelope({ deleted: true, connection: redactProviderConnection(connection) }));
      }
      const providerCredentialsMatch = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)\/credentials$/);
      if (providerCredentialsMatch && request.method === "POST") {
        if (!connectionStore?.get) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection store is unavailable.");
        await validateWorkbenchMutation(request, url);
        const connectionId = decodeURIComponent(providerCredentialsMatch[1]);
        const connection = await connectionStore.get(connectionId);
        if (!connection) throw new DomainError("NOT_FOUND", "The provider connection does not exist.", { connection_id: decodeURIComponent(providerCredentialsMatch[1]) });
        if (connection.legacy !== true) {
          if (!providerConnectionService?.configureAndDiscover) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection lifecycle service is unavailable.");
          publishConnectionProgress(connection, "credential_setup", "started");
          const result = await providerConnectionService.configureAndDiscover({
            connection_id: connectionId,
            onState: (state) => publishConnectionProgress(connection, state === "validating" ? "discovering" : "credential_setup", state === "validating" ? "started" : "in_progress"),
          });
          const discovery = discoverySummary(result);
          publishConnectionProgress(result, "completed", discovery.status, discovery.code);
          return send(response, 200, envelope({ connection: redactProviderConnection(result), discovery }));
        }
        if (!providerCredentialService?.configure) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider credential service is unavailable.");
        const status = await providerCredentialService.configure({
          connection_id: connection.credential_ref,
          fields: connection.provider_descriptor.credential_fields,
          onState: (state) => publish("provider.connection_status", { connection_id: connection.connection_id, status: state }),
          validate: async (credential) => {
            if (typeof providerConnectionTester !== "function") return { accepted: false, code: "SETUP_INVALID" };
            const result = await providerConnectionTester({ connection, credential, providerExecutionRouter });
            return { accepted: result?.status === "connected" || result?.accepted === true, code: result?.code ?? "AUTHENTICATION_FAILED" };
          },
        });
        publish("provider.connection_updated", { connection_id: connection.connection_id, status: redactProviderStatus(status) });
        return send(response, 200, envelope(redactProviderStatus(status)));
      }
      const providerDiscoverMatch = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)\/discover$/u);
      if (providerDiscoverMatch && request.method === "POST") {
        if (!providerConnectionService?.rediscover) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection lifecycle service is unavailable.");
        await validateWorkbenchMutation(request, url);
        const connectionId = decodeURIComponent(providerDiscoverMatch[1]);
        const current = await connectionStore?.get?.(connectionId);
        if (!current) throw new DomainError("NOT_FOUND", "The provider connection does not exist.", { connection_id: connectionId });
        publishConnectionProgress(current, "discovering", "started");
        const result = await providerConnectionService.rediscover({ connection_id: connectionId });
        const discovery = discoverySummary(result);
        publishConnectionProgress(result, "completed", discovery.status, discovery.code);
        return send(response, 200, envelope({ connection: redactProviderConnection(result), discovery }));
      }
      const refreshMatch = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)\/models\/refresh$/u);
      if (refreshMatch && request.method === "POST") {
        if (!providerConnectionService?.refreshModels) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection lifecycle service is unavailable.");
        await validateWorkbenchMutation(request, url);
        const connectionId = decodeURIComponent(refreshMatch[1]);
        const current = await connectionStore?.get?.(connectionId);
        if (!current) throw new DomainError("NOT_FOUND", "The provider connection does not exist.", { connection_id: connectionId });
        publishConnectionProgress(current, "model_refresh", "started");
        const result = await providerConnectionService.refreshModels({ connection_id: connectionId });
        const discovery = discoverySummary(result);
        publishConnectionProgress(result, "completed", discovery.status, discovery.code);
        return send(response, 200, envelope({ connection: redactProviderConnection(result), catalog: redactCatalog(result.model_catalog) }));
      }
      const providerTestMatch = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)\/test$/);
      if (providerTestMatch && request.method === "POST") {
        if (!connectionStore?.get || !connectionStore?.markTested || !providerCredentialService?.read || typeof providerConnectionTester !== "function") throw new DomainError("CONTEXT_UNAVAILABLE", "Provider connection test service is unavailable.");
        await validateWorkbenchMutation(request, url);
        const connectionId = decodeURIComponent(providerTestMatch[1]);
        const connection = await connectionStore.get(connectionId);
        if (!connection) throw new DomainError("NOT_FOUND", "The provider connection does not exist.", { connection_id: connectionId });
        const credential = await providerCredentialService.read({ credential_ref: connection.credential_ref });
        const result = await providerConnectionTester({ connection, credential, providerExecutionRouter });
        const tested = await connectionStore.markTested(connectionId, { status: result?.status ?? (result?.accepted ? "connected" : "failed"), code: result?.code ?? "CONNECTION_TEST_FAILED" });
        publish("provider.connection_updated", { connection_id: tested.connection_id, status: redactProviderStatus(tested.last_test) });
        return send(response, 200, envelope({ ...redactProviderStatus(tested.last_test), connection: redactProviderConnection(tested) }));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/generations") {
        throw new DomainError("WORKBENCH_BRIDGE_REQUIRED", "Browser generation requests must use /api/v1/workbench/submissions and the current Codex conversation bridge.");
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workbench/submissions") {
        if (typeof service.createWorkbenchSubmission !== "function") throw new DomainError("CONTEXT_UNAVAILABLE", "Workbench handoff service is unavailable.");
        await validateWorkbenchMutation(request, url);
        const input = await body(request);
        const result = await service.createWorkbenchSubmission(input);
        let dispatch = null;
        if (bridgeService?.createDispatch) {
          const sessionId = requestSessionId(request, url);
          const created = await bridgeService.createDispatch({ job_id: result.job.id, workbench_session_id: sessionId, snapshot: result.job.snapshot, idempotency_key: input.idempotency_key });
          dispatch = created.dispatch;
        }
        return send(response, 202, envelope({ job_id: result.job.id, dispatch_id: dispatch?.id ?? null, delivery_state: dispatch?.delivery_state ?? "delivery_uncertain", status: result.job.status, status_message: result.job.status_message, progress: result.job.progress, idempotent: result.idempotent ?? false }));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workbench/assets") {
        if (typeof dataDirectory !== "string" || !path.isAbsolute(dataDirectory)) throw new DomainError("CONTEXT_UNAVAILABLE", "Workbench media storage is unavailable.");
        const mediaType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        const extension = WORKBENCH_UPLOAD_EXTENSIONS[mediaType];
        if (!extension) throw new DomainError("FILE_TYPE_UNSUPPORTED", "Workbench media must be a supported image, video, or audio file.", { content_type: mediaType || null });
        const bytes = await binaryBody(request);
        if (!bytes.length) throw new DomainError("VALIDATION_FAILED", "Uploaded workbench media is empty.");
        const uploadDirectory = path.join(path.resolve(dataDirectory), "workbench-uploads");
        await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
        const assetName = `${randomUUID()}${extension}`;
        const localPath = path.join(uploadDirectory, assetName);
        await writeFile(localPath, bytes, { mode: 0o600, flag: "wx" });
        return send(response, 201, envelope({ attachment: `imvia-upload:${assetName}`, content_type: mediaType, size_bytes: bytes.length }));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/state") {
        const include = (url.searchParams.get("include") || "").split(",").filter((value) => ["jobs", "artifacts"].includes(value));
        return send(response, 200, envelope(redactState(await service.getState({ include }))));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/events") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.flushHeaders();
        eventClients.add(response);
        request.on("close", () => eventClients.delete(response));
        return;
      }
      const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (request.method === "PATCH" && projectMatch) {
        await validateWorkbenchMutation(request, url);
        const renamed = await service.renameProject({ ...(await body(request)), project_id: decodeURIComponent(projectMatch[1]) });
        return send(response, 200, envelope({ project: renamed.project }));
      }
      const draftMatch = url.pathname.match(/^\/api\/v1\/drafts\/([^/]+)$/);
      if (request.method === "PATCH" && draftMatch) {
        const updated = await service.patchWorkbench({ ...(await body(request)), draft_id: decodeURIComponent(draftMatch[1]) });
        return send(response, 200, envelope({ revision: updated.draft.revision, changed_fields: updated.changed_fields, validation: { warnings: [] } }));
      }
      const prepareMatch = url.pathname.match(/^\/api\/v1\/drafts\/([^/]+)\/prepare$/);
      if (request.method === "POST" && prepareMatch) {
        const prepared = await service.prepareGeneration({ ...(await body(request)), draft_id: decodeURIComponent(prepareMatch[1]) });
        return send(response, 200, envelope({ job_id: prepared.job.id, status: prepared.job.status, snapshot: prepared.job.snapshot, validation: prepared.validation ?? { warnings: [] }, idempotent: prepared.idempotent }));
      }
      const statusMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/status$/);
      if (request.method === "POST" && statusMatch) {
        const updated = await service.updateJob({ ...(await body(request)), job_id: decodeURIComponent(statusMatch[1]) });
        return send(response, 200, envelope({ job_id: updated.job.id, status: updated.job.status, status_message: updated.job.status_message, progress: updated.job.progress, attempt: updated.job.attempt, estimated_cost: updated.job.estimated_cost, lovart_thread_id: updated.job.lovart_thread_id }));
      }
      const deliveryMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/delivery$/);
      if (request.method === "GET" && deliveryMatch) {
        if (!bridgeService?.listDispatches) throw new DomainError("BRIDGE_UNAVAILABLE", "Workbench conversation bridge is unavailable.");
        const dispatches = await bridgeService.listDispatches();
        const dispatch = dispatches.find((item) => item.job_id === decodeURIComponent(deliveryMatch[1]));
        if (!dispatch) throw new DomainError("NOT_FOUND", "The workbench delivery does not exist.", { job_id: decodeURIComponent(deliveryMatch[1]) });
        return send(response, 200, envelope({ job_id: dispatch.job_id, dispatch_id: dispatch.id, delivery_state: dispatch.delivery_state, attempt_count: dispatch.attempt_count, last_error: dispatch.last_error, submitted_at: dispatch.submitted_at, updated_at: dispatch.updated_at }));
      }
      const artifactMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/artifacts$/);
      if (request.method === "POST" && artifactMatch) {
        const imported = await service.importResult({ ...(await body(request)), job_id: decodeURIComponent(artifactMatch[1]) });
        return send(response, 200, envelope({ job_id: imported.job.id, status: imported.job.status, results: imported.results.map((item) => item?.artifact ? { ...item, artifact: redactArtifact(item.artifact) } : item), idempotent: imported.idempotent }));
      }
      const followUpMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/follow-ups$/);
      if (request.method === "POST" && followUpMatch) {
        if (!orchestrator?.followUp) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart follow-up service is unavailable.");
        const input = await body(request);
        if (Object.hasOwn(input, "activation")) throw new DomainError("VALIDATION_FAILED", "HTTP workbench actions derive their Lovart activation internally.", { field: "activation" });
        if (Object.hasOwn(input, "parent_job_id")) throw new DomainError("VALIDATION_FAILED", "The parent job is derived from the URL.", { field: "parent_job_id" });
        const result = await orchestrator.followUp({
          ...input,
          parent_job_id: decodeURIComponent(followUpMatch[1]),
          activation: { source: "codex_context_continuation", parent_job_id: decodeURIComponent(followUpMatch[1]), artifact_id: input.artifact_id },
        });
        return send(response, 202, envelope({ job_id: result.job.id, parent_job_id: decodeURIComponent(followUpMatch[1]), status: result.job.status, idempotent: result.idempotent ?? false }));
      }
      const artifactContentMatch = url.pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/);
      if (request.method === "GET" && artifactContentMatch) {
        const state = await service.getState({ include: ["artifacts"] });
        const artifact = state.artifacts.find((item) => item.id === decodeURIComponent(artifactContentMatch[1]));
        if (!artifact) throw new DomainError("NOT_FOUND", "The requested artifact does not exist.", { artifact_id: artifactContentMatch[1] });
        const managedRoot = path.resolve(dataDirectory || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.imvia-studio-dev"));
        const candidate = path.resolve(artifact.local_path);
        if (!candidate.startsWith(`${managedRoot}${path.sep}`)) throw new DomainError("PATH_NOT_ALLOWED", "The artifact is outside the managed directory.");
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink()) throw new DomainError("PATH_NOT_ALLOWED", "The artifact is not a managed regular file.");
        const contents = await readFile(candidate);
        response.writeHead(200, { "content-type": artifact.mime_type || "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(contents);
        return;
      }
      const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (request.method === "GET" && jobMatch) {
        if (!orchestrator?.get) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart generation orchestrator is unavailable.");
        return send(response, 200, envelope(redactOrchestratorResult(await orchestrator.get({ job_id: decodeURIComponent(jobMatch[1]) }))));
      }
      const costDecisionMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/cost-decisions$/);
      if (request.method === "POST" && costDecisionMatch) {
        if (!orchestrator?.confirm) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart generation orchestrator is unavailable.");
        const input = await body(request);
        return send(response, 200, envelope(await orchestrator.confirm({ ...input, job_id: decodeURIComponent(costDecisionMatch[1]) })));
      }
      send(response, 404, { api_version: "1", ok: false, error: { code: "NOT_FOUND", message: "Route not found.", retryable: false, details: {} } });
    } catch (error) { send(response, errorStatus(error), errorPayload(error)); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port }, resolve); });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return { host: "127.0.0.1", url, workbenchUrl: `${url}/workbench?imvia=live`, close: () => new Promise((resolve, reject) => { unsubscribe(); unsubscribeLovart(); unsubscribeBridge(); for (const client of eventClients) client.end(); server.close((error) => error ? reject(error) : resolve()); }) };
}
