import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
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
function send(response, status, payload) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(payload)); }
function envelope(data) { return { api_version: "1", ok: true, data }; }
function errorPayload(error) { const known = error instanceof DomainError; return { api_version: "1", ok: false, error: { code: known ? error.code : "STORE_UNAVAILABLE", message: known ? error.message : "Local workbench service is unavailable.", retryable: known && ["REVISION_CONFLICT", "STATUS_CONFLICT"].includes(error.code), details: known ? error.details : {} } }; }

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

export async function startHttpServer({ dataDirectory, service: providedService, port = 4190, workbenchDirectory = DEFAULT_WORKBENCH_DIRECTORY } = {}) {
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
      if (request.method === "GET" && await serveWorkbench(response, url.pathname, workbenchDirectory)) return;
      if (request.method === "GET" && url.pathname === "/api/v1/health") return send(response, 200, envelope({ status: "ok", bind: "127.0.0.1" }));
      if (request.method === "GET" && url.pathname === "/api/v1/state") {
        const include = (url.searchParams.get("include") || "").split(",").filter((value) => ["jobs", "artifacts"].includes(value));
        return send(response, 200, envelope(await service.getState({ include })));
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
        return send(response, 200, envelope({ job_id: imported.job.id, status: imported.job.status, results: imported.results, idempotent: imported.idempotent }));
      }
      send(response, 404, { api_version: "1", ok: false, error: { code: "NOT_FOUND", message: "Route not found.", retryable: false, details: {} } });
    } catch (error) { send(response, errorStatus(error), errorPayload(error)); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port }, resolve); });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return { host: "127.0.0.1", url, workbenchUrl: `${url}/workbench?imvia=live`, close: () => new Promise((resolve, reject) => { unsubscribe(); for (const client of eventClients) client.end(); server.close((error) => error ? reject(error) : resolve()); }) };
}
