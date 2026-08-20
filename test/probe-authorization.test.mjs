import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProbeAuthorizationService } from "../src/probe/authorization-service.js";
import { PROBE_AUTHORIZATION_TTL_MS, PROBE_POLICY_VERSION } from "../src/probe/constants.js";
import { createProbeStore } from "../src/probe/probe-store.js";

const START_MS = Date.parse("2026-08-20T00:00:00.000Z");

const validAuthorizationInput = {
  source: "user:current_session",
  reason: "Check connectivity",
  idempotency_key: "auth-1",
};

const sampleSummary = {
  reachable: true,
  authenticated: true,
  service_version: null,
  capability_status: "available",
  workbench_models: [
    { name: "Seedance 2.5", mode: "video", availability: "available" },
    { name: "Seedance 2.0 VIP", mode: "video", availability: "available" },
    { name: "Seedance 2.0 Fast", mode: "video", availability: "available" },
    { name: "Minimax H3", mode: "video", availability: "available" },
    { name: "Kling 3.0", mode: "video", availability: "available" },
    { name: "Kling 3.0 Omni", mode: "video", availability: "available" },
    { name: "Seedream 4.0", mode: "image", availability: "available" },
    { name: "Seedream 3.0", mode: "image", availability: "available" },
    { name: "Seedream 3.0 Fast", mode: "image", availability: "available" },
    { name: "Image 2", mode: "image", availability: "available" },
    { name: "Nano Banana Pro", mode: "image", availability: "available" },
    { name: "Nano Banana 2", mode: "image", availability: "available" },
    { name: "Seedream 5.0", mode: "image", availability: "available" },
    { name: "Seedream 5.0 Lite", mode: "image", availability: "available" },
    { name: "Midjourney", mode: "image", availability: "available" },
  ],
  checked_at: "2026-08-20T00:00:01.000Z",
  expires_at: "2026-08-20T00:05:01.000Z",
  policy_version: PROBE_POLICY_VERSION,
};

async function fixture({ enabled = false } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-authorization-"));
  const store = createProbeStore({ dataDirectory });
  let currentMs = START_MS;
  let nextId = 0;
  const service = createProbeAuthorizationService({
    store,
    now: () => currentMs,
    randomId: () => `generated-${++nextId}`,
  });
  if (enabled) await service.setEnabledForUserCommand(true);
  return {
    service,
    store,
    setNow(value) {
      currentMs = value;
    },
  };
}

test("feature disabled rejects before an authorization is created", async () => {
  const { service, store } = await fixture({ enabled: false });
  await assert.rejects(
    service.authorize(validAuthorizationInput),
    (error) => error.code === "PROBE_DISABLED",
  );
  assert.equal((await store.read()).authorizations.length, 0);
});

test("authorization creation is idempotent for the same normalized input", async () => {
  const { service, store } = await fixture({ enabled: true });
  const first = await service.authorize({
    source: "user:current_session",
    reason: "  Check connectivity  ",
    idempotency_key: "  auth-1  ",
  });
  const second = await service.authorize(validAuthorizationInput);

  assert.deepEqual(first, {
    authorization_id: "generated-1",
    policy_version: PROBE_POLICY_VERSION,
    issued_at: "2026-08-20T00:00:00.000Z",
    expires_at: "2026-08-20T00:02:00.000Z",
    consumed: false,
  });
  assert.deepEqual(second, first);
  const state = await store.read();
  assert.equal(state.authorizations.length, 1);
  assert.deepEqual(state.authorizations[0], {
    id: "generated-1",
    kind: "lovart_capability_probe",
    source: "user:current_session",
    reason: "Check connectivity",
    policy_version: PROBE_POLICY_VERSION,
    issued_at: "2026-08-20T00:00:00.000Z",
    expires_at: "2026-08-20T00:02:00.000Z",
    consumed_at: null,
    idempotency_key: "auth-1",
  });
  assert.equal(state.audit_events.filter(({ type }) => type === "authorization_created").length, 1);
});

test("authorization idempotency key rejects mismatched input", async () => {
  const { service, store } = await fixture({ enabled: true });
  await service.authorize(validAuthorizationInput);
  await assert.rejects(
    service.authorize({ ...validAuthorizationInput, reason: "A different reason" }),
    (error) => error.code === "PROBE_AUTHORIZATION_INVALID",
  );
  assert.equal((await store.read()).authorizations.length, 1);
});

test("authorization rejects invalid current-session input without persisting", async () => {
  const { service, store } = await fixture({ enabled: true });
  for (const input of [
    { ...validAuthorizationInput, source: "user:another_session" },
    { ...validAuthorizationInput, reason: " " },
    { ...validAuthorizationInput, idempotency_key: "" },
  ]) {
    await assert.rejects(
      service.authorize(input),
      (error) => error.code === "PROBE_AUTHORIZATION_INVALID",
    );
  }
  assert.equal((await store.read()).authorizations.length, 0);
});

test("authorization expires at the TTL boundary without creating an attempt", async () => {
  const { service, store, setNow } = await fixture({ enabled: true });
  const authorization = await service.authorize(validAuthorizationInput);
  setNow(START_MS + PROBE_AUTHORIZATION_TTL_MS);

  await assert.rejects(
    service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
    (error) => error.code === "PROBE_AUTHORIZATION_INVALID",
  );
  const state = await store.read();
  assert.equal(state.authorizations[0].consumed_at, null);
  assert.equal(state.attempts.length, 0);
});

test("concurrent claims have exactly one winner and one durable pending attempt", async () => {
  const { service, store, setNow } = await fixture({ enabled: true });
  const authorization = await service.authorize(validAuthorizationInput);
  setNow(START_MS + 1_000);
  const settled = await Promise.allSettled([
    service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
    service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-2" }),
  ]);

  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(settled.find(({ status }) => status === "rejected").reason.code, "PROBE_AUTHORIZATION_INVALID");
  assert.deepEqual(settled.find(({ status }) => status === "fulfilled").value, {
    kind: "claimed",
    attempt_id: "generated-2",
  });
  const state = await store.read();
  assert.equal(state.authorizations[0].consumed_at, "2026-08-20T00:00:01.000Z");
  assert.deepEqual(state.attempts, [{
    id: "generated-2",
    authorization_id: "generated-1",
    idempotency_key: "probe-1",
    status: "pending",
    started_at: "2026-08-20T00:00:01.000Z",
    completed_at: null,
    result: null,
    error_code: null,
  }]);
});

test("pending attempt replay does not restore or duplicate authorization", async () => {
  const { service, store } = await fixture({ enabled: true });
  const authorization = await service.authorize(validAuthorizationInput);
  await service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" });

  await assert.rejects(
    service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
    (error) => error.code === "PROBE_AUTHORIZATION_INVALID",
  );
  assert.equal((await store.read()).attempts.length, 1);
});

test("completed idempotency replay returns a copied stored summary without a new attempt", async () => {
  const { service, store, setNow } = await fixture({ enabled: true });
  const authorization = await service.authorize(validAuthorizationInput);
  const claim = await service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" });
  setNow(START_MS + 2_000);
  const supplied = {
    ...sampleSummary,
    secret: "must not persist",
    workbench_models: sampleSummary.workbench_models.map((row) => ({ ...row, upstream_id: "must not persist" })),
  };
  const completed = await service.completeProbe({ attempt_id: claim.attempt_id, result: supplied });
  supplied.workbench_models[0].availability = "unavailable";
  const replay = await service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" });

  assert.deepEqual(completed, sampleSummary);
  assert.deepEqual(replay, { kind: "replay", result: sampleSummary });
  const state = await store.read();
  assert.equal(state.attempts.length, 1);
  assert.deepEqual(state.attempts[0].result, sampleSummary);
  assert.equal(state.attempts[0].completed_at, "2026-08-20T00:00:02.000Z");
});

test("failed attempts never restore authority for same or different idempotency keys", async () => {
  const { service, store, setNow } = await fixture({ enabled: true });
  const authorization = await service.authorize(validAuthorizationInput);
  const claim = await service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" });
  setNow(START_MS + 2_000);
  await service.failProbe({ attempt_id: claim.attempt_id, code: "UPSTREAM_UNAVAILABLE" });

  for (const idempotency_key of ["probe-1", "probe-2"]) {
    await assert.rejects(
      service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key }),
      (error) => error.code === "PROBE_AUTHORIZATION_INVALID",
    );
  }
  const state = await store.read();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, "failed");
  assert.equal(state.attempts[0].error_code, "UPSTREAM_UNAVAILABLE");
  assert.equal(state.attempts[0].completed_at, "2026-08-20T00:00:02.000Z");
});

test("completion rejects malformed summaries and invalid failure codes without changing pending state", async () => {
  const { service, store } = await fixture({ enabled: true });
  const authorization = await service.authorize(validAuthorizationInput);
  const claim = await service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" });

  await assert.rejects(
    service.completeProbe({ attempt_id: claim.attempt_id, result: { ...sampleSummary, checked_at: "2026-08-20T00:00:01Z" } }),
    (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED",
  );
  await assert.rejects(
    service.failProbe({ attempt_id: claim.attempt_id, code: "UNCLASSIFIED_FAILURE" }),
    (error) => error.code === "STORE_UNAVAILABLE",
  );
  assert.equal((await store.read()).attempts[0].status, "pending");
});

test("only the user command transition accepts boolean enabled state", async () => {
  const { service, store } = await fixture();
  await assert.rejects(service.setEnabledForUserCommand("true"), TypeError);
  assert.equal((await store.read()).enabled, false);
  assert.deepEqual(await service.setEnabledForUserCommand(true), { enabled: true });
  assert.equal((await store.read()).enabled, true);
});
