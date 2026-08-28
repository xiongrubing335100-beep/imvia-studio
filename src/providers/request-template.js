import { DomainError } from "../domain/errors.js";
import { isForbiddenAddress } from "./safe-provider-http.js";

const TOKEN = /^\{\{([a-z_]+(?:\.[a-zA-Z0-9_-]+)?)\}\}$/u;
const TOKEN_ALL = /\{\{([a-z_]+(?:\.[a-zA-Z0-9_-]+)?)\}\}/gu;

function fail(message, field) {
  throw new DomainError("VALIDATION_FAILED", message, { field });
}

function scalar(value, field) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") fail("Template values must be scalar.", field);
  return value;
}

function resolveToken(expression, { snapshot, credential, attachments }, field, { allowAttachment = false } = {}) {
  const match = expression.match(TOKEN);
  if (!match) fail("Template token is invalid.", field);
  const [, reference] = match;
  const [scope, id] = reference.split(".");
  if (!id || !["snapshot", "credential", "attachment"].includes(scope)) fail("Template token is not allowed.", field);
  if (scope === "attachment") {
    if (!allowAttachment) fail("Attachment tokens are only allowed in multipart file fields.", field);
    const attachment = Array.isArray(attachments) ? attachments.find((item) => item?.id === id || item?.handle === id) : attachments?.[id];
    if (!attachment || typeof attachment !== "object") fail("Template attachment is unavailable.", field);
    return attachment;
  }
  const source = scope === "snapshot" ? snapshot : credential;
  if (!source || typeof source !== "object" || !Object.hasOwn(source, id)) fail("Template token is not declared.", field);
  return scalar(source[id], field);
}

function renderString(value, values, field) {
  if (typeof value !== "string") return value;
  const unmatchedDelimiters = value.replace(TOKEN_ALL, "");
  if (unmatchedDelimiters.includes("{{") || unmatchedDelimiters.includes("}}")) fail("Template token is invalid.", field);
  const exact = value.match(TOKEN);
  if (exact) return resolveToken(value, values, field);
  return value.replace(TOKEN_ALL, (whole) => {
    const resolved = resolveToken(whole, values, field);
    if (resolved && typeof resolved === "object") fail("Attachment tokens are only allowed in multipart file fields.", field);
    return String(resolved);
  });
}

function renderJson(value, values, field = "body") {
  if (Array.isArray(value)) return value.map((item, index) => renderJson(item, values, `${field}.${index}`));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = renderJson(item, values, `${field}.${key}`);
    return output;
  }
  return renderString(value, values, field);
}

function valueContainsToken(value, token) {
  if (typeof value === "string") return value.includes(token);
  if (Array.isArray(value)) return value.some((item) => valueContainsToken(item, token));
  // Request-template rendering only evaluates values. Object property names
  // are opaque JSON keys and must never opt a connection into a capability.
  if (value && typeof value === "object") return Object.values(value).some((item) => valueContainsToken(item, token));
  return false;
}

export function requestTemplateUsesSnapshotToken(operation, snapshotField) {
  const definition = operation?.request && typeof operation.request === "object" ? operation.request : operation;
  const token = `{{snapshot.${snapshotField}}}`;
  if (!definition || typeof definition !== "object") return false;
  // Keep these checks aligned with renderRequestTemplate.  Multipart field
  // values are rendered as direct strings, while multipart files accept only
  // attachment tokens and never render snapshot values.
  return (typeof definition.path === "string" && definition.path.includes(token))
    || Object.values(definition.headers ?? {}).some((value) => typeof value === "string" && value.includes(token))
    || valueContainsToken(definition.body, token)
    || Object.values(definition.multipart?.fields ?? {}).some((value) => typeof value === "string" && value.includes(token));
}

function fileFor(attachment, field) {
  const file = attachment.file ?? attachment.blob ?? attachment.data;
  if (!(file instanceof Blob)) fail("Multipart attachment must be a managed Blob.", field);
  return file;
}

function requestUrl(template, values) {
  if (typeof template.base_url !== "string" || !template.base_url) fail("Request template base_url is required.", "base_url");
  let base;
  try { base = new URL(template.base_url); } catch { fail("Request template base_url is invalid.", "base_url"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) fail("Request template base_url must be a credential-free HTTPS URL.", "base_url");
  if (!template.allow_private_network && isForbiddenAddress(base.hostname)) fail("Private network endpoints require allow_private_network.", "base_url");
  const path = template.path ?? "";
  if (typeof path !== "string") fail("Request template path must be a string.", "path");
  let url;
  const renderedPath = renderString(path, values, "path");
  try { url = new URL(renderedPath, base); } catch { fail("Request template path is invalid.", "path"); }
  if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password || url.hash) fail("Request template path must remain on the configured HTTPS origin.", "path");
  return url;
}

export function renderRequestTemplate({ template, snapshot = {}, credential = {}, attachments = [] } = {}) {
  if (!template || typeof template !== "object" || Array.isArray(template)) fail("Request template is required.", "template");
  const values = { snapshot, credential, attachments };
  const url = requestUrl(template, values);
  const method = typeof template.method === "string" ? template.method.toUpperCase() : "GET";
  if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD)$/u.test(method)) fail("Request method is not supported.", "method");
  const headers = {};
  if (template.headers !== undefined && (!template.headers || typeof template.headers !== "object" || Array.isArray(template.headers))) fail("Request headers must be an object.", "headers");
  for (const [name, value] of Object.entries(template.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || typeof value !== "string") fail("Request header is invalid.", `headers.${name}`);
    headers[name] = renderString(value, values, `headers.${name}`);
  }
  if (template.multipart !== undefined && template.body !== undefined) fail("A request cannot contain both JSON and multipart bodies.", "body");
  if (template.multipart !== undefined) {
    if (!template.multipart || typeof template.multipart !== "object" || Array.isArray(template.multipart)) fail("Multipart template must be an object.", "multipart");
    const body = new FormData();
    for (const [name, value] of Object.entries(template.multipart.fields ?? {})) body.append(name, String(renderString(value, values, `multipart.fields.${name}`)));
    for (const [name, value] of Object.entries(template.multipart.files ?? {})) {
      const attachment = resolveToken(value, values, `multipart.files.${name}`, { allowAttachment: true });
      const file = fileFor(attachment, `multipart.files.${name}`);
      body.append(name, file, typeof attachment.filename === "string" ? attachment.filename : `${attachment.id ?? name}.bin`);
    }
    return { url: String(url), method, headers, body };
  }
  if (template.body === undefined) return { url: String(url), method, headers, body: undefined };
  const body = JSON.stringify(renderJson(template.body, values));
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  return { url: String(url), method, headers, body };
}
