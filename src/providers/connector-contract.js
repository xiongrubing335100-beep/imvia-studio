import { DomainError } from "../domain/errors.js";
import {
  ADAPTER_METHODS,
  CREDENTIAL_FIELD_ID_PATTERN,
  MEDIA_CAPABILITIES,
  PROVIDER_ID_PATTERN,
  PROVIDER_KINDS,
} from "./constants.js";

const fail = (message, field, value) => {
  throw new DomainError("VALIDATION_FAILED", message, { field, ...(value === undefined ? {} : { value }) });
};

const freeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
};

export function validateAdapter(adapter, field = "adapter") {
  if (!adapter || typeof adapter !== "object") fail("Adapter is required.", field);
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") fail(`Adapter method ${method} is required.`, `${field}.${method}`);
  }
  const checked = {};
  for (const method of ADAPTER_METHODS) {
    checked[method] = (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) fail("Adapter methods require a request object.", `${field}.${method}.input`);
      for (const key of ["connection", "credential", "snapshot", "attachments", "onProgress"]) {
        if (!Object.hasOwn(input, key)) fail(`Adapter method input is missing ${key}.`, `${field}.${method}.input.${key}`);
      }
      const credentialValues = input.credential && typeof input.credential === "object" ? Object.values(input.credential).filter((value) => typeof value === "string" && value) : [];
      const redact = (result, path = "result") => {
        if (!result || typeof result !== "object") fail("Adapter result must be an object or array.", `${field}.${method}.${path}`);
        if (Array.isArray(result)) return result.map((value, index) => redactValue(value, `${path}.${index}`));
        const output = {};
        for (const [key, value] of Object.entries(result)) {
          if (/credential|secret|token|password|api[_-]?key/i.test(key)) continue;
          output[key] = redactValue(value, `${path}.${key}`);
        }
        return output;
      };
      const redactValue = (value, path) => {
        if (typeof value === "string") return credentialValues.reduce((text, credential) => text.split(credential).join("[REDACTED]"), value);
        if (value && typeof value === "object") return redact(value, path);
        return value;
      };
      const result = adapter[method](input);
      return result && typeof result.then === "function" ? result.then((value) => redact(value)) : redact(result);
    };
  }
  return Object.freeze(checked);
}

export function createProviderDescriptor(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Provider descriptor must be an object.", "descriptor");
  const { id, display_name, kind = "adapter", capabilities = [], models = [], adapter_id = null, credential_fields = [] } = input;
  if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) fail("Provider id is invalid.", "id", id);
  if (typeof display_name !== "string" || !display_name.trim()) fail("Provider display_name is required.", "display_name");
  if (!PROVIDER_KINDS.includes(kind)) fail("Provider kind is invalid.", "kind", kind);
  if (!Array.isArray(capabilities) || capabilities.some((capability) => !MEDIA_CAPABILITIES.includes(capability))) fail("Provider capabilities must be image or video.", "capabilities");
  const normalizedCapabilities = [...new Set(capabilities)];
  if (!Array.isArray(models)) fail("Provider models must be an array.", "models");
  const seenModels = new Set();
  const normalizedModels = models.map((model, index) => {
    const item = typeof model === "string" ? { id: model, display_name: model, capabilities: normalizedCapabilities } : model;
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim()) fail("Model id is required.", `models.${index}.id`);
    if (seenModels.has(item.id)) fail("Duplicate model id.", `models.${index}.id`, item.id);
    seenModels.add(item.id);
    const modelCapabilities = item.capabilities ?? item.modes ?? normalizedCapabilities;
    if (!Array.isArray(modelCapabilities) || modelCapabilities.some((capability) => !MEDIA_CAPABILITIES.includes(capability) || !normalizedCapabilities.includes(capability))) fail("Model capabilities must be supported by the provider.", `models.${index}.capabilities`);
    return { id: item.id, display_name: typeof item.display_name === "string" && item.display_name.trim() ? item.display_name : item.id, capabilities: [...new Set(modelCapabilities)] };
  });
  if (kind === "adapter" && (typeof adapter_id !== "string" || !PROVIDER_ID_PATTERN.test(adapter_id))) fail("adapter_id is required for adapter providers.", "adapter_id", adapter_id);
  if (kind === "generic_rest" && adapter_id !== null && (typeof adapter_id !== "string" || !PROVIDER_ID_PATTERN.test(adapter_id))) fail("adapter_id is invalid.", "adapter_id", adapter_id);
  if (kind === "generic_rest" && input.adapter !== undefined) fail("generic_rest providers cannot include an inline adapter.", "adapter");
  if (kind === "discovered" && adapter_id !== null) fail("discovered providers cannot have a fixed adapter.", "adapter_id", adapter_id);
  if (kind === "discovered" && normalizedModels.length) fail("discovered providers cannot have static models.", "models");
  if (kind === "discovered" && input.adapter !== undefined) fail("discovered providers cannot include an inline adapter.", "adapter");
  if (!Array.isArray(credential_fields)) fail("credential_fields must be an array.", "credential_fields");
  const seenCredentialFields = new Set();
  const normalizedFields = credential_fields.map((field, index) => {
    if (!field || typeof field !== "object") fail("Credential field must be an object.", `credential_fields.${index}`);
    const keys = Object.keys(field).sort();
    if (keys.some((key) => !["id", "label", "secret", "required"].includes(key))) fail("Credential field contains unsupported properties.", `credential_fields.${index}`);
    if (typeof field.id !== "string" || !CREDENTIAL_FIELD_ID_PATTERN.test(field.id)) fail("Credential field id is invalid.", `credential_fields.${index}.id`, field.id);
    if (seenCredentialFields.has(field.id)) fail("Duplicate credential field id.", `credential_fields.${index}.id`, field.id);
    seenCredentialFields.add(field.id);
    if (typeof field.label !== "string" || !field.label.trim() || typeof field.secret !== "boolean" || typeof field.required !== "boolean") fail("Credential field must contain id, label, secret, and required.", `credential_fields.${index}`);
    return { id: field.id, label: field.label, secret: field.secret, required: field.required };
  });
  const descriptor = { id, display_name: display_name.trim(), kind, capabilities: normalizedCapabilities, models: normalizedModels, adapter_id, credential_fields: normalizedFields };
  if (input.adapter !== undefined) validateAdapter(input.adapter, `provider.${id}.adapter`);
  return freeze(descriptor);
}

export function validateConnectionConfig(config = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("Connection config must be an object.", "config");
  const normalized = { ...config };
  if (typeof normalized.provider_id !== "string" || !PROVIDER_ID_PATTERN.test(normalized.provider_id)) fail("provider_id is invalid.", "provider_id", normalized.provider_id);
  if (normalized.base_url !== undefined) {
    if (typeof normalized.base_url !== "string") fail("base_url must be a string.", "base_url");
    try { const url = new URL(normalized.base_url); if (url.protocol !== "https:") fail("base_url must use HTTPS.", "base_url"); } catch { fail("base_url must be a valid URL.", "base_url"); }
  }
  return freeze(normalized);
}
