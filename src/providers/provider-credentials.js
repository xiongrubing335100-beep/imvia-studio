import { DomainError } from "../domain/errors.js";
import { CREDENTIAL_FIELD_ID_PATTERN } from "./constants.js";

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PUBLIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SUPPORTED_STATUSES = new Set(["connected", "setup_required", "not_connected", "unsupported"]);
const PUBLIC_STATES = new Set(["validating"]);
const PUBLIC_CODES = new Set([
  "CONNECTED", "SETUP_REQUIRED", "SETUP_CANCELLED", "SETUP_INVALID", "HELPER_NOT_PACKAGED",
  "HELPER_LAUNCH_FAILED", "CREDENTIAL_STORE_DENIED", "PLATFORM_UNSUPPORTED",
  "UPSTREAM_SECURITY_REJECTED", "AUTHENTICATION_FAILED", "UPSTREAM_UNREACHABLE",
  "CREDENTIAL_SETUP_FAILED",
]);

function fail(message, field, value) {
  throw new DomainError("VALIDATION_FAILED", message, { field, ...(value === undefined ? {} : { value }) });
}

function profileId(value, field) {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value) || value === "." || value === "..") {
    fail("Credential profile id is invalid.", field, value);
  }
  return value;
}

function credentialFields(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) fail("Credential fields are required.", "fields");
  const seen = new Set();
  return value.map((field, index) => {
    if (!field || typeof field !== "object" || Array.isArray(field)
      || Object.keys(field).some((key) => !["id", "label", "secret", "required"].includes(key))
      || typeof field.id !== "string" || !CREDENTIAL_FIELD_ID_PATTERN.test(field.id) || seen.has(field.id)
      || typeof field.label !== "string" || !field.label.trim() || field.label.trim().length > 128
      || typeof field.secret !== "boolean" || typeof field.required !== "boolean") {
      fail("Credential field is invalid.", `fields.${index}`);
    }
    seen.add(field.id);
    return { id: field.id, label: field.label.trim(), secret: field.secret, required: field.required };
  });
}

function supported(platform, arch) {
  return (platform === "darwin" || platform === "win32") && (arch === "arm64" || arch === "x64");
}

function code(value, fallback) { return typeof value === "string" && PUBLIC_CODE_PATTERN.test(value) && PUBLIC_CODES.has(value) ? value : fallback; }

function redacted(value, credentialRef, fallback = "SETUP_REQUIRED") {
  const status = SUPPORTED_STATUSES.has(value?.status) ? value.status : "setup_required";
  return {
    status,
    code: code(value?.code, status === "connected" ? "CONNECTED" : fallback),
    ...(typeof value?.checked_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.checked_at) ? { checked_at: value.checked_at } : {}),
    credential_ref: credentialRef,
  };
}

function safeValues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Credential profile is unavailable.");
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!CREDENTIAL_FIELD_ID_PATTERN.test(key) || typeof item !== "string" || !item.trim()) throw new Error("Credential profile is unavailable.");
    output[key] = item.trim();
  }
  if (!Object.keys(output).length) throw new Error("Credential profile is unavailable.");
  return output;
}

export function createProviderCredentialService({ helperClient, platform = process.platform, arch = process.arch } = {}) {
  if (!helperClient || typeof helperClient !== "object") throw new TypeError("helperClient is required");

  return Object.freeze({
    async status({ credential_ref } = {}) {
      const credentialRef = profileId(credential_ref, "credential_ref");
      if (!supported(platform, arch)) return { status: "unsupported", code: "PLATFORM_UNSUPPORTED", credential_ref: credentialRef };
      try { return redacted(await helperClient.status({ profileId: credentialRef }), credentialRef); }
      catch (error) { return redacted({ status: "setup_required", code: code(error?.code, "HELPER_LAUNCH_FAILED") }, credentialRef); }
    },
    async configure({ connection_id, fields, validate, onState } = {}) {
      const credentialRef = profileId(connection_id, "connection_id");
      const normalizedFields = credentialFields(fields);
      if (typeof validate !== "function") throw new TypeError("validate is required");
      if (!supported(platform, arch)) return { status: "unsupported", code: "PLATFORM_UNSUPPORTED", credential_ref: credentialRef };
      try {
        const result = await helperClient.configure({
          profileId: credentialRef,
          fields: normalizedFields,
          onState: (state) => { if (typeof onState === "function" && PUBLIC_STATES.has(state)) onState(state); },
          validate: async (values) => {
            const verdict = await validate(safeValues(values));
            if (!verdict || typeof verdict.accepted !== "boolean") return { accepted: false, code: "SETUP_INVALID" };
            return {
              accepted: verdict.accepted,
              code: code(verdict.code, verdict.accepted ? "CONNECTED" : "AUTHENTICATION_FAILED"),
            };
          },
        });
        return redacted(result, credentialRef);
      } catch (error) {
        return redacted({ status: "setup_required", code: code(error?.code, "HELPER_LAUNCH_FAILED") }, credentialRef);
      }
    },
    async read({ credential_ref } = {}) {
      const credentialRef = profileId(credential_ref, "credential_ref");
      if (!supported(platform, arch)) {
        const error = new Error("Credential profiles are unavailable on this platform.");
        error.code = "PLATFORM_UNSUPPORTED";
        throw error;
      }
      return safeValues(await helperClient.read({ profileId: credentialRef }));
    },
    async clear({ credential_ref } = {}) {
      const credentialRef = profileId(credential_ref, "credential_ref");
      if (!supported(platform, arch)) return { status: "unsupported", code: "PLATFORM_UNSUPPORTED", credential_ref: credentialRef };
      try { return redacted(await helperClient.clear({ profileId: credentialRef }), credentialRef); }
      catch (error) { return redacted({ status: "setup_required", code: code(error?.code, "CREDENTIAL_STORE_DENIED") }, credentialRef); }
    },
  });
}
