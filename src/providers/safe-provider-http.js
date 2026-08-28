import https from "node:https";
import dns from "node:dns";
import { DomainError } from "../domain/errors.js";

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function securityFail(message) {
  throw new DomainError("UPSTREAM_SECURITY_REJECTED", message);
}

// This deliberately errs on the side of rejecting non-routable and special-use
// addresses. Documentation ranges remain usable as test/provider hosts.
export function isForbiddenAddress(value) {
  const host = String(value ?? "").toLowerCase().replace(/^\[|\]$/gu, "");
  if (["localhost", "localhost.localdomain", "0.0.0.0", "::", "::1"].includes(host) || host.endsWith(".localhost")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u);
  if (v4) {
    const p = v4.slice(1).map(Number);
    if (p.some((n) => n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254)
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  if (!host.includes(":")) return false;
  const groups = host.split(":");
  if (groups.filter(Boolean).length < 2 || groups.some((g) => g && !/^[0-9a-f]{1,4}$/u.test(g))) return true;
  if (host.startsWith("::ffff:")) {
    const tail = host.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(tail)) return isForbiddenAddress(tail);
    return true;
  }
  const first = Number.parseInt(groups[0] || "0", 16);
  const second = Number.parseInt(groups[1] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || first === 0xff00 || (first === 0 && second === 0);
}

export async function resolvePublicAddresses(hostname, lookup = dns.promises.lookup) {
  let answers;
  try { answers = await lookup(hostname, { all: true, verbatim: true }); } catch { securityFail("Provider host DNS resolution failed."); }
  const list = Array.isArray(answers) ? answers : [answers];
  if (!list.length || list.some((answer) => !answer?.address || isForbiddenAddress(answer.address))) securityFail("Provider host resolves to a forbidden address.");
  return list;
}

export async function assertSafeProviderUrl(input, { lookup } = {}) {
  let url;
  try { url = input instanceof URL ? new URL(input) : new URL(input); } catch { securityFail("Provider URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) securityFail("Provider URL must be credential-free HTTPS.");
  await resolvePublicAddresses(url.hostname, lookup ?? dns.promises.lookup);
  return url;
}

function timeoutRace(work, timeoutMs, cancel) {
  if (!(timeoutMs > 0)) return work;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancel?.();
      reject(new DomainError("UPSTREAM_TIMEOUT", "Provider request timed out."));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function requestPinnedHttps(url, input, operation = {}) {
  if (typeof input.transport === "function") {
    return Promise.resolve(input.transport({ url: String(url), method: input.method ?? "GET", headers: input.headers ?? {}, body: input.body, lookup: input.lookup, signal: operation.signal })).then((response) => {
      operation.track?.(response);
      return response;
    });
  }
  return new Promise((resolve, reject) => {
    let cleaned = false;
    let lateSinkInstalled = false;
    let settled = false;
    let responseSeen = false;
    let request;
    const cleanup = () => {
      if (!request) return;
      if (cleaned) return;
      cleaned = true;
      request?.removeListener("error", onError);
      request?.removeListener("timeout", onTimeout);
      request?.removeListener("close", onClose);
    };
    const cleanupLateSink = () => {
      if (!request || !lateSinkInstalled) return;
      lateSinkInstalled = false;
      request.removeListener("error", onLateError);
      request.removeListener("close", onLateClose);
    };
    const onLateError = () => cleanupLateSink();
    const onLateClose = () => cleanupLateSink();
    const installLateSink = () => {
      if (!request || lateSinkInstalled) return;
      lateSinkInstalled = true;
      request.once("error", onLateError);
      request.once("close", onLateClose);
    };
    const onError = (error) => {
      if (!settled) { settled = true; reject(error); }
      cleanup();
      installLateSink();
    };
    const onTimeout = () => {
      const error = new DomainError("UPSTREAM_TIMEOUT", "Provider request timed out.");
      settled = true;
      cleanup();
      installLateSink();
      try { request.destroy(); } catch { /* timeout rejection is already established */ }
      reject(error);
    };
    const onClose = () => {
      if (!settled) { settled = true; reject(new DomainError("UPSTREAM_UNAVAILABLE", "Provider request closed before a response.")); }
      cleanup();
    };
    request = https.request(url, { method: input.method ?? "GET", headers: input.headers ?? {}, timeout: input.timeout_ms ?? 10_000, signal: operation.signal, servername: url.hostname, lookup: (hostname, options, callback) => {
      resolvePublicAddresses(hostname, input.lookup ?? dns.promises.lookup).then((answers) => callback(null, answers[0].address, answers[0].family)).catch(callback);
    } }, (response) => {
      responseSeen = true;
      settled = true;
      operation.track?.(response);
      cleanup();
      installLateSink();
      resolve(response);
    });
    operation.track?.(request, () => { cleanup(); installLateSink(); });
    request.once("error", onError);
    request.once("timeout", onTimeout);
    request.once("close", onClose);
    if (responseSeen) { cleanup(); installLateSink(); }
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

async function readBoundedJson(response, maximumBytes, status = response.status ?? response.statusCode) {
  let text;
  if (typeof response.text === "function") text = await response.text();
  else if (typeof response.body === "string" || Buffer.isBuffer(response.body)) text = String(response.body);
  else if (response.body?.[Symbol.asyncIterator] || response?.[Symbol.asyncIterator]) {
    const stream = response.body?.[Symbol.asyncIterator] ? response.body : response;
    const chunks = []; let size = 0;
    for await (const chunk of stream) { size += Buffer.byteLength(chunk); if (size > maximumBytes) { response.destroy?.(); securityFail("Provider response body is too large."); } chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
    text = Buffer.concat(chunks).toString("utf8");
  } else text = "";
  if (Buffer.byteLength(text) > maximumBytes) securityFail("Provider response body is too large.");
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { securityFail("Provider response is not valid JSON."); }
  return { status, headers: response.headers, json };
}

export async function safeProviderJsonRequest(input = {}) {
  const controller = new AbortController();
  const resources = new Map();
  const cancel = () => {
    for (const [resource, release] of resources) {
      release?.();
      try { resource?.destroy?.(); } catch { /* cancellation is best effort */ }
    }
    resources.clear();
    controller.abort();
  };
  const operation = { signal: controller.signal, track(resource, release) { if (resource) resources.set(resource, release); } };
  const work = (async () => {
    let target = await assertSafeProviderUrl(input.url, { lookup: input.lookup });
    const maximumRedirects = Math.min(2, Math.max(0, Number.isFinite(input.maximum_redirects) ? input.maximum_redirects : 2));
    const maximumBytes = Math.min(1_000_000, Math.max(0, Number.isFinite(input.maximum_bytes) ? input.maximum_bytes : 1_000_000));
    for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
      const response = await requestPinnedHttps(target, input, operation);
      const status = response.status ?? response.statusCode;
      if (!REDIRECT_STATUSES.has(status)) return readBoundedJson(response, maximumBytes, status);
      const location = response.headers?.get?.("location") ?? response.headers?.location;
      if (!location) securityFail("Provider redirect has no location.");
      response.destroy?.();
      const next = new URL(location, target);
      if (next.origin !== target.origin) securityFail("Cross-origin redirects are not allowed.");
      target = await assertSafeProviderUrl(next, { lookup: input.lookup });
    }
    securityFail("Too many redirects.");
  })();
  return timeoutRace(work, input.timeout_ms ?? 10_000, cancel);
}
