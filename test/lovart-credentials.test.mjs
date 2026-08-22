import test from "node:test";
import assert from "node:assert/strict";

import { LOVART_KEYCHAIN_ACCOUNT, LOVART_KEYCHAIN_SERVICE, createCredentialService } from "../src/lovart/credentials.js";

function helper({ status = { status: "setup_required", code: "SETUP_REQUIRED" }, configure, read = { accessKey: "ak_private", secretKey: "sk_private" } } = {}) {
  return {
    commitCount: 0,
    previousPairIntact: true,
    async status() { return status; },
    async configure(options) {
      if (configure) return configure(options, this);
      return { status: "setup_required", code: "SETUP_CANCELLED" };
    },
    async read() { return read; },
    async clear() { return { status: "setup_required", code: "SETUP_REQUIRED" }; },
  };
}

test("credential namespace is IMVIA-owned and independent", () => {
  assert.equal(LOVART_KEYCHAIN_SERVICE, "ai.imvia.studio.lovart");
  assert.equal(LOVART_KEYCHAIN_ACCOUNT, "credentials");
});

test("cancelled setup returns a redacted cancellation status", async () => {
  const service = createCredentialService({ platform: "darwin", arch: "arm64", helperClient: helper() });
  const result = await service.connect({ validate: async () => { throw new Error("must not validate"); } });
  assert.deepEqual(result, { status: "setup_required", code: "SETUP_CANCELLED", message: "Lovart connection was cancelled." });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("candidate validation happens before helper commit", async () => {
  const helperClient = helper({ configure: async ({ validate }, self) => {
    const verdict = await validate({ accessKey: "ak_private", secretKey: "sk_private" });
    if (verdict.accepted) self.commitCount += 1;
    return { status: verdict.accepted ? "connected" : "setup_required", code: verdict.code };
  } });
  const service = createCredentialService({ platform: "win32", arch: "x64", helperClient, now: () => Date.parse("2026-08-22T00:00:00.000Z") });
  const result = await service.connect({ validate: async () => ({ accepted: false, code: "AUTHENTICATION_FAILED" }) });
  assert.deepEqual(result, { status: "setup_required", code: "AUTHENTICATION_FAILED", message: "Lovart authentication was rejected." });
  assert.equal(helperClient.commitCount, 0);
  assert.equal(helperClient.previousPairIntact, true);
});

test("accepted candidates return a redacted connected result on both platforms", async () => {
  for (const platform of ["darwin", "win32"]) {
    const helperClient = helper({ configure: async ({ validate }, self) => {
      const verdict = await validate({ accessKey: "ak_private", secretKey: "sk_private" });
      if (verdict.accepted) self.commitCount += 1;
      return { status: "connected", code: "CONNECTED" };
    } });
    const service = createCredentialService({ platform, arch: "arm64", helperClient, now: () => Date.parse("2026-08-22T00:00:00.000Z") });
    const result = await service.connect({ validate: async ({ accessKey, secretKey }) => {
      assert.equal(accessKey, "ak_private");
      assert.equal(secretKey, "sk_private");
      return { accepted: true, code: "CONNECTED" };
    } });
    assert.equal(result.status, "connected");
    assert.equal(helperClient.commitCount, 1);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("missing helper is a redacted setup-required error", async () => {
  const service = createCredentialService({ platform: "darwin", arch: "x64", helperClient: { status: async () => { const error = new Error("secret"); error.code = "HELPER_NOT_PACKAGED"; throw error; } } });
  assert.deepEqual(await service.status(), { status: "setup_required", code: "HELPER_NOT_PACKAGED", message: "Lovart connection helper is not packaged correctly." });
});

test("unsupported platforms never invoke helper operations", async () => {
  let invoked = false;
  const service = createCredentialService({ platform: "linux", arch: "x64", helperClient: { status: async () => { invoked = true; }, configure: async () => { invoked = true; } } });
  assert.deepEqual(await service.status(), { status: "unsupported", code: "PLATFORM_UNSUPPORTED", message: "Lovart connection is unavailable on this platform." });
  assert.deepEqual(await service.connect({ validate: async () => ({ accepted: true, code: "CONNECTED" }) }), { status: "unsupported", code: "PLATFORM_UNSUPPORTED", message: "Lovart connection is unavailable on this platform." });
  assert.equal(invoked, false);
});
