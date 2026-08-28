import { DomainError } from "../domain/errors.js";

function fail(message, field = "base_url") {
  throw new DomainError("VALIDATION_FAILED", message, { field });
}

export function normalizeProviderBaseUrl(value) {
  const input = String(value ?? "").trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(input) ? input : `https://${input}`;
  let url;
  try { url = new URL(candidate); } catch { fail("API 地址格式不正确。", "base_url"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail("API 地址必须是安全的 HTTPS 地址。", "base_url");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

export function modelDiscoveryCandidates(baseUrl) {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  const url = new URL(normalized);
  const path = url.pathname.replace(/\/+$/u, "");
  const paths = path === "/v1" || path.endsWith("/v1") ? [`${path}/models`] : [`${path}/v1/models`, `${path}/models`];
  return paths.map((candidate) => new URL(candidate, url.origin).toString());
}
