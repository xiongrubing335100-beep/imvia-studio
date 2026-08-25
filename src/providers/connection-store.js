import { randomUUID } from "node:crypto";

import { DomainError } from "../domain/errors.js";
import { JsonStore } from "../persistence/json-store.js";
import { validateConnectionConfig } from "./connector-contract.js";
import { EXTERNAL_PROVIDER_ID } from "./constants.js";
import { normalizeProviderBaseUrl } from "./provider-url.js";

// The schema advances in place: this remains the one authoritative connection file.
export const CONNECTION_STATE_FILE = "provider-connections-v1.json";
const SCHEMA_VERSION = "provider-connections-v2";
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_KEY = /^(?:credentials?|access_?key|secret(?:_?key)?|api_?key|token|password|client_?secret|private_?key)$/i;
const PUBLIC_TEST_STATUSES = new Set(["connected", "setup_required", "failed", "unsupported"]);
const PUBLIC_TEST_CODES = new Set(["CONNECTED", "SETUP_REQUIRED", "AUTHENTICATION_FAILED", "UPSTREAM_UNREACHABLE", "UPSTREAM_SECURITY_REJECTED", "UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_SCHEMA_UNRECOGNIZED", "PLATFORM_UNSUPPORTED", "VALIDATION_FAILED", "CONNECTION_TEST_FAILED", "REQUEST_TIMEOUT", "TEST_FAILED"]);
const DISCOVERY_CODES = new Set(["CONNECTED", "NO_MODELS", "AUTHENTICATION_FAILED", "UPSTREAM_UNREACHABLE", "UPSTREAM_SECURITY_REJECTED", "UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_SCHEMA_UNRECOGNIZED", "PLATFORM_UNSUPPORTED", "SETUP_CANCELLED", "SETUP_INVALID", "CREDENTIAL_SETUP_FAILED", "CONNECTION_TEST_FAILED", "REQUEST_TIMEOUT"]);

function fail(message, field, value) { throw new DomainError("VALIDATION_FAILED", message, { field, ...(value === undefined ? {} : { value }) }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function cleanName(value) { if (typeof value !== "string" || !value.trim() || value.trim().length > 128) fail("Connection name is required.", "name"); return value.trim(); }
function validateProfileId(value, field = "credential_ref") { if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value) || value === "." || value === "..") fail("Credential reference is invalid.", field, value); return value; }
function modernCredentialRef(connectionId) { return validateProfileId(`external-api-${connectionId}`, "connection_id"); }

function assertNoSecretInput(value, secretFieldIds = new Set(), path = "profile") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "credential_ref" && (SENSITIVE_KEY.test(key) || secretFieldIds.has(key.toLowerCase()))) fail("Secret values cannot be stored in a connection profile.", `${path}.${key}`);
    assertNoSecretInput(child, secretFieldIds, `${path}.${key}`);
  }
}
function jsonObject(value, field, fallback) { if (value === undefined) return clone(fallback); if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`, field); try { return clone(value); } catch { fail(`${field} must be JSON serializable.`, field); } }
function stringList(value, allowed, field) { if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || new Set(value).size !== value.length) fail(`${field} must be an array of unique strings.`, field); if (allowed && value.some((item) => !allowed.has(item))) fail(`${field} contains an unsupported value.`, field); return [...value]; }
function publicDescriptor(descriptor) { return clone({ id: descriptor.id, display_name: descriptor.display_name, kind: descriptor.kind, capabilities: descriptor.capabilities, models: descriptor.models, adapter_id: descriptor.adapter_id, credential_fields: descriptor.credential_fields }); }
function ensureRegistry(registry) { if (!registry || typeof registry.get !== "function") throw new TypeError("registry is required"); }
function notFound(connectionId) { throw new DomainError("NOT_FOUND", `Unknown connection: ${connectionId}.`, { connection_id: connectionId }); }
function isModern(connection) { return connection?.legacy !== true && connection?.provider_id === EXTERNAL_PROVIDER_ID; }
function requireModern(connection, connectionId) { if (!connection) return notFound(connectionId); if (!isModern(connection)) throw new DomainError("VALIDATION_FAILED", "This operation is available only for modern external API connections.", { field: "connection_id" }); return connection; }
function normalizeArgs(idOrInput, patch) { if (typeof idOrInput === "string") return { connectionId: idOrInput, patch: patch ?? {} }; if (idOrInput && typeof idOrInput === "object") { const { connection_id: connectionId, ...rest } = idOrInput; return { connectionId, patch: patch ?? rest }; } return { connectionId: undefined, patch: patch ?? {} }; }

function normalizeConfig(input, descriptor, existing = null) {
  const secretFieldIds = new Set(descriptor.credential_fields.filter((field) => field.secret).map((field) => field.id));
  assertNoSecretInput(input, secretFieldIds);
  validateConnectionConfig({ provider_id: descriptor.id, ...(input.base_url === undefined ? {} : { base_url: input.base_url }) });
  if (input.base_url !== undefined) { const baseUrl = new URL(input.base_url); if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) fail("base_url cannot contain credentials, query parameters, or fragments.", "base_url"); }
  const capabilities = input.capabilities === undefined ? clone(existing?.capabilities ?? descriptor.capabilities) : stringList(input.capabilities, new Set(descriptor.capabilities), "capabilities");
  const knownModels = new Set(descriptor.models.map((model) => model.id));
  const models = input.models === undefined ? clone(existing?.models ?? descriptor.models.map((model) => model.id)) : stringList(input.models, knownModels, "models");
  const enabled = input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled;
  if (typeof enabled !== "boolean") fail("enabled must be a boolean.", "enabled");
  return { name: cleanName(input.name === undefined ? existing?.name : input.name), provider_id: descriptor.id, provider_descriptor: publicDescriptor(descriptor), connector_type: descriptor.kind, capabilities, models, ...(input.base_url !== undefined || existing?.base_url !== undefined ? { base_url: input.base_url ?? existing.base_url } : {}), endpoint_mappings: jsonObject(input.endpoint_mappings, "endpoint_mappings", existing?.endpoint_mappings ?? {}), settings: jsonObject(input.settings, "settings", existing?.settings ?? {}), enabled };
}

function uniqueConnectionName(state, preferred, exceptId = null) {
  const name = cleanName(preferred);
  const existing = new Set(state.connections.filter((item) => item.connection_id !== exceptId).map((item) => String(item.name ?? "").toLocaleLowerCase("en-US")));
  if (!existing.has(name.toLocaleLowerCase("en-US"))) return name;
  for (let suffix = 2; suffix < 10_000; suffix += 1) { const candidate = `${name} ${suffix}`; if (!existing.has(candidate.toLocaleLowerCase("en-US"))) return candidate; }
  throw new DomainError("VALIDATION_FAILED", "A unique connection name could not be generated.", { field: "name" });
}
function modernCatalog(value) { if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.models) || typeof value.digest !== "string" || !value.digest || typeof value.discovered_at !== "string") fail("Discovery catalog is invalid.", "catalog"); return clone(value); }
function discoveryResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.protocol !== "string" || !value.protocol || typeof value.adapter_id !== "string" || !value.adapter_id || typeof value.adapter_version !== "string" || !value.adapter_version || typeof value.provider_label !== "string" || !value.provider_label || typeof value.models_endpoint !== "string" || !value.models_endpoint) fail("Discovery result is invalid.", "discovery");
  return { ...clone(value), catalog: modernCatalog(value.catalog) };
}
function safeDiscoveryCode(value, fallback = "CONNECTION_TEST_FAILED") { return typeof value === "string" && DISCOVERY_CODES.has(value) ? value : fallback; }

export function migrateConnectionsV2(state) {
  if (state?.schema_version === SCHEMA_VERSION) return { state, changed: false };
  const connections = Array.isArray(state?.connections) ? state.connections.map((connection) => ({ ...clone(connection), legacy: true })) : [];
  return { state: { schema_version: SCHEMA_VERSION, connections }, changed: true };
}

export function createConnectionStore({ dataDirectory, registry, now = () => Date.now(), id = randomUUID } = {}) {
  if (typeof dataDirectory !== "string" || !dataDirectory) throw new TypeError("dataDirectory is required");
  ensureRegistry(registry);
  const store = new JsonStore({ dataDirectory, stateFileName: CONNECTION_STATE_FILE, createInitialState: () => ({ schema_version: SCHEMA_VERSION, connections: [] }), migrateState: (state) => migrateConnectionsV2(state) });
  const timestamp = () => new Date(now()).toISOString();
  const find = (state, connectionId) => state.connections.find((item) => item.connection_id === connectionId);
  const replaceAt = (state, current, replacement) => { state.connections[state.connections.indexOf(current)] = replacement; return replacement; };
  const ensureUniqueName = (state, name, exceptId = null) => { const normalized = name.toLocaleLowerCase("en-US"); if (state.connections.some((item) => item.connection_id !== exceptId && item.name.toLocaleLowerCase("en-US") === normalized)) fail("Connection name is already in use.", "name", name); };

  return Object.freeze({
    async list() { return (await store.read()).connections; },
    async get(connectionId) { if (typeof connectionId !== "string") fail("connection_id is invalid.", "connection_id", connectionId); return (await store.read()).connections.find((item) => item.connection_id === connectionId) ?? null; },
    async create(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) fail("Connection profile must be an object.", "profile");
      const descriptor = registry.get(input.provider_id); const connectionId = id(); if (typeof connectionId !== "string" || !connectionId) throw new Error("Connection id generator returned an invalid id.");
      const config = normalizeConfig(input, descriptor); const credentialRef = validateProfileId(input.credential_ref ?? connectionId);
      return store.update((state) => { ensureUniqueName(state, config.name); const createdAt = timestamp(); const profile = { connection_id: connectionId, ...config, credential_ref: credentialRef, legacy: true, config_revision: 1, created_at: createdAt, updated_at: createdAt, last_test: null }; state.connections.push(profile); return profile; });
    },
    async update(idOrInput, maybePatch) {
      const { connectionId, patch } = normalizeArgs(idOrInput, maybePatch);
      if (typeof connectionId !== "string" || !patch || typeof patch !== "object" || Array.isArray(patch)) fail("Connection update is invalid.", "connection_id");
      if (patch.connection_id !== undefined || patch.provider_id !== undefined || patch.credential_ref !== undefined) fail("Connection identity fields cannot be updated.", "connection_id");
      return store.update((state) => { const current = find(state, connectionId); if (!current) return notFound(connectionId); if (isModern(current)) throw new DomainError("VALIDATION_FAILED", "Modern connections must use the discovery lifecycle.", { field: "connection_id" }); const descriptor = registry.get(current.provider_id); const config = normalizeConfig(patch, descriptor, current); ensureUniqueName(state, config.name, connectionId); return replaceAt(state, current, { ...current, ...config, connection_id: current.connection_id, credential_ref: current.credential_ref, legacy: true, config_revision: current.config_revision + 1, created_at: current.created_at, updated_at: timestamp() }); });
    },
    async remove(idOrInput) { const connectionId = typeof idOrInput === "string" ? idOrInput : idOrInput?.connection_id; if (typeof connectionId !== "string") fail("connection_id is invalid.", "connection_id", connectionId); return store.update((state) => { const index = state.connections.findIndex((item) => item.connection_id === connectionId); if (index === -1) return notFound(connectionId); return state.connections.splice(index, 1)[0]; }); },
    async markTested(idOrInput, maybeResult) {
      const connectionId = typeof idOrInput === "string" ? idOrInput : idOrInput?.connection_id; const result = typeof idOrInput === "string" ? maybeResult : maybeResult ?? idOrInput?.result ?? idOrInput?.test;
      if (typeof connectionId !== "string" || !result || typeof result !== "object" || !PUBLIC_TEST_STATUSES.has(result.status) || !PUBLIC_TEST_CODES.has(result.code)) fail("Connection test result is invalid.", "result");
      return store.update((state) => { const current = find(state, connectionId); if (!current) return notFound(connectionId); current.last_test = { status: result.status, code: result.code, tested_at: timestamp() }; current.updated_at = current.last_test.tested_at; return current; });
    },
    async createDraft(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) fail("Connection draft must be an object.", "draft"); assertNoSecretInput(input);
      if (Object.hasOwn(input, "credential_ref")) fail("Modern connection credentials are managed internally.", "credential_ref");
      const connectionId = id(); if (typeof connectionId !== "string" || !connectionId) throw new Error("Connection id generator returned an invalid id.");
      const baseUrl = normalizeProviderBaseUrl(input.base_url); const requestedName = typeof input.name === "string" && input.name.trim() ? cleanName(input.name) : new URL(baseUrl).hostname; const nameSource = typeof input.name === "string" && input.name.trim() ? "user" : "hostname"; const descriptor = registry.get(EXTERNAL_PROVIDER_ID); const credentialRef = modernCredentialRef(connectionId);
      return store.update((state) => { const createdAt = timestamp(); const profile = { connection_id: connectionId, name: uniqueConnectionName(state, requestedName), name_source: nameSource, provider_id: EXTERNAL_PROVIDER_ID, provider_descriptor: publicDescriptor(descriptor), connector_type: descriptor.kind, base_url: baseUrl, credential_ref: credentialRef, legacy: false, status: "draft", enabled: false, protocol: null, adapter_id: null, adapter_version: null, provider_label: null, models_endpoint: null, config_revision: 1, model_catalog_revision: 0, model_catalog_digest: null, model_catalog: null, last_discovered_at: null, last_discovery: null, created_at: createdAt, updated_at: createdAt }; state.connections.push(profile); return profile; });
    },
    async updateModern(connectionId, patch = {}) {
      if (typeof connectionId !== "string" || !patch || typeof patch !== "object" || Array.isArray(patch)) fail("Modern connection update is invalid.", "connection_id");
      const allowed = new Set(["name", "base_url", "enabled"]);
      if (Object.keys(patch).some((key) => !allowed.has(key))) fail("Modern connection update contains unsupported fields.", "connection_id");
      return store.update((state) => {
        const current = requireModern(find(state, connectionId), connectionId);
        const nameChanged = patch.name !== undefined;
        const enabledChanged = patch.enabled !== undefined;
        if (enabledChanged && typeof patch.enabled !== "boolean") fail("enabled must be a boolean.", "enabled");
        const baseUrl = patch.base_url === undefined ? current.base_url : normalizeProviderBaseUrl(patch.base_url);
        const addressChanged = baseUrl !== current.base_url;
        const nameSource = nameChanged ? "user" : current.name_source;
        const requestedName = nameChanged ? cleanName(patch.name) : current.name;
        const name = nameChanged ? uniqueConnectionName(state, requestedName, connectionId) : current.name;
        if (enabledChanged && patch.enabled === true && (current.status !== "connected" || !Array.isArray(current.model_catalog?.models) || current.model_catalog.models.length === 0)) fail("A modern connection can be enabled only after successful model discovery.", "enabled");
        if (!addressChanged && !nameChanged && !enabledChanged) return current;
        const updated = { ...current, name, name_source: nameSource, ...(enabledChanged ? { enabled: patch.enabled } : {}), updated_at: timestamp() };
        if (!addressChanged) return replaceAt(state, current, updated);
        return replaceAt(state, current, {
          ...updated, base_url: baseUrl, status: "draft", enabled: false,
          model_catalog: null, model_catalog_digest: null, model_catalog_revision: current.model_catalog_revision + 1,
          last_discovered_at: null, last_discovery: null, config_revision: current.config_revision + 1,
        });
      });
    },
    async completeDiscovery(connectionId, result) {
      if (typeof connectionId !== "string") fail("connection_id is invalid.", "connection_id", connectionId); const discovery = discoveryResult(result);
      return store.update((state) => { const current = requireModern(find(state, connectionId), connectionId); const adapterChanged = current.adapter_id !== discovery.adapter_id || current.adapter_version !== discovery.adapter_version; const hasModels = discovery.catalog.models.length > 0; return replaceAt(state, current, { ...current, status: hasModels ? "connected" : "no_models", enabled: hasModels, protocol: discovery.protocol, adapter_id: discovery.adapter_id, adapter_version: discovery.adapter_version, provider_label: discovery.provider_label, models_endpoint: discovery.models_endpoint, model_catalog: discovery.catalog, model_catalog_digest: discovery.catalog.digest, model_catalog_revision: current.model_catalog_revision + 1, config_revision: current.config_revision + (adapterChanged ? 1 : 0), last_discovered_at: discovery.catalog.discovered_at, last_discovery: { status: hasModels ? "connected" : "no_models", code: hasModels ? "CONNECTED" : "NO_MODELS" }, updated_at: timestamp() }); });
    },
    async failDiscovery(connectionId, result = {}) { if (typeof connectionId !== "string") fail("connection_id is invalid.", "connection_id", connectionId); return store.update((state) => { const current = requireModern(find(state, connectionId), connectionId); const code = safeDiscoveryCode(result?.code); const retainsUsableCatalog = current.status === "connected" && current.enabled === true && Array.isArray(current.model_catalog?.models) && current.model_catalog.models.length > 0; return replaceAt(state, current, { ...current, status: retainsUsableCatalog ? "connected" : "failed", enabled: retainsUsableCatalog, last_discovery: { status: "failed", code }, updated_at: timestamp() }); }); },
    async replaceCatalog(connectionId, catalog) {
      if (typeof connectionId !== "string") fail("connection_id is invalid.", "connection_id", connectionId); const normalizedCatalog = modernCatalog(catalog);
      return store.update((state) => { const current = requireModern(find(state, connectionId), connectionId); const hasModels = normalizedCatalog.models.length > 0; return replaceAt(state, current, { ...current, model_catalog: normalizedCatalog, model_catalog_digest: normalizedCatalog.digest, model_catalog_revision: current.model_catalog_revision + 1, status: hasModels ? "connected" : "no_models", enabled: hasModels, last_discovered_at: normalizedCatalog.discovered_at, last_discovery: { status: hasModels ? "connected" : "no_models", code: hasModels ? "CONNECTED" : "NO_MODELS" }, updated_at: timestamp() }); });
    },
    async markCredentialsChanged(connectionId) { if (typeof connectionId !== "string") fail("connection_id is invalid.", "connection_id", connectionId); return store.update((state) => { const current = requireModern(find(state, connectionId), connectionId); return replaceAt(state, current, { ...current, config_revision: current.config_revision + 1, updated_at: timestamp() }); }); },
  });
}
