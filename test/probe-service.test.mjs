import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainError } from "../src/domain/errors.js";
import { createProbeAuthorizationService } from "../src/probe/authorization-service.js";
import { PROBE_POLICY_VERSION } from "../src/probe/constants.js";
import { createLovartProbeService } from "../src/probe/probe-service.js";
import { createProbeStore } from "../src/probe/probe-store.js";

const START_MS = Date.parse("2026-08-20T00:00:00.000Z");

const validAuthorizationInput = {
  source: "user:current_session",
  reason: "Check Lovart connectivity",
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

async function serviceFixture({ enabled = true, runner } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-service-"));
  const store = createProbeStore({ dataDirectory });
  let nextId = 0;
  const authorizationService = createProbeAuthorizationService({
    store,
    now: () => START_MS,
    randomId: () => `generated-${++nextId}`,
  });
  if (enabled) await authorizationService.setEnabledForUserCommand(true);
  let childRuns = 0;
  const service = createLovartProbeService({
    authorizationService,
    runner: runner ?? {
      async run() {
        childRuns += 1;
        return sampleSummary;
      },
    },
    platform: "darwin",
  });
  return {
    authorizationService,
    get childRuns() {
      return childRuns;
    },
    service,
    store,
  };
}

function assertStableFailure(error, code, authenticated) {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, code);
  assert.deepEqual(error.details, { authenticated });
  assert.deepEqual(Object.keys(error.details), ["authenticated"]);
  return true;
}

test("the service exposes only local authorization and probe operations", async () => {
  const expected = { authorization_id: "authorization-1" };
  let authorizationCalls = 0;
  let childRuns = 0;
  const service = createLovartProbeService({
    authorizationService: {
      async authorize(input) {
        authorizationCalls += 1;
        assert.equal(input, validAuthorizationInput);
        return expected;
      },
    },
    runner: { async run() { childRuns += 1; } },
    platform: "darwin",
  });

  assert.deepEqual(Object.keys(service).sort(), ["authorize", "probe"]);
  assert.equal(await service.authorize(validAuthorizationInput), expected);
  assert.equal(authorizationCalls, 1);
  assert.equal(childRuns, 0);
});

test("disabled probe rejects before launching the child", async () => {
  const fixture = await serviceFixture();
  const authorization = await fixture.service.authorize(validAuthorizationInput);
  await fixture.authorizationService.setEnabledForUserCommand(false);

  await assert.rejects(
    fixture.service.probe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
    (error) => error.code === "PROBE_DISABLED",
  );
  assert.equal(fixture.childRuns, 0);
  assert.equal((await fixture.store.read()).attempts.length, 0);
});

test("unsupported platform does not consume authorization or launch the child", async () => {
  const fixture = await serviceFixture();
  const authorization = await fixture.service.authorize(validAuthorizationInput);
  let childRuns = 0;
  const service = createLovartProbeService({
    authorizationService: fixture.authorizationService,
    runner: { async run() { childRuns += 1; } },
    platform: "linux",
  });

  await assert.rejects(
    service.probe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
    (error) => assertStableFailure(error, "PLATFORM_UNSUPPORTED", null),
  );
  const state = await fixture.store.read();
  assert.equal(childRuns, 0);
  assert.equal(state.authorizations[0].consumed_at, null);
  assert.equal(state.attempts.length, 0);
});

test("invalid authorization never launches the child", async () => {
  const fixture = await serviceFixture();

  await assert.rejects(
    fixture.service.probe({ authorization_id: "missing", idempotency_key: "probe-1" }),
    (error) => error.code === "PROBE_AUTHORIZATION_INVALID",
  );
  assert.equal(fixture.childRuns, 0);
  assert.equal((await fixture.store.read()).attempts.length, 0);
});

test("a claimed probe runs once and durably returns only an authenticated success", async () => {
  const fixture = await serviceFixture();
  const authorization = await fixture.service.authorize(validAuthorizationInput);

  const result = await fixture.service.probe({
    authorization_id: authorization.authorization_id,
    idempotency_key: "probe-1",
  });

  assert.deepEqual(result, sampleSummary);
  assert.equal(result.authenticated, true);
  assert.equal(fixture.childRuns, 1);
  const state = await fixture.store.read();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, "completed");
  assert.deepEqual(state.attempts[0].result, sampleSummary);
});

const failureCases = [
  ["missing Keychain credential", "CREDENTIAL_REFERENCE_UNAVAILABLE", "CREDENTIAL_REFERENCE_UNAVAILABLE", null],
  ["network failure", "UPSTREAM_UNREACHABLE", "UPSTREAM_UNREACHABLE", null],
  ["timeout", "UPSTREAM_UNREACHABLE", "UPSTREAM_UNREACHABLE", null],
  ["TLS rejection", "UPSTREAM_SECURITY_REJECTED", "UPSTREAM_SECURITY_REJECTED", null],
  ["401 or 403 rejection", "AUTHENTICATION_FAILED", "AUTHENTICATION_FAILED", false],
  ["rate limit", "UPSTREAM_RATE_LIMITED", "UPSTREAM_RATE_LIMITED", null],
  ["upstream outage", "UPSTREAM_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", null],
  ["schema failure", "UPSTREAM_SCHEMA_UNRECOGNIZED", "UPSTREAM_SCHEMA_UNRECOGNIZED", null],
  ["runner store failure", "STORE_UNAVAILABLE", "STORE_UNAVAILABLE", null],
  ["unknown child failure", "SECRET_UNKNOWN_CODE", "UPSTREAM_UNREACHABLE", null],
];

for (const [label, suppliedCode, expectedCode, authenticated] of failureCases) {
  test(`${label} is stored once and exposed as a fresh stable failure`, async () => {
    let childRuns = 0;
    const fixture = await serviceFixture({
      runner: {
        async run() {
          childRuns += 1;
          throw Object.assign(new Error("SECRET_CHILD_FAILURE"), {
            code: suppliedCode,
            details: { raw: "SECRET_RAW_DETAILS" },
          });
        },
      },
    });
    const authorization = await fixture.service.authorize(validAuthorizationInput);

    await assert.rejects(
      fixture.service.probe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
      (error) => {
        assertStableFailure(error, expectedCode, authenticated);
        const serialized = JSON.stringify({
          code: error.code,
          message: error.message,
          details: error.details,
          cause: error.cause,
        });
        assert.equal(serialized.includes("SECRET_CHILD_FAILURE"), false);
        assert.equal(serialized.includes("SECRET_RAW_DETAILS"), false);
        assert.equal(serialized.includes("SECRET_UNKNOWN_CODE"), false);
        return true;
      },
    );

    assert.equal(childRuns, 1);
    const state = await fixture.store.read();
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].status, "failed");
    assert.equal(state.attempts[0].error_code, expectedCode);
    await assert.rejects(
      fixture.service.probe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-2" }),
      (error) => error.code === "PROBE_AUTHORIZATION_INVALID",
    );
    assert.equal(childRuns, 1);
  });
}

test("successful replay performs no second child run", async () => {
  const fixture = await serviceFixture();
  const authorization = await fixture.service.authorize(validAuthorizationInput);
  const input = { authorization_id: authorization.authorization_id, idempotency_key: "probe-1" };

  assert.deepEqual(await fixture.service.probe(input), sampleSummary);
  assert.deepEqual(await fixture.service.probe(input), sampleSummary);
  assert.equal(fixture.childRuns, 1);
  assert.equal((await fixture.store.read()).attempts.length, 1);
});

test("concurrent probes have one claim winner and one child run", async () => {
  let releaseRunner;
  let markRunnerStarted;
  let childRuns = 0;
  const runnerStarted = new Promise((resolve) => { markRunnerStarted = resolve; });
  const fixture = await serviceFixture({
    runner: {
      run() {
        childRuns += 1;
        markRunnerStarted();
        return new Promise((resolve) => { releaseRunner = resolve; });
      },
    },
  });
  const authorization = await fixture.service.authorize(validAuthorizationInput);
  const input = { authorization_id: authorization.authorization_id, idempotency_key: "probe-1" };

  const outcomes = [fixture.service.probe(input), fixture.service.probe(input)];
  await runnerStarted;
  releaseRunner(sampleSummary);
  const settled = await Promise.allSettled(outcomes);

  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(settled.find(({ status }) => status === "rejected").reason.code, "PROBE_AUTHORIZATION_INVALID");
  assert.equal(childRuns, 1);
  const state = await fixture.store.read();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, "completed");
});

test("final-store failure consumes the attempt and never reruns the child", async () => {
  const fixture = await serviceFixture();
  const authorization = await fixture.authorizationService.authorize(validAuthorizationInput);
  let childRuns = 0;
  let completionCalls = 0;
  let failureCalls = 0;
  const authorizationService = {
    authorize: (input) => fixture.authorizationService.authorize(input),
    beginProbe: (input) => fixture.authorizationService.beginProbe(input),
    async completeProbe() {
      completionCalls += 1;
      throw new DomainError("STORE_UNAVAILABLE", "SECRET_STORE_FAILURE", { raw: "SECRET_STORE_DETAILS" });
    },
    async failProbe(input) {
      failureCalls += 1;
      assert.deepEqual(Object.keys(input).sort(), ["attempt_id", "code"]);
      assert.equal(input.code, "STORE_UNAVAILABLE");
      return fixture.authorizationService.failProbe(input);
    },
  };
  const service = createLovartProbeService({
    authorizationService,
    runner: { async run() { childRuns += 1; return sampleSummary; } },
    platform: "darwin",
  });
  const input = { authorization_id: authorization.authorization_id, idempotency_key: "probe-1" };

  await assert.rejects(service.probe(input), (error) => {
    assertStableFailure(error, "STORE_UNAVAILABLE", null);
    assert.equal(error.message.includes("SECRET_STORE"), false);
    return true;
  });
  await assert.rejects(service.probe(input), (error) => error.code === "PROBE_AUTHORIZATION_INVALID");

  assert.equal(childRuns, 1);
  assert.equal(completionCalls, 1);
  assert.equal(failureCalls, 1);
  const state = await fixture.store.read();
  assert.equal(state.attempts[0].status, "failed");
  assert.equal(state.attempts[0].error_code, "STORE_UNAVAILABLE");
  assert.notEqual(state.authorizations[0].consumed_at, null);
});

test("failProbe failure cannot replace or leak the original stable semantics", async () => {
  const fixture = await serviceFixture();
  const authorization = await fixture.authorizationService.authorize(validAuthorizationInput);
  let childRuns = 0;
  let failureCalls = 0;
  const authorizationService = {
    authorize: (input) => fixture.authorizationService.authorize(input),
    beginProbe: (input) => fixture.authorizationService.beginProbe(input),
    completeProbe: (input) => fixture.authorizationService.completeProbe(input),
    async failProbe(input) {
      failureCalls += 1;
      assert.deepEqual(input, { attempt_id: "generated-2", code: "AUTHENTICATION_FAILED" });
      throw new Error("SECRET_FAIL_PROBE_FAILURE");
    },
  };
  const service = createLovartProbeService({
    authorizationService,
    runner: {
      async run() {
        childRuns += 1;
        throw Object.assign(new Error("SECRET_AUTH_RESPONSE"), { code: "AUTHENTICATION_FAILED" });
      },
    },
    platform: "darwin",
  });
  const input = { authorization_id: authorization.authorization_id, idempotency_key: "probe-1" };

  await assert.rejects(service.probe(input), (error) => {
    assertStableFailure(error, "AUTHENTICATION_FAILED", false);
    assert.equal(error.message.includes("SECRET"), false);
    return true;
  });
  await assert.rejects(service.probe(input), (error) => error.code === "PROBE_AUTHORIZATION_INVALID");

  assert.equal(childRuns, 1);
  assert.equal(failureCalls, 1);
  const state = await fixture.store.read();
  assert.equal(state.attempts[0].status, "pending");
  assert.notEqual(state.authorizations[0].consumed_at, null);
});
