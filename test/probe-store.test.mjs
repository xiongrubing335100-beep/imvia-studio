import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DomainError } from "../src/domain/errors.js";
import { normalizeLovartCapabilities } from "../src/probe/capability-normalizer.js";
import { createProbeStore } from "../src/probe/probe-store.js";

const STATE_FILE = "lovart-probe-state-v1.json";
const START_MS = Date.parse("2026-08-20T00:00:00.000Z");
const summary = normalizeLovartCapabilities({
  unlimited: true,
  available_models: { IMAGE: [], VIDEO: ["generate_video_seedance_v2_5"] },
}, { checkedAtMs: START_MS + 1_000 });

function completedState(result = summary) {
  return {
    version: 1,
    enabled: true,
    authorizations: [{
      id: "authorization-1",
      kind: "lovart_capability_probe",
      source: "user:current_session",
      reason: "prior request",
      policy_version: "lovart-readonly-probe-v1",
      issued_at: "2026-08-20T00:00:00.000Z",
      expires_at: "2026-08-20T00:02:00.000Z",
      consumed_at: "2026-08-20T00:00:01.000Z",
      idempotency_key: "authorization-key",
    }],
    attempts: [{
      id: "attempt-1",
      authorization_id: "authorization-1",
      idempotency_key: "probe-key",
      status: "completed",
      started_at: "2026-08-20T00:00:01.000Z",
      completed_at: "2026-08-20T00:00:02.000Z",
      result,
      error_code: null,
    }],
    audit_events: [
      { type: "authorization_created", authorization_id: "authorization-1", at: "2026-08-20T00:00:00.000Z" },
      { type: "probe_claimed", authorization_id: "authorization-1", attempt_id: "attempt-1", at: "2026-08-20T00:00:01.000Z" },
      { type: "probe_completed", attempt_id: "attempt-1", at: "2026-08-20T00:00:02.000Z" },
    ],
  };
}

function assertStoreUnavailable(error) {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "STORE_UNAVAILABLE");
  assert.equal(error.message, "Lovart probe state is unavailable");
  assert.deepEqual(error.details, {});
  assert.equal(JSON.stringify(error).includes("POISON"), false);
  return true;
}

test("probe state starts isolated and disabled", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-store-"));
  const state = await createProbeStore({ dataDirectory }).read();
  assert.deepEqual(state, {
    version: 1,
    enabled: false,
    authorizations: [],
    attempts: [],
    audit_events: [],
  });
});

test("probe store rejects every valid-JSON schema corruption on read and update", async () => {
  const corruptions = [
    { ...completedState(), extra_root: "POISON" },
    { ...completedState(), enabled: "false" },
    {
      ...completedState(),
      authorizations: [{ ...completedState().authorizations[0], expires_at: "2026-08-20T00:03:00.000Z" }],
    },
    {
      ...completedState(),
      authorizations: [completedState().authorizations[0], completedState().authorizations[0]],
    },
    {
      ...completedState(),
      attempts: [{ ...completedState().attempts[0], authorization_id: "missing-authorization" }],
    },
    completedState({ ...summary, extra_summary: "POISON" }),
    {
      ...completedState(),
      audit_events: completedState().audit_events.map((event, index) => index === 0
        ? { ...event, extra_audit: "POISON" }
        : event),
    },
    {
      ...completedState(),
      attempts: [{
        ...completedState().attempts[0],
        status: "failed",
        result: null,
        error_code: { code: "UPSTREAM_UNAVAILABLE", detail: "POISON" },
      }],
      audit_events: [
        ...completedState().audit_events.slice(0, 2),
        { type: "probe_failed", attempt_id: "attempt-1", code: "UPSTREAM_UNAVAILABLE", at: "2026-08-20T00:00:02.000Z" },
      ],
    },
  ];

  for (const state of corruptions) {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-corrupt-"));
    await writeFile(path.join(dataDirectory, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const store = createProbeStore({ dataDirectory });
    await assert.rejects(store.read(), assertStoreUnavailable);
    await assert.rejects(store.update(() => null), assertStoreUnavailable);
  }
});

test("probe store validates mutations before committing them", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-invalid-mutation-"));
  const store = createProbeStore({ dataDirectory });
  const before = await store.read();

  await assert.rejects(store.update((state) => {
    state.extra_root = "POISON";
    return null;
  }), assertStoreUnavailable);

  assert.deepEqual(JSON.parse(await readFile(path.join(dataDirectory, STATE_FILE), "utf8")), before);
});
