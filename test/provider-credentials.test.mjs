import assert from "node:assert/strict";
import test from "node:test";

import { createProviderCredentialService } from "../src/providers/provider-credentials.js";

const fields = [
  { id: "api_key", label: "API Key", secret: true, required: true },
  { id: "account", label: "Account", secret: false, required: false },
];

test("configures a profile while exposing only redacted state and result data", async () => {
  const calls = [];
  const states = [];
  const helperClient = {
    async configure(options) {
      calls.push(options);
      options.onState?.("validating", { api_key: "private-secret-value" });
      options.onState?.("validating-private-secret", { api_key: "private-secret-value" });
      const verdict = await options.validate({ api_key: "private-secret-value", account: "acct" });
      assert.deepEqual(verdict, { accepted: true, code: "CONNECTED" });
      return { status: "connected", code: "CONNECTED", message: "private-secret-value connected", values: { api_key: "must-not-escape" } };
    },
  };
  const service = createProviderCredentialService({ helperClient, platform: "darwin", arch: "arm64" });
  const result = await service.configure({
    connection_id: "profile-primary",
    fields,
    onState: (...args) => states.push(args),
    validate: async (values) => {
      assert.equal(values.api_key, "private-secret-value");
      return { accepted: true, code: "CONNECTED" };
    },
  });
  assert.deepEqual(states, [["validating"]]);
  assert.deepEqual(result, { status: "connected", code: "CONNECTED", credential_ref: "profile-primary" });
  assert.equal(Object.hasOwn(result, "message"), false);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.equal(calls[0].profileId, "profile-primary");
  assert.deepEqual(calls[0].fields, fields);
});

test("rejects traversal profile IDs before invoking the helper", async () => {
  let calls = 0;
  const helperClient = new Proxy({}, { get: () => async () => { calls += 1; } });
  const service = createProviderCredentialService({ helperClient, platform: "darwin", arch: "arm64" });
  await assert.rejects(service.read({ credential_ref: "../lovart-credentials-v1" }), (error) => error.code === "VALIDATION_FAILED");
  await assert.rejects(service.configure({ connection_id: "nested/profile", fields, validate: async () => ({ accepted: true, code: "CONNECTED" }) }), (error) => error.code === "VALIDATION_FAILED");
  assert.equal(calls, 0);
});

test("reads backend-only dynamic values and preserves a cancelled profile", async () => {
  const calls = [];
  const helperClient = {
    async read(options) { calls.push(["read", options]); return { api_key: "previous-secret" }; },
    async configure(options) { calls.push(["configure", options]); return { status: "setup_required", code: "SETUP_CANCELLED" }; },
    async status(options) { calls.push(["status", options]); return { status: "connected", code: "CONNECTED" }; },
    async clear(options) { calls.push(["clear", options]); return { status: "setup_required", code: "SETUP_REQUIRED" }; },
  };
  const service = createProviderCredentialService({ helperClient, platform: "darwin", arch: "arm64" });
  assert.deepEqual(await service.read({ credential_ref: "profile-primary" }), { api_key: "previous-secret" });
  assert.deepEqual(await service.configure({ connection_id: "profile-primary", fields, validate: async () => ({ accepted: true, code: "CONNECTED" }) }), {
    status: "setup_required", code: "SETUP_CANCELLED", credential_ref: "profile-primary",
  });
  assert.deepEqual(await service.read({ credential_ref: "profile-primary" }), { api_key: "previous-secret" });
  assert.deepEqual(await service.status({ credential_ref: "profile-primary" }), { status: "connected", code: "CONNECTED", credential_ref: "profile-primary" });
  assert.deepEqual(await service.clear({ credential_ref: "profile-primary" }), { status: "setup_required", code: "SETUP_REQUIRED", credential_ref: "profile-primary" });
  assert.deepEqual(calls.map(([operation]) => operation), ["read", "configure", "read", "status", "clear"]);
});

test("returns unsupported without launching the helper", async () => {
  let called = false;
  const helperClient = new Proxy({}, { get: () => async () => { called = true; } });
  const service = createProviderCredentialService({ helperClient, platform: "linux", arch: "x64" });
  assert.deepEqual(await service.status({ credential_ref: "profile-primary" }), {
    status: "unsupported", code: "PLATFORM_UNSUPPORTED", credential_ref: "profile-primary",
  });
  assert.equal(called, false);
});
