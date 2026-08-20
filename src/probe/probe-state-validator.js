import { DomainError } from "../domain/errors.js";
import {
  PROBE_AUTHORIZATION_TTL_MS,
  PROBE_POLICY_VERSION,
} from "./constants.js";
import { copyValidatedProbeSummary } from "./summary-validator.js";

const ROOT_KEYS = ["attempts", "audit_events", "authorizations", "enabled", "version"];
const AUTHORIZATION_KEYS = [
  "consumed_at", "expires_at", "id", "idempotency_key", "issued_at",
  "kind", "policy_version", "reason", "source",
];
const ATTEMPT_KEYS = [
  "authorization_id", "completed_at", "error_code", "id",
  "idempotency_key", "result", "started_at", "status",
];
const STABLE_PROBE_ERRORS = new Set([
  "CREDENTIAL_REFERENCE_UNAVAILABLE", "UPSTREAM_UNREACHABLE",
  "UPSTREAM_SECURITY_REJECTED", "AUTHENTICATION_FAILED",
  "UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_SCHEMA_UNRECOGNIZED", "STORE_UNAVAILABLE",
]);
const CANONICAL_UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function unavailable() {
  return new DomainError("STORE_UNAVAILABLE", "Lovart probe state is unavailable");
}

function exactObject(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw unavailable();
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw unavailable();
  }
  return value;
}

function nonEmpty(value) {
  if (typeof value !== "string" || value.trim() === "" || value.trim() !== value) throw unavailable();
  return value;
}

function canonicalMilliseconds(value) {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) throw unavailable();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw unavailable();
  return milliseconds;
}

function validateAuthorizations(values) {
  if (!Array.isArray(values)) throw unavailable();
  const ids = new Set();
  const idempotencyKeys = new Set();
  const records = values.map((value) => {
    const record = exactObject(value, AUTHORIZATION_KEYS);
    const id = nonEmpty(record.id);
    const idempotencyKey = nonEmpty(record.idempotency_key);
    if (ids.has(id) || idempotencyKeys.has(idempotencyKey)) throw unavailable();
    ids.add(id);
    idempotencyKeys.add(idempotencyKey);
    if (record.kind !== "lovart_capability_probe"
      || record.source !== "user:current_session"
      || record.policy_version !== PROBE_POLICY_VERSION) {
      throw unavailable();
    }
    const reason = nonEmpty(record.reason);
    const issuedAtMs = canonicalMilliseconds(record.issued_at);
    const expiresAtMs = canonicalMilliseconds(record.expires_at);
    if (expiresAtMs - issuedAtMs !== PROBE_AUTHORIZATION_TTL_MS) throw unavailable();
    let consumedAt = null;
    if (record.consumed_at !== null) {
      const consumedAtMs = canonicalMilliseconds(record.consumed_at);
      if (consumedAtMs < issuedAtMs || consumedAtMs >= expiresAtMs) throw unavailable();
      consumedAt = record.consumed_at;
    }
    return {
      id,
      kind: "lovart_capability_probe",
      source: "user:current_session",
      reason,
      policy_version: PROBE_POLICY_VERSION,
      issued_at: record.issued_at,
      expires_at: record.expires_at,
      consumed_at: consumedAt,
      idempotency_key: idempotencyKey,
    };
  });
  return { records, byId: new Map(records.map((record) => [record.id, record])) };
}

function validateAttempts(values, authorizations) {
  if (!Array.isArray(values)) throw unavailable();
  const ids = new Set();
  const authorizationIds = new Set();
  const records = values.map((value) => {
    const record = exactObject(value, ATTEMPT_KEYS);
    const id = nonEmpty(record.id);
    const authorizationId = nonEmpty(record.authorization_id);
    const idempotencyKey = nonEmpty(record.idempotency_key);
    if (ids.has(id) || authorizationIds.has(authorizationId)) throw unavailable();
    ids.add(id);
    authorizationIds.add(authorizationId);
    const authorization = authorizations.get(authorizationId);
    if (!authorization) throw unavailable();
    const startedAtMs = canonicalMilliseconds(record.started_at);
    if (authorization.consumed_at !== record.started_at
      || startedAtMs >= Date.parse(authorization.expires_at)) {
      throw unavailable();
    }

    if (record.status === "pending") {
      if (record.completed_at !== null || record.result !== null || record.error_code !== null) throw unavailable();
      return {
        id, authorization_id: authorizationId, idempotency_key: idempotencyKey,
        status: "pending", started_at: record.started_at, completed_at: null,
        result: null, error_code: null,
      };
    }

    const completedAtMs = canonicalMilliseconds(record.completed_at);
    if (completedAtMs < startedAtMs) throw unavailable();
    if (record.status === "completed") {
      if (record.error_code !== null) throw unavailable();
      return {
        id, authorization_id: authorizationId, idempotency_key: idempotencyKey,
        status: "completed", started_at: record.started_at, completed_at: record.completed_at,
        result: copyValidatedProbeSummary(record.result), error_code: null,
      };
    }
    if (record.status === "failed") {
      if (record.result !== null || !STABLE_PROBE_ERRORS.has(record.error_code)) throw unavailable();
      return {
        id, authorization_id: authorizationId, idempotency_key: idempotencyKey,
        status: "failed", started_at: record.started_at, completed_at: record.completed_at,
        result: null, error_code: record.error_code,
      };
    }
    throw unavailable();
  });

  for (const authorization of authorizations.values()) {
    if ((authorization.consumed_at === null) === authorizationIds.has(authorization.id)) throw unavailable();
  }
  return { records, byId: new Map(records.map((record) => [record.id, record])) };
}

function validateAuditEvents(values, authorizations, attempts) {
  if (!Array.isArray(values)) throw unavailable();
  const authorizationCreated = new Map();
  const attemptClaimed = new Map();
  const attemptFinished = new Map();
  const records = values.map((value) => {
    if (!value || Array.isArray(value) || typeof value !== "object") throw unavailable();
    const type = value.type;
    if (type === "probe_enabled" || type === "probe_disabled") {
      exactObject(value, ["at", "type"]);
      canonicalMilliseconds(value.at);
      return { type, at: value.at };
    }
    if (type === "authorization_created") {
      exactObject(value, ["at", "authorization_id", "type"]);
      const authorization = authorizations.get(nonEmpty(value.authorization_id));
      if (!authorization || value.at !== authorization.issued_at
        || authorizationCreated.has(authorization.id)) throw unavailable();
      authorizationCreated.set(authorization.id, true);
      return { type, authorization_id: authorization.id, at: value.at };
    }
    if (type === "probe_claimed") {
      exactObject(value, ["at", "attempt_id", "authorization_id", "type"]);
      const attempt = attempts.get(nonEmpty(value.attempt_id));
      if (!attempt || value.authorization_id !== attempt.authorization_id
        || value.at !== attempt.started_at || attemptClaimed.has(attempt.id)) throw unavailable();
      attemptClaimed.set(attempt.id, true);
      return {
        type, authorization_id: attempt.authorization_id, attempt_id: attempt.id, at: value.at,
      };
    }
    if (type === "probe_completed") {
      exactObject(value, ["at", "attempt_id", "type"]);
      const attempt = attempts.get(nonEmpty(value.attempt_id));
      if (!attempt || attempt.status !== "completed" || value.at !== attempt.completed_at
        || attemptFinished.has(attempt.id)) throw unavailable();
      attemptFinished.set(attempt.id, true);
      return { type, attempt_id: attempt.id, at: value.at };
    }
    if (type === "probe_failed") {
      exactObject(value, ["at", "attempt_id", "code", "type"]);
      const attempt = attempts.get(nonEmpty(value.attempt_id));
      if (!attempt || attempt.status !== "failed" || value.code !== attempt.error_code
        || value.at !== attempt.completed_at || attemptFinished.has(attempt.id)) throw unavailable();
      attemptFinished.set(attempt.id, true);
      return { type, attempt_id: attempt.id, code: attempt.error_code, at: value.at };
    }
    throw unavailable();
  });

  for (const authorization of authorizations.values()) {
    if (!authorizationCreated.has(authorization.id)) throw unavailable();
  }
  for (const attempt of attempts.values()) {
    if (!attemptClaimed.has(attempt.id)) throw unavailable();
    if (attempt.status !== "pending" && !attemptFinished.has(attempt.id)) throw unavailable();
  }
  return records;
}

function validateAndCopy(value) {
  const state = exactObject(value, ROOT_KEYS);
  if (state.version !== 1 || typeof state.enabled !== "boolean") throw unavailable();
  const authorizations = validateAuthorizations(state.authorizations);
  const attempts = validateAttempts(state.attempts, authorizations.byId);
  const auditEvents = validateAuditEvents(state.audit_events, authorizations.byId, attempts.byId);
  return {
    version: 1,
    enabled: state.enabled,
    authorizations: authorizations.records,
    attempts: attempts.records,
    audit_events: auditEvents,
  };
}

export function copyValidatedProbeState(value) {
  try {
    return validateAndCopy(value);
  } catch {
    throw unavailable();
  }
}

export function probeStoreUnavailable() {
  return unavailable();
}
