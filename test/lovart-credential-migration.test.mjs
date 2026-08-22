import assert from "node:assert/strict";
import test from "node:test";

import { createOnboardingService } from "../src/lovart/onboarding-service.js";

test("complete IMVIA credentials skip first-run setup", async () => {
  let connects = 0;
  const onboarding = createOnboardingService({
    credentialService: { status: async () => ({ status: "connected" }), clear: async () => ({ status: "setup_required" }) },
    connect: async () => { connects += 1; return { status: "connected" }; },
  });
  const result = await onboarding.ensureStarted();
  assert.equal(result.state, "connected");
  assert.equal(result.code, "CONNECTED");
  assert.equal(connects, 0);
});

test("incomplete IMVIA credentials start setup without reading a foreign plugin", async () => {
  let connects = 0;
  const onboarding = createOnboardingService({
    credentialService: { status: async () => ({ status: "setup_required" }), clear: async () => ({ status: "setup_required" }) },
    connect: async () => { connects += 1; return { status: "setup_required", code: "SETUP_CANCELLED" }; },
  });
  assert.equal((await onboarding.ensureStarted()).state, "setup_active");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 1);
  assert.equal((await onboarding.status()).state, "cancelled");
});

test("upgrade and disconnect never infer or clear an existing Lovart-plugin namespace", async () => {
  let clearCalls = 0;
  const onboarding = createOnboardingService({
    credentialService: {
      status: async () => ({ status: "connected" }),
      clear: async () => { clearCalls += 1; return { status: "setup_required" }; },
    },
    connect: async () => ({ status: "connected" }),
  });
  await onboarding.ensureStarted();
  await onboarding.disconnect();
  assert.equal(clearCalls, 1);
  assert.equal(clearCalls, 1);
});
