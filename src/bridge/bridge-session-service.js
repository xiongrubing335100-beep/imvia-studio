import { createHash, randomUUID } from "node:crypto";
import { JsonStore } from "../persistence/json-store.js";
import {
  BRIDGE_HEARTBEAT_INTERVAL_MS,
  BRIDGE_STATE_FILE,
  BRIDGE_STALE_AFTER_MS,
  BRIDGE_PROTOCOL_VERSION,
  DELIVERY_STATES,
  DISPATCH_LEASE_MS,
  SESSION_TTL_MS,
} from "./constants.js";
import { buildDispatchSummary, buildWorkbenchTaskMessage, snapshotDigest } from "./task-message.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(now) {
  return new Date(now).toISOString();
}

function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

function initialState() {
  return {
    schema_version: "1",
    sessions: [],
    dispatches: [],
    idempotency: {},
    audit_events: [],
  };
}

function migrateState(state) {
  if (!state || typeof state !== "object" || state.schema_version !== "1") {
    if (!state || Object.keys(state || {}).length === 0) return { state: initialState(), changed: true };
    const error = new Error("The conversation bridge state schema is unsupported.");
    error.code = "STATE_MIGRATION_FAILED";
    throw error;
  }
  const migrated = clone(state);
  migrated.sessions ??= [];
  migrated.dispatches ??= [];
  migrated.idempotency ??= {};
  migrated.audit_events ??= [];
  return { state: migrated, changed: false };
}

function domainError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw domainError("VALIDATION_FAILED", `${field} is required.`, { field });
  return value.trim();
}

function sessionFor(state, sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw domainError("SESSION_EXPIRED", "The workbench session is unavailable.", { session_id: sessionId });
  return session;
}

function dispatchFor(state, dispatchId) {
  const dispatch = state.dispatches.find((item) => item.id === dispatchId);
  if (!dispatch) throw domainError("NOT_FOUND", "The workbench dispatch does not exist.", { dispatch_id: dispatchId });
  return dispatch;
}

function isFresh(session, now) {
  return session.state === "ready"
    && session.active_bridge_id
    && session.last_seen_at
    && now - Date.parse(session.last_seen_at) < BRIDGE_STALE_AFTER_MS;
}

function publicSession(session, dispatches, now) {
  const pending = dispatches.filter((item) => item.workbench_session_id === session.id && ["pending_bridge", "claimed"].includes(item.delivery_state));
  return {
    session_id: session.id,
    bridge_state: isFresh(session, now) ? "ready" : session.state === "ready" ? "stale" : session.state,
    bridge_id: session.active_bridge_id,
    bridge_last_seen_at: session.last_seen_at,
    pending_count: pending.length,
    expires_at: session.expires_at,
  };
}

function validateLease(dispatch, { sessionId, bridgeId, claimToken, now }) {
  if (dispatch.workbench_session_id !== sessionId || dispatch.bridge_id !== bridgeId || dispatch.claim_token !== claimToken) {
    throw domainError("DISPATCH_LEASE_CONFLICT", "The workbench dispatch lease is no longer owned by this bridge.", { dispatch_id: dispatch.id });
  }
  if (dispatch.delivery_state !== "claimed" || !dispatch.lease_expires_at || Date.parse(dispatch.lease_expires_at) <= now) {
    throw domainError("DISPATCH_LEASE_CONFLICT", "The workbench dispatch lease has expired.", { dispatch_id: dispatch.id });
  }
}

function dispatchEvent(dispatch) {
  if (!dispatch) return null;
  return {
    dispatch_id: dispatch.id,
    job_id: dispatch.job_id,
    workbench_session_id: dispatch.workbench_session_id,
    delivery_state: dispatch.delivery_state,
    attempt_count: dispatch.attempt_count,
    submitted_at: dispatch.submitted_at,
    updated_at: dispatch.updated_at,
    last_error: dispatch.last_error,
  };
}

export function createBridgeSessionService({ dataDirectory, clock = () => Date.now() }) {
  if (!dataDirectory) throw new TypeError("dataDirectory is required.");
  const store = new JsonStore({ dataDirectory, stateFileName: BRIDGE_STATE_FILE, createInitialState: initialState, migrateState });
  const listeners = new Set();
  const emit = (type, data) => {
    for (const listener of listeners) {
      try { listener({ type, occurred_at: nowIso(clock()), data: clone(data) }); } catch { /* observers are best effort */ }
    }
  };

  const service = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    heartbeatIntervalMs: BRIDGE_HEARTBEAT_INTERVAL_MS,
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async openSession() {
      const now = clock();
      const sessionId = randomUUID();
      const openToken = randomUUID();
      const session = await store.update((state) => {
        const record = {
          id: sessionId,
          open_token_hash: hashToken(openToken),
          state: "opening",
          active_bridge_id: null,
          created_at: nowIso(now),
          last_seen_at: null,
          expires_at: nowIso(now + SESSION_TTL_MS),
        };
        state.sessions.push(record);
        state.audit_events.push({ id: randomUUID(), occurred_at: record.created_at, actor: "imvia:open_workbench", reason: "Workbench session opened" });
        return record;
      });
      const result = { session_id: session.id, open_token: openToken, bridge_state: "mounting", expires_at: session.expires_at };
      emit("bridge.session", { session_id: session.id, bridge_state: "mounting", expires_at: session.expires_at });
      return result;
    },

    async registerBridge({ session_id, open_token = null, bridge_id, connected_at }) {
      const sessionId = assertString(session_id, "workbench_session_id");
      const bridgeId = assertString(bridge_id, "bridge_id");
      const now = clock();
      const result = await store.update((state) => {
        const session = sessionFor(state, sessionId);
        if (session.open_token_hash && hashToken(assertString(open_token, "open_token")) !== session.open_token_hash) {
          throw domainError("SESSION_TOKEN_INVALID", "The workbench session token is invalid.", { session_id: sessionId });
        }
        if (Date.parse(session.expires_at) <= now) {
          session.state = "closed";
          throw domainError("SESSION_EXPIRED", "The workbench session has expired.", { session_id: sessionId });
        }
        if (session.active_bridge_id && session.active_bridge_id !== bridgeId) {
          session.state = "superseded";
          session.superseded_at = nowIso(now);
          state.audit_events.push({ id: randomUUID(), occurred_at: nowIso(now), actor: bridgeId, reason: "Previous conversation bridge superseded" });
          session.state = "ready";
        }
        session.active_bridge_id = bridgeId;
        session.state = "ready";
        session.connected_at = connected_at || nowIso(now);
        session.last_seen_at = nowIso(now);
        session.updated_at = session.last_seen_at;
        return publicSession(session, state.dispatches, now);
      });
      emit("bridge.session", result);
      return result;
    },

    async heartbeat({ session_id, bridge_id }) {
      const sessionId = assertString(session_id, "workbench_session_id");
      const bridgeId = assertString(bridge_id, "bridge_id");
      const now = clock();
      const result = await store.update((state) => {
        const session = sessionFor(state, sessionId);
        const active = session.active_bridge_id === bridgeId && Date.parse(session.expires_at) > now;
        if (active) {
          session.state = "ready";
          session.last_seen_at = nowIso(now);
          session.updated_at = session.last_seen_at;
        }
        return { active, ...publicSession(session, state.dispatches, now) };
      });
      emit("bridge.session", result);
      return result;
    },

    async getSessionStatus({ session_id }) {
      const sessionId = assertString(session_id, "workbench_session_id");
      const now = clock();
      const state = await store.read();
      return publicSession(sessionFor(state, sessionId), state.dispatches, now);
    },

    async validateSessionToken({ session_id, open_token }) {
      const sessionId = assertString(session_id, "workbench_session_id");
      const token = assertString(open_token, "open_token");
      const state = await store.read();
      const session = sessionFor(state, sessionId);
      if (hashToken(token) !== session.open_token_hash) throw domainError("SESSION_TOKEN_INVALID", "The workbench session token is invalid.", { session_id: sessionId });
      if (Date.parse(session.expires_at) <= clock()) throw domainError("SESSION_EXPIRED", "The workbench session has expired.", { session_id: sessionId });
      return publicSession(session, state.dispatches, clock());
    },

    async createDispatch({ job_id, workbench_session_id = null, snapshot, idempotency_key }) {
      const jobId = assertString(job_id, "job_id");
      const idempotencyKey = assertString(idempotency_key, "idempotency_key");
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw domainError("VALIDATION_FAILED", "snapshot is required.", { field: "snapshot" });
      const sessionId = workbench_session_id == null ? null : assertString(workbench_session_id, "workbench_session_id");
      const digest = snapshotDigest(snapshot);
      const now = clock();
      const result = await store.update((state) => {
        const existing = state.idempotency[idempotencyKey];
        if (existing) {
          if (existing.job_id !== jobId || existing.snapshot_digest !== digest || existing.session_id !== sessionId) {
            throw domainError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different dispatch.");
          }
          return { dispatch: clone(dispatchFor(state, existing.dispatch_id)), idempotent: true };
        }
        if (sessionId) sessionFor(state, sessionId);
        const dispatchId = randomUUID();
        const dispatch = {
          id: dispatchId,
          job_id: jobId,
          workbench_session_id: sessionId,
          task_type: snapshot.mode === "video" ? "video.generate" : "image.generate",
          snapshot: clone(snapshot),
          snapshot_digest: digest,
          message: buildWorkbenchTaskMessage({ jobId, dispatchId, workbenchSessionId: sessionId || "未绑定", snapshot, digest }),
          delivery_state: sessionId ? "pending_bridge" : "delivery_uncertain",
          bridge_id: null,
          claim_token: null,
          claimed_at: null,
          lease_expires_at: null,
          host_accepted_at: null,
          codex_received_at: null,
          attempt_count: 0,
          last_error: sessionId ? null : { code: "BRIDGE_UNAVAILABLE", message: "No workbench session was bound." },
          submitted_at: nowIso(now),
          updated_at: nowIso(now),
        };
        state.dispatches.push(dispatch);
        state.idempotency[idempotencyKey] = { operation: "workbench_dispatch", job_id: jobId, dispatch_id: dispatchId, session_id: sessionId, snapshot_digest: digest };
        state.audit_events.push({ id: randomUUID(), occurred_at: dispatch.submitted_at, actor: "workbench_action", reason: "Workbench dispatch created" });
        return { dispatch: clone(dispatch), idempotent: false };
      });
      emit("dispatch.created", dispatchEvent(result.dispatch));
      return result;
    },

    async claimNext({ session_id, bridge_id }) {
      const sessionId = assertString(session_id, "workbench_session_id");
      const bridgeId = assertString(bridge_id, "bridge_id");
      const now = clock();
      const result = await store.update((state) => {
        const session = sessionFor(state, sessionId);
        if (!isFresh(session, now) || session.active_bridge_id !== bridgeId) return { active: false, dispatch: null, ...publicSession(session, state.dispatches, now) };
        const dispatch = state.dispatches
          .filter((item) => item.workbench_session_id === sessionId)
          .sort((left, right) => left.submitted_at.localeCompare(right.submitted_at))
          .find((item) => item.delivery_state === "pending_bridge" || (item.delivery_state === "claimed" && Date.parse(item.lease_expires_at || "0") <= now));
        if (!dispatch) return { active: true, dispatch: null, ...publicSession(session, state.dispatches, now) };
        dispatch.delivery_state = "claimed";
        dispatch.bridge_id = bridgeId;
        dispatch.claim_token = randomUUID();
        dispatch.claimed_at = nowIso(now);
        dispatch.lease_expires_at = nowIso(now + DISPATCH_LEASE_MS);
        dispatch.attempt_count += 1;
        dispatch.updated_at = nowIso(now);
        return { active: true, dispatch: buildDispatchSummary({ ...dispatch, message: dispatch.message }), ...publicSession(session, state.dispatches, now) };
      });
      if (result.dispatch) emit("dispatch.claimed", dispatchEvent(result.dispatch));
      return result;
    },

    async markHostAccepted({ dispatch_id, session_id, bridge_id, claim_token }) {
      const dispatchId = assertString(dispatch_id, "dispatch_id");
      const sessionId = assertString(session_id, "workbench_session_id");
      const bridgeId = assertString(bridge_id, "bridge_id");
      const claimToken = assertString(claim_token, "claim_token");
      const now = clock();
      const result = await store.update((state) => {
        const dispatch = dispatchFor(state, dispatchId);
        if (dispatch.delivery_state === "host_accepted" || dispatch.delivery_state === "codex_received") return { ok: true, idempotent: true, dispatch: clone(dispatch) };
        validateLease(dispatch, { sessionId, bridgeId, claimToken, now });
        dispatch.delivery_state = "host_accepted";
        dispatch.host_accepted_at = nowIso(now);
        dispatch.lease_expires_at = null;
        dispatch.updated_at = dispatch.host_accepted_at;
        return { ok: true, idempotent: false, dispatch: clone(dispatch) };
      });
      emit("dispatch.host_accepted", dispatchEvent(result.dispatch));
      return result;
    },

    async releaseClaim({ dispatch_id, session_id, bridge_id, claim_token, error = null }) {
      const dispatchId = assertString(dispatch_id, "dispatch_id");
      const sessionId = assertString(session_id, "workbench_session_id");
      const bridgeId = assertString(bridge_id, "bridge_id");
      const claimToken = assertString(claim_token, "claim_token");
      const now = clock();
      const result = await store.update((state) => {
        const dispatch = dispatchFor(state, dispatchId);
        validateLease(dispatch, { sessionId, bridgeId, claimToken, now });
        dispatch.delivery_state = "pending_bridge";
        dispatch.bridge_id = null;
        dispatch.claim_token = null;
        dispatch.claimed_at = null;
        dispatch.lease_expires_at = null;
        dispatch.last_error = error && typeof error === "object" ? { code: String(error.code || "DISPATCH_DELIVERY_FAILED"), message: String(error.message || "Dispatch delivery failed.") } : null;
        dispatch.updated_at = nowIso(now);
        return { ok: true, dispatch: clone(dispatch) };
      });
      emit("dispatch.released", dispatchEvent(result.dispatch));
      return result;
    },

    async markCodexReceived({ job_id, snapshot_digest }) {
      const jobId = assertString(job_id, "job_id");
      const digest = assertString(snapshot_digest, "snapshot_digest");
      const now = clock();
      const result = await store.update((state) => {
        const dispatch = state.dispatches.find((item) => item.job_id === jobId && item.snapshot_digest === digest);
        if (!dispatch) throw domainError("NOT_FOUND", "The workbench dispatch does not exist for this snapshot.", { job_id: jobId });
        if (["codex_received"].includes(dispatch.delivery_state)) return { dispatch: clone(dispatch), idempotent: true };
        if (dispatch.delivery_state !== "host_accepted") throw domainError("DELIVERY_STATE_CONFLICT", "The workbench message has not been accepted by the Codex host.", { job_id: jobId, delivery_state: dispatch.delivery_state });
        dispatch.delivery_state = "codex_received";
        dispatch.codex_received_at = nowIso(now);
        dispatch.updated_at = dispatch.codex_received_at;
        state.audit_events.push({ id: randomUUID(), occurred_at: dispatch.codex_received_at, actor: "imvia:codex", reason: "Codex received workbench dispatch" });
        return { dispatch: clone(dispatch), idempotent: false };
      });
      emit("dispatch.codex_received", dispatchEvent(result.dispatch));
      return result;
    },

    async listDispatches({ session_id = null } = {}) {
      const state = await store.read();
      return clone(state.dispatches
        .filter((item) => session_id == null || item.workbench_session_id === session_id)
        .map(({ snapshot: _snapshot, message: _message, claim_token: _claimToken, ...safe }) => safe));
    },
  };

  return service;
}
