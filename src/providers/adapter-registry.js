import { DomainError } from "../domain/errors.js";
import { normalizeModelCatalog } from "./model-catalog.js";
import { PROVIDER_ID_PATTERN } from "./constants.js";

const DISCOVERY_ADAPTER_METHODS = Object.freeze([
  "discover",
  "classifyModel",
  "estimateCost",
  "validateConnection",
  "submit",
  "poll",
  "cancel",
  "importResults",
]);

function fail(message, field, details = {}) {
  throw new DomainError("VALIDATION_FAILED", message, { field, ...details });
}

function discoveryInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Discovery input must be an object.", "input");
  if (typeof input.base_url !== "string" || !input.base_url.trim()) fail("Discovery base_url is required.", "input.base_url");
  if (!input.credential || typeof input.credential !== "object" || Array.isArray(input.credential)) fail("Discovery credential is required.", "input.credential");
  return { base_url: input.base_url, credential: input.credential };
}

export function validateDiscoveryAdapter(adapter, field = "adapter") {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) fail("Discovery adapter is required.", field);
  if (typeof adapter.id !== "string" || !PROVIDER_ID_PATTERN.test(adapter.id)) fail("Discovery adapter id is invalid.", `${field}.id`);
  if (typeof adapter.version !== "string" || !adapter.version.trim() || adapter.version.length > 64) fail("Discovery adapter version is invalid.", `${field}.version`);
  for (const method of DISCOVERY_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") fail(`Discovery adapter method ${method} is required.`, `${field}.${method}`);
  }
  return Object.freeze({
    id: adapter.id,
    version: adapter.version,
    discover: adapter.discover,
    classifyModel: adapter.classifyModel,
    estimateCost: adapter.estimateCost,
    validateConnection: adapter.validateConnection,
    submit: adapter.submit,
    poll: adapter.poll,
    cancel: adapter.cancel,
    importResults: adapter.importResults,
  });
}

export function publicAdapterMetadata(adapter) {
  return Object.freeze({ id: adapter.id, version: adapter.version });
}

export function notFound(id, version) {
  throw new DomainError("NOT_FOUND", "The requested provider adapter is not registered.", { adapter_id: id, adapter_version: version });
}

export function recoverableMiss(error) {
  if (error?.code === "UPSTREAM_SCHEMA_UNRECOGNIZED" || error?.code === "NOT_FOUND") return undefined;
  throw error;
}

export function normalizeDiscovery(adapter, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "该 API 暂不支持自动识别。");
  }
  const { protocol, provider_label, models_endpoint, entries } = result;
  if (typeof protocol !== "string" || !protocol || typeof provider_label !== "string" || !provider_label || typeof models_endpoint !== "string" || !models_endpoint || !Array.isArray(entries)) {
    throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "该 API 暂不支持自动识别。");
  }
  return Object.freeze({
    protocol,
    adapter_id: adapter.id,
    adapter_version: adapter.version,
    provider_label,
    models_endpoint,
    catalog: normalizeModelCatalog({ entries, classify: adapter.classifyModel }),
  });
}

export function createAdapterRegistry({ adapters = [] } = {}) {
  if (!Array.isArray(adapters)) fail("Discovery adapters must be an array.", "adapters");
  const entries = new Map();
  const ids = new Set();
  for (const input of adapters) {
    const adapter = validateDiscoveryAdapter(input);
    if (ids.has(adapter.id)) fail("Discovery adapter is already registered.", "adapter.id", { adapter_id: adapter.id });
    ids.add(adapter.id);
    entries.set(`${adapter.id}@${adapter.version}`, adapter);
  }
  return Object.freeze({
    list: () => Object.freeze([...entries.values()].map(publicAdapterMetadata)),
    get: (id, version) => entries.get(`${id}@${version}`) ?? notFound(id, version),
    async discover(input) {
      const trustedInput = discoveryInput(input);
      for (const adapter of entries.values()) {
        const result = await adapter.discover(trustedInput).catch(recoverableMiss);
        if (result) return normalizeDiscovery(adapter, result);
      }
      throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "该 API 暂不支持自动识别。");
    },
  });
}
