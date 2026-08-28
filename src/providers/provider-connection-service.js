import { DomainError } from "../domain/errors.js";
import { EXTERNAL_PROVIDER_ID } from "./constants.js";

const API_KEY_FIELDS = Object.freeze([{ id: "api_key", label: "API Key", secret: true, required: true }]);
const SAFE_FAILURE_CODES = new Set([
  "AUTHENTICATION_FAILED", "UPSTREAM_UNREACHABLE", "UPSTREAM_SECURITY_REJECTED", "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE", "UPSTREAM_SCHEMA_UNRECOGNIZED", "PLATFORM_UNSUPPORTED", "SETUP_CANCELLED",
  "SETUP_INVALID", "CREDENTIAL_SETUP_FAILED", "CREDENTIAL_STORE_DENIED", "CONNECTION_TEST_FAILED", "REQUEST_TIMEOUT",
]);

function fail(message, field) { throw new DomainError("VALIDATION_FAILED", message, { field }); }
function safeCode(value) { return typeof value === "string" && SAFE_FAILURE_CODES.has(value) ? value : "CONNECTION_TEST_FAILED"; }
function modern(connection, connectionId) {
  if (!connection) throw new DomainError("NOT_FOUND", `Unknown connection: ${connectionId}.`, { connection_id: connectionId });
  if (connection.legacy === true || connection.provider_id !== EXTERNAL_PROVIDER_ID) fail("This operation is available only for modern external API connections.", "connection_id");
  return connection;
}
async function requireModernDraft(connectionStore, connectionId) {
  if (typeof connectionId !== "string" || !connectionId) fail("connection_id is required.", "connection_id");
  return modern(await connectionStore.get(connectionId), connectionId);
}
function requiredService(object, method, label) { if (!object || typeof object[method] !== "function") throw new TypeError(`${label}.${method} is required`); }

export function createProviderConnectionService({ connectionStore, credentialService, discoveryService, adapterRegistry } = {}) {
  requiredService(connectionStore, "createDraft", "connectionStore");
  requiredService(connectionStore, "get", "connectionStore");
  requiredService(connectionStore, "completeDiscovery", "connectionStore");
  requiredService(connectionStore, "failDiscovery", "connectionStore");
  requiredService(connectionStore, "replaceCatalog", "connectionStore");
  requiredService(connectionStore, "updateModern", "connectionStore");
  requiredService(connectionStore, "remove", "connectionStore");
  requiredService(credentialService, "configure", "credentialService");
  requiredService(credentialService, "read", "credentialService");
  requiredService(credentialService, "clear", "credentialService");
  requiredService(discoveryService, "discover", "discoveryService");
  requiredService(adapterRegistry, "get", "adapterRegistry");

  async function validatedDiscovery(connection, credential) {
    const result = await discoveryService.discover({ base_url: connection.base_url, credential });
    // The registry assertion prevents a discovery service from persisting an untrusted adapter label.
    adapterRegistry.get(result?.adapter_id, result?.adapter_version);
    return result;
  }

  async function configureAndDiscover({ connection_id, onState } = {}) {
    const draft = await requireModernDraft(connectionStore, connection_id);
    let recognized;
    let hadCredential = false;
    if (typeof credentialService.status === "function") {
      const status = await credentialService.status({ credential_ref: draft.credential_ref }).catch(() => null);
      hadCredential = status?.status === "connected";
    }
    let configured;
    try {
      configured = await credentialService.configure({
        connection_id: draft.credential_ref,
        fields: API_KEY_FIELDS,
        onState,
        validate: async (credential) => {
          recognized = await validatedDiscovery(draft, credential);
          return { accepted: true, code: recognized.catalog.models.length ? "CONNECTED" : "NO_MODELS" };
        },
      });
    } catch (error) {
      return connectionStore.failDiscovery(connection_id, { code: safeCode(error?.code) });
    }
    if (!recognized || configured?.status !== "connected") return connectionStore.failDiscovery(connection_id, { code: safeCode(configured?.code) });
    const completed = await connectionStore.completeDiscovery(connection_id, recognized);
    // Replacing an already present key invalidates old execution snapshots only after both writes succeed.
    return hadCredential ? connectionStore.markCredentialsChanged(connection_id) : completed;
  }

  async function rediscover({ connection_id } = {}) {
    const connection = await requireModernDraft(connectionStore, connection_id);
    try {
      const credential = await credentialService.read({ credential_ref: connection.credential_ref });
      const recognized = await validatedDiscovery(connection, credential);
      return connectionStore.completeDiscovery(connection_id, recognized);
    } catch (error) {
      return connectionStore.failDiscovery(connection_id, { code: safeCode(error?.code) });
    }
  }

  async function refreshModels({ connection_id } = {}) {
    const connection = await requireModernDraft(connectionStore, connection_id);
    try {
      const credential = await credentialService.read({ credential_ref: connection.credential_ref });
      const recognized = await validatedDiscovery(connection, credential);
      if (recognized.adapter_id === connection.adapter_id && recognized.adapter_version === connection.adapter_version) {
        return connectionStore.replaceCatalog(connection_id, recognized.catalog);
      }
      return connectionStore.completeDiscovery(connection_id, recognized);
    } catch (error) {
      // A failed model refresh must leave the last known catalog usable.
      return connectionStore.failDiscovery(connection_id, { code: safeCode(error?.code) });
    }
  }

  async function remove({ connection_id } = {}) {
    const connection = await requireModernDraft(connectionStore, connection_id);
    let cleared;
    try { cleared = await credentialService.clear({ credential_ref: connection.credential_ref }); }
    catch (error) { throw new DomainError(safeCode(error?.code), "Credential cleanup failed.", { connection_id }); }
    if (cleared?.status !== "setup_required" || cleared?.code !== "SETUP_REQUIRED") {
      throw new DomainError(safeCode(cleared?.code), "Credential cleanup failed.", { connection_id });
    }
    return connectionStore.remove(connection_id);
  }

  return Object.freeze({
    createDraft: (input) => connectionStore.createDraft(input),
    update: ({ connection_id, ...patch } = {}) => connectionStore.updateModern(connection_id, patch),
    configureAndDiscover,
    rediscover,
    refreshModels,
    remove,
  });
}
