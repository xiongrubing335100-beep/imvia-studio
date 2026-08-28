import { DomainError } from "../domain/errors.js";

function fail(message, field) {
  throw new DomainError("VALIDATION_FAILED", message, { field });
}

function withDiscoveryTime(result, now) {
  const catalog = Object.freeze({ ...result.catalog, discovered_at: now() });
  return Object.freeze({ ...result, catalog });
}

export function createProviderDiscoveryService({ adapterRegistry, request, now = () => new Date().toISOString() } = {}) {
  if (!adapterRegistry || typeof adapterRegistry.discover !== "function") fail("Adapter registry is required.", "adapterRegistry");
  if (request !== undefined && typeof request !== "function") fail("Discovery request must be a function.", "request");
  if (typeof now !== "function") fail("Discovery clock must be a function.", "now");
  return Object.freeze({
    async discover(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) fail("Discovery input must be an object.", "input");
      const { base_url, credential } = input;
      return withDiscoveryTime(await adapterRegistry.discover({ base_url, credential }), now);
    },
  });
}
