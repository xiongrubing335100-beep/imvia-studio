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
function errorPayload(error) { const known = error instanceof DomainError; return { api_version: "1", ok: false, error: { code: known ? error.code : "STORE_UNAVAILABLE", message: known ? error.message : "Local workbench service is unavailable.", retryable: known && ["REVISION_CONFLICT", "STATUS_CONFLICT"].includes(error.code), details: known ? error.details : {} } }; }
function redactedConnection(value) {
  const connected = value?.status === "connected";
  const code = typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : null;
  return { status: connected ? "connected" : "not_connected", ...(code ? { code } : {}) };
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
function redirectToWorkbench(response, connection) {
  const query = new URLSearchParams({ imvia: "live", lovart: connection.status });
  if (connection.code) query.set("code", connection.code);
  response.writeHead(303, { location: `/workbench?${query}`, "cache-control": "no-store" });
  response.end();
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
      "cache-control": path.basename(candidate) === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
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

export async function startHttpServer({ dataDirectory, service: providedService, projectContextService = null, orchestrator = null, port = 4190, workbenchDirectory = DEFAULT_WORKBENCH_DIRECTORY, lovartConnection = null } = {}) {
  const service = providedService || createWorkbenchService({ dataDirectory });
  const eventClients = new Set();
  let eventId = 0;
  const publish = (event, data) => {
    eventId += 1;
    const message = `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of eventClients) client.write(message);
  };
  const unsubscribe = service.subscribe((event) => publish(event.type, event.data));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(302, { location: "/workbench?imvia=live", "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/workbench/bootstrap.js") {
        let connection = { status: "not_connected", code: "CONNECTION_UNAVAILABLE" };
        if (typeof lovartConnection?.status === "function") {
          try { connection = redactedConnection(await lovartConnection.status()); } catch { connection = { status: "not_connected", code: "CONNECTION_UNAVAILABLE" }; }
        }
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(`window.__IMVIA_LOVART_STATUS__=${JSON.stringify(connection)};`);
        return;
      }
      if (request.method === "POST" && url.pathname === "/workbench/lovart/connect") {
        if (typeof lovartConnection?.connect !== "function") return redirectToWorkbench(response, { status: "not_connected", code: "CONNECTION_UNAVAILABLE" });
        try { return redirectToWorkbench(response, redactedConnection(await lovartConnection.connect())); }
        catch { return redirectToWorkbench(response, { status: "not_connected", code: "UPSTREAM_UNAVAILABLE" }); }
      }
      if (request.method === "GET" && await serveWorkbench(response, url.pathname, workbenchDirectory)) return;
      if (request.method === "GET" && url.pathname === "/api/v1/health") return send(response, 200, envelope({ status: "ok", bind: "127.0.0.1" }));
      if (request.method === "GET" && url.pathname === "/api/v1/lovart/status") {
        if (typeof lovartConnection?.status !== "function") return send(response, 503, { api_version: "1", ok: false, error: { code: "CONNECTION_UNAVAILABLE", message: "Lovart connection service is unavailable.", retryable: true, details: {} } });
        return send(response, 200, envelope(await lovartConnection.status()));
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
        if (typeof lovartConnection?.connect !== "function") return send(response, 503, { api_version: "1", ok: false, error: { code: "CONNECTION_UNAVAILABLE", message: "Lovart connection service is unavailable.", retryable: true, details: {} } });
        return send(response, 200, envelope(await lovartConnection.connect()));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/generations") {
        if (!orchestrator?.submit) throw new DomainError("CONTEXT_UNAVAILABLE", "Lovart generation orchestrator is unavailable.");
        const input = await body(request);
        if (Object.hasOwn(input, "activation")) throw new DomainError("VALIDATION_FAILED", "HTTP workbench actions derive their Lovart activation internally.", { field: "activation" });
        const result = await orchestrator.submit({ ...input, activation: { source: "workbench_action" } });
        return send(response, 202, envelope({ job_id: result.job.id, status: result.job.status, idempotent: result.idempotent ?? false }));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workbench/submissions") {
        if (typeof service.createWorkbenchSubmission !== "function") throw new DomainError("CONTEXT_UNAVAILABLE", "Workbench handoff service is unavailable.");
        const result = await service.createWorkbenchSubmission(await body(request));
        return send(response, 202, envelope({ job_id: result.job.id, status: result.job.status, idempotent: result.idempotent ?? false }));
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
        return send(response, 200, envelope({ job_id: updated.job.id, status: updated.job.status, attempt: updated.job.attempt, estimated_cost: updated.job.estimated_cost, lovart_thread_id: updated.job.lovart_thread_id }));
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
  return { host: "127.0.0.1", url, workbenchUrl: `${url}/workbench?imvia=live`, close: () => new Promise((resolve, reject) => { unsubscribe(); for (const client of eventClients) client.end(); server.close((error) => error ? reject(error) : resolve()); }) };
}
