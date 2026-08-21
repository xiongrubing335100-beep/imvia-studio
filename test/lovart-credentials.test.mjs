import test from "node:test";
import assert from "node:assert/strict";

import {
  LOVART_ACCESS_ACCOUNT,
  LOVART_KEYCHAIN_SERVICE,
  LOVART_SECRET_ACCOUNT,
  createCredentialService,
} from "../src/lovart/credentials.js";

test("credential constants use the IMVIA-owned Keychain item", () => {
  assert.equal(LOVART_KEYCHAIN_SERVICE, "ai.imvia.studio.lovart");
  assert.equal(LOVART_ACCESS_ACCOUNT, "access-key");
  assert.equal(LOVART_SECRET_ACCOUNT, "secret-key");
});

test("cancelled setup returns a redacted cancellation status", async () => {
  const service = createCredentialService({
    platform: "darwin",
    runHelper: async () => ({ configured: false, code: "CREDENTIAL_SETUP_CANCELLED" }),
    readKeychain: async () => ({ accessKey: "ak_should_not_be_read", secretKey: "sk_should_not_be_read" }),
  });

  const result = await service.connect();
  assert.deepEqual(result, {
    status: "not_connected",
    code: "CREDENTIAL_SETUP_CANCELLED",
    message: "Lovart connection was cancelled.",
  });
  assert.equal(JSON.stringify(result).includes("ak_should_not_be_read"), false);
});

test("successful setup validates credentials and returns no secret values", async () => {
  let reads = 0;
  const service = createCredentialService({
    platform: "darwin",
    runHelper: async () => ({ configured: true }),
    readKeychain: async () => {
      reads += 1;
      return { accessKey: "ak_test", secretKey: "sk_test" };
    },
  });

  const result = await service.connect();
  assert.deepEqual(result, { status: "connected", checked_at: result.checked_at });
  assert.match(result.checked_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(result).includes("ak_test"), false);
  assert.equal(JSON.stringify(result).includes("sk_test"), false);
});

test("missing Keychain credentials return a stable not-connected result", async () => {
  const service = createCredentialService({
    platform: "darwin",
    readKeychain: async () => ({ accessKey: "", secretKey: "" }),
  });

  assert.deepEqual(await service.status(), {
    status: "not_connected",
    code: "CREDENTIAL_REFERENCE_UNAVAILABLE",
    message: "Lovart credentials are not configured.",
  });
});

test("unsupported platforms never invoke setup or Keychain reads", async () => {
  let invoked = false;
  const service = createCredentialService({
    platform: "linux",
    runHelper: async () => { invoked = true; return { configured: true }; },
    readKeychain: async () => { invoked = true; return { accessKey: "ak", secretKey: "sk" }; },
  });

  assert.deepEqual(await service.connect(), {
    status: "unsupported",
    code: "PLATFORM_UNSUPPORTED",
    message: "Lovart connection setup requires macOS.",
  });
  assert.equal(invoked, false);
});
