import assert from "node:assert/strict";
import test from "node:test";

import { createOnboardingService } from "../src/lovart/onboarding-service.js";

function harness({ current = { status: "setup_required", code: "SETUP_REQUIRED" }, connect } = {}) {
  let clearCalls = 0;
  const credentialService = {
    status: async () => current,
    clear: async () => { clearCalls += 1; return { status: "setup_required", code: "SETUP_REQUIRED" }; },
  };
  return { credentialService, clearCalls: () => clearCalls, onboarding: createOnboardingService({ credentialService, connect: connect || (async () => ({ status: "connected", code: "CONNECTED" })) }) };
}

test("two first opens start one helper session", async () => {
  let connectCalls = 0;
  let resolveConnect;
  const { onboarding } = harness({ connect: () => { connectCalls += 1; return new Promise((resolve) => { resolveConnect = resolve; }); } });
  const [first, second] = await Promise.all([onboarding.ensureStarted(), onboarding.ensureStarted()]);
  assert.equal(connectCalls, 1);
  assert.deepEqual(first, { state: "setup_active", code: "SETUP_ACTIVE" });
  assert.deepEqual(second, first);
  resolveConnect({ status: "connected", code: "CONNECTED", checked_at: "2026-08-22T00:00:00.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await onboarding.status(), { state: "connected", code: "CONNECTED", checked_at: "2026-08-22T00:00:00.000Z" });
});

test("validation is published before a connected terminal state", async () => {
  const states = [];
  const { onboarding } = harness({ connect: async ({ onState }) => { onState("validating"); return { status: "connected", code: "CONNECTED" }; } });
  onboarding.subscribe((event) => states.push(event.data.state));
  await onboarding.ensureStarted();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, ["setup_active", "validating", "connected"]);
});

test("cancelled setup never exposes candidate material", async () => {
  const states = [];
  const { onboarding } = harness({ connect: async () => ({ status: "setup_required", code: "SETUP_CANCELLED", message: "ak_private sk_private" }) });
  onboarding.subscribe((event) => states.push(JSON.stringify(event)));
  await onboarding.ensureStarted();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await onboarding.status()), { state: "cancelled", code: "SETUP_CANCELLED" });
  assert.equal(states.join(" ").includes("private"), false);
});

test("disconnect clears only through the credential service", async () => {
  const { onboarding, clearCalls } = harness({ current: { status: "connected", code: "CONNECTED" } });
  assert.deepEqual(await onboarding.disconnect(), { state: "setup_required", code: "SETUP_REQUIRED" });
  assert.equal(clearCalls(), 1);
});
