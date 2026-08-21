import { DomainError } from "../domain/errors.js";
import { MODEL_CAPABILITIES } from "../domain/model-capabilities.js";
import { OFFICIAL_MODEL_IDS } from "./capability-normalizer.js";
import { PROBE_POLICY_VERSION, PROBE_RESULT_TTL_MS } from "./constants.js";

const SUMMARY_KEYS = [
  "authenticated", "capability_status", "checked_at", "expires_at",
  "policy_version", "reachable", "service_version", "workbench_models",
];
const ROW_KEYS = ["availability", "mode", "name"];
const CANONICAL_UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function hasExactKeys(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalMilliseconds(value) {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function invalidSummary() {
  return new DomainError(
    "UPSTREAM_SCHEMA_UNRECOGNIZED",
    "normalized probe summary was invalid",
  );
}

function validateAndCopy(value) {
  if (!hasExactKeys(value, SUMMARY_KEYS)
    || value.reachable !== true
    || value.authenticated !== true
    || value.service_version !== null
    || !["available", "unknown"].includes(value.capability_status)
    || value.policy_version !== PROBE_POLICY_VERSION) {
    throw invalidSummary();
  }

  const checkedAtMs = canonicalMilliseconds(value.checked_at);
  const expiresAtMs = canonicalMilliseconds(value.expires_at);
  if (checkedAtMs === null || expiresAtMs === null
    || expiresAtMs - checkedAtMs !== PROBE_RESULT_TTL_MS) {
    throw invalidSummary();
  }

  const models = [...MODEL_CAPABILITIES];
  if (!Array.isArray(value.workbench_models)
    || value.workbench_models.length !== models.length) {
    throw invalidSummary();
  }

  const workbenchModels = value.workbench_models.map((row, index) => {
    const [name, capability] = models[index];
    const officialId = OFFICIAL_MODEL_IDS[name];
    const availabilityValid = value.capability_status === "unknown"
      ? row?.availability === "unknown"
      : officialId === null
        ? row?.availability === "unknown"
        : ["available", "unavailable"].includes(row?.availability);
    if (!hasExactKeys(row, ROW_KEYS)
      || row.name !== name
      || row.mode !== capability.mode
      || !availabilityValid) {
      throw invalidSummary();
    }
    return { name, mode: capability.mode, availability: row.availability };
  });

  return {
    reachable: true,
    authenticated: true,
    service_version: null,
    capability_status: value.capability_status,
    workbench_models: workbenchModels,
    checked_at: value.checked_at,
    expires_at: value.expires_at,
    policy_version: PROBE_POLICY_VERSION,
  };
}

export function copyValidatedProbeSummary(value) {
  try {
    return validateAndCopy(value);
  } catch {
    throw invalidSummary();
  }
}
