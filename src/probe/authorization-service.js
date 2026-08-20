import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { MODEL_CAPABILITIES } from "../domain/model-capabilities.js";
import { PROBE_AUTHORIZATION_TTL_MS, PROBE_POLICY_VERSION } from "./constants.js";

function requireNonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("PROBE_AUTHORIZATION_INVALID", `${field} must be a non-empty string`);
  }
  return value.trim();
}

const STABLE_PROBE_ERRORS = new Set([
  "CREDENTIAL_REFERENCE_UNAVAILABLE", "UPSTREAM_UNREACHABLE",
  "UPSTREAM_SECURITY_REJECTED", "AUTHENTICATION_FAILED",
  "UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_SCHEMA_UNRECOGNIZED", "STORE_UNAVAILABLE",
]);
const CANONICAL_UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function authorizationOutput(record) {
  return {
    authorization_id: record.id,
    policy_version: record.policy_version,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    consumed: false,
  };
}

function requireStableProbeErrorCode(code) {
  if (!STABLE_PROBE_ERRORS.has(code)) throw new DomainError("STORE_UNAVAILABLE", "probe failure code was invalid");
  return code;
}

function copyValidatedProbeSummary(value) {
  const canonical = (timestamp) => {
    const milliseconds = typeof timestamp === "string" && CANONICAL_UTC.test(timestamp)
      ? Date.parse(timestamp) : Number.NaN;
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === timestamp;
  };
  const localRows = [...MODEL_CAPABILITIES];
  const validRows = Array.isArray(value?.workbench_models)
    && value.workbench_models.length === localRows.length
    && value.workbench_models.every((row, index) => row
      && row.name === localRows[index][0] && row.mode === localRows[index][1].mode
      && ["available", "unavailable", "unknown"].includes(row.availability));
  if (value?.reachable !== true || value?.authenticated !== true || value?.service_version !== null
    || !["available", "unknown"].includes(value?.capability_status) || !validRows
    || !canonical(value?.checked_at) || !canonical(value?.expires_at)
    || value?.policy_version !== PROBE_POLICY_VERSION) {
    throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "normalized probe summary was invalid");
  }
  return {
    reachable: true, authenticated: true, service_version: null,
    capability_status: value.capability_status,
    workbench_models: value.workbench_models.map(({ name, mode, availability }) => ({ name, mode, availability })),
    checked_at: value.checked_at, expires_at: value.expires_at,
    policy_version: PROBE_POLICY_VERSION,
  };
}

export function createProbeAuthorizationService({ store, now = Date.now, randomId = randomUUID }) {
  return {
    async authorize(input) {
      if (input?.source !== "user:current_session") {
        throw new DomainError("PROBE_AUTHORIZATION_INVALID", "source must be user:current_session");
      }
      const reason = requireNonEmpty(input.reason, "reason");
      const idempotencyKey = requireNonEmpty(input.idempotency_key, "idempotency_key");
      return store.update((state) => {
        if (!state.enabled) throw new DomainError("PROBE_DISABLED", "Lovart read-only probe is disabled");
        const existing = state.authorizations.find((record) => record.idempotency_key === idempotencyKey);
        if (existing) {
          if (existing.source !== input.source || existing.reason !== reason) {
            throw new DomainError("PROBE_AUTHORIZATION_INVALID", "idempotency key is bound to different authorization input");
          }
          return authorizationOutput(existing);
        }
        const issuedAtMs = now();
        const record = {
          id: randomId(), kind: "lovart_capability_probe", source: input.source, reason,
          policy_version: PROBE_POLICY_VERSION,
          issued_at: new Date(issuedAtMs).toISOString(),
          expires_at: new Date(issuedAtMs + PROBE_AUTHORIZATION_TTL_MS).toISOString(),
          consumed_at: null, idempotency_key: idempotencyKey,
        };
        state.authorizations.push(record);
        state.audit_events.push({ type: "authorization_created", authorization_id: record.id, at: record.issued_at });
        return authorizationOutput(record);
      });
    },

    async beginProbe(input) {
      const authorizationId = requireNonEmpty(input?.authorization_id, "authorization_id");
      const idempotencyKey = requireNonEmpty(input?.idempotency_key, "idempotency_key");
      return store.update((state) => {
        if (!state.enabled) throw new DomainError("PROBE_DISABLED", "Lovart read-only probe is disabled");
        const replay = state.attempts.find(
          (attempt) => attempt.authorization_id === authorizationId && attempt.idempotency_key === idempotencyKey,
        );
        if (replay?.status === "completed") return { kind: "replay", result: replay.result };
        if (replay) throw new DomainError("PROBE_AUTHORIZATION_INVALID", "probe attempt is already consumed");
        const authorization = state.authorizations.find((record) => record.id === authorizationId);
        if (!authorization || authorization.consumed_at || Date.parse(authorization.expires_at) <= now()) {
          throw new DomainError("PROBE_AUTHORIZATION_INVALID", "authorization is missing, expired, or consumed");
        }
        const claimedAt = new Date(now()).toISOString();
        authorization.consumed_at = claimedAt;
        const attempt = {
          id: randomId(), authorization_id: authorizationId, idempotency_key: idempotencyKey,
          status: "pending", started_at: claimedAt, completed_at: null, result: null, error_code: null,
        };
        state.attempts.push(attempt);
        state.audit_events.push({ type: "probe_claimed", authorization_id: authorizationId, attempt_id: attempt.id, at: claimedAt });
        return { kind: "claimed", attempt_id: attempt.id };
      });
    },

    async completeProbe({ attempt_id, result }) {
      const summary = copyValidatedProbeSummary(result);
      return store.update((state) => {
        const attempt = state.attempts.find((record) => record.id === attempt_id && record.status === "pending");
        if (!attempt) throw new DomainError("STORE_UNAVAILABLE", "pending probe attempt was not found");
        attempt.status = "completed";
        attempt.completed_at = new Date(now()).toISOString();
        attempt.result = summary;
        state.audit_events.push({ type: "probe_completed", attempt_id, at: attempt.completed_at });
        return summary;
      });
    },

    async failProbe({ attempt_id, code }) {
      const errorCode = requireStableProbeErrorCode(code);
      await store.update((state) => {
        const attempt = state.attempts.find((record) => record.id === attempt_id && record.status === "pending");
        if (!attempt) throw new DomainError("STORE_UNAVAILABLE", "pending probe attempt was not found");
        attempt.status = "failed";
        attempt.completed_at = new Date(now()).toISOString();
        attempt.error_code = errorCode;
        state.audit_events.push({ type: "probe_failed", attempt_id, code: errorCode, at: attempt.completed_at });
        return null;
      });
    },

    async setEnabledForUserCommand(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
      return store.update((state) => {
        state.enabled = enabled;
        state.audit_events.push({ type: enabled ? "probe_enabled" : "probe_disabled", at: new Date(now()).toISOString() });
        return { enabled };
      });
    },
  };
}
