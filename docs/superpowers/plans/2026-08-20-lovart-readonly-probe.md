# Lovart Read-Only Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-disabled, single-request, read-only Lovart connectivity and workbench-capability probe without changing, importing, executing, reconnecting, or depending on the existing Lovart plugin.

**Architecture:** Two MCP tools create and consume a short-lived local authorization. The consuming tool atomically records the attempt, then launches a purpose-specific child process that alone reads two fixed macOS Keychain items, signs one fixed HTTPS request, normalizes the response against the local workbench model table, and returns only a redacted summary. Probe state is isolated from the workbench state and every production boundary is closed by default.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/sdk`, Zod, Node built-ins (`crypto`, `https`, `child_process`), macOS Security framework through a small Swift/AppKit credential helper, `node:test`, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-20-lovart-readonly-probe-design.md`

## Global Constraints

- Milestone 6 ends after fake-provider implementation, automated verification, plugin validation, security review, and protected-path comparison. Do not provision real credentials, enable the feature for a live run, or contact Lovart.
- Treat `/Users/a1234/Documents/ChatGPT/lovart插件` as read-only protected material. Do not modify, stage, commit, reconnect, import, execute, or reconfigure anything there.
- Preserve every existing user change and untracked file. Stage only the exact IMVIA paths named by each task; never use `git add .`.
- Do not add runtime dependencies. Keep the existing Lovart plugin at zero runtime dependency and zero code reuse.
- Production code may know only `https://lgw.lovart.ai`, `POST`, `/v1/openapi/mode/query`, body `{}`, and the two fixed Keychain identifiers. It may not accept generic endpoint, proxy, TLS, credential, model, project, thread, or retry parameters.
- Secrets must never enter parent-process arguments, environment, logs, test fixtures, MCP envelopes, state, audit events, or Git. Tests use marker values only inside fake child-local providers and assert that those markers never cross the boundary.
- All tests are offline. No automated test may resolve or connect to `lgw.lovart.ai`.
- Use `apply_patch` for edits. Run the narrow red test before production code, then the narrow green test, then the full relevant suite.
- Keep the feature flag default `false`. MCP tools cannot enable it.
- Do not alter M5 workbench behavior, schemas, fixture-only execution, cost confirmation, iteration, or the original 12 tool contracts.
- The pinned provenance is Skill `1.0.11`, client SHA-256 `39c68e32c2262f7f1b3890f684e33b149f9da3d5577fc591b7b4e640a87e4878`, Skill SHA-256 `561bba809f4ea2e4c4bbb1c02a34e494d21bb688e7a336a058156c26e71bd9d3`, origin `https://lgw.lovart.ai`, and operation `POST /v1/openapi/mode/query`.

## Preflight Gate

- [ ] Create an isolated implementation worktree and branch with `superpowers:using-git-worktrees`; use a `codex/` branch and start from the approved design commit.
- [ ] Run `git status --short --branch` in both the IMVIA worktree and protected Lovart repository. Record, but do not alter, all pre-existing changes.
- [ ] Run `pnpm test`. Expected baseline: the current 86-test inventory completes with 85 passes, zero failures, and the one documented standalone workspace skip.
- [ ] Run `python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .`. Expected: validation passes before implementation.
- [ ] Run `node '/Users/a1234/Documents/ChatGPT/lovart插件/imvia-studio/scripts/verify-protected-paths.mjs' verify imvia-studio/test/protected-paths.manifest.json`. This is the known-good read-only verifier at the original workspace depth; it does not execute Lovart runtime code. If it reports external drift, preserve the complete output and continue only with IMVIA-local fake-provider work. Do not update either copy of `test/protected-paths.manifest.json`. Final release remains blocked until the original manifest matches again or the user approves a separate governance action to rebaseline it.
- [ ] Save a read-only pre-implementation digest with `git -C '/Users/a1234/Documents/ChatGPT/lovart插件' status --short --branch` and the verifier output. Do not create a file inside the protected repository.

---

## Task 1: Isolate Probe Persistence Without Regressing Workbench State

**Files:**

- Modify: `src/persistence/json-store.js`
- Create: `src/probe/constants.js`
- Create: `src/probe/probe-store.js`
- Create: `test/json-store.test.mjs`
- Create: `test/probe-store.test.mjs`

- [ ] Write failing tests for the optional state filename, default behavior, permissions, and initial disabled probe state.

```js
// test/json-store.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStore } from "../src/persistence/json-store.js";

test("JsonStore preserves state.json as the default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-"));
  const store = new JsonStore({ dataDirectory: dir, createInitialState: () => ({ version: 1 }) });
  await store.read();
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1 });
});

test("JsonStore supports an isolated state filename with private permissions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-"));
  const store = new JsonStore({
    dataDirectory: dir,
    stateFileName: "lovart-probe-state-v1.json",
    createInitialState: () => ({ version: 1, enabled: false }),
  });
  await store.read();
  const statePath = path.join(dir, "lovart-probe-state-v1.json");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { version: 1, enabled: false });
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});
```

```js
// test/probe-store.test.mjs
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProbeStore } from "../src/probe/probe-store.js";

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
```

- [ ] Run `node --test test/json-store.test.mjs test/probe-store.test.mjs`. Expected failure: `ERR_MODULE_NOT_FOUND` for `src/probe/probe-store.js` or the custom filename assertion fails because `JsonStore` still writes `state.json`.

- [ ] Implement the filename seam and probe constants/store.

```js
// src/persistence/json-store.js constructor replacement
constructor({ dataDirectory, createInitialState, stateFileName = "state.json" }) {
  if (path.basename(stateFileName) !== stateFileName || !stateFileName.endsWith(".json")) {
    throw new TypeError("stateFileName must be a local .json filename");
  }
  this.dataDirectory = dataDirectory;
  this.createInitialState = createInitialState;
  this.statePath = path.join(dataDirectory, stateFileName);
}
```

```js
// src/probe/constants.js
export const PROBE_POLICY_VERSION = "lovart-readonly-probe-v1";
export const PROBE_STATE_FILE = "lovart-probe-state-v1.json";
export const PROBE_AUTHORIZATION_TTL_MS = 2 * 60 * 1000;
export const PROBE_RESULT_TTL_MS = 5 * 60 * 1000;
export const LOVART_ORIGIN = "https://lgw.lovart.ai";
export const LOVART_PATH = "/v1/openapi/mode/query";
export const LOVART_METHOD = "POST";
export const LOVART_BODY = "{}";
export const LOVART_TIMEOUT_MS = 8_000;
export const LOVART_MAX_RESPONSE_BYTES = 65_536;
export const KEYCHAIN_SERVICE = "ai.imvia.studio.lovart-readonly";
export const KEYCHAIN_ACCESS_ACCOUNT = "access-key";
export const KEYCHAIN_SECRET_ACCOUNT = "secret-key";
```

```js
// src/probe/probe-store.js
import { JsonStore } from "../persistence/json-store.js";
import { PROBE_STATE_FILE } from "./constants.js";

export function createInitialProbeState() {
  return { version: 1, enabled: false, authorizations: [], attempts: [], audit_events: [] };
}

export function createProbeStore({ dataDirectory }) {
  return new JsonStore({ dataDirectory, stateFileName: PROBE_STATE_FILE, createInitialState: createInitialProbeState });
}
```

- [ ] Run `node --test test/json-store.test.mjs test/probe-store.test.mjs`. Expected: all tests pass.
- [ ] Run `pnpm test`. Expected: no workbench persistence regression.
- [ ] Commit only these paths:

```bash
git add src/persistence/json-store.js src/probe/constants.js src/probe/probe-store.js test/json-store.test.mjs test/probe-store.test.mjs
git commit -m "feat: isolate Lovart probe state"
```

---

## Task 2: Implement Single-Use Current-Session Authorization

**Files:**

- Modify: `src/domain/workbench-service.js`
- Create: `src/domain/model-capabilities.js`
- Create: `src/probe/authorization-service.js`
- Create: `test/probe-authorization.test.mjs`

The public factory and methods established here are final for later tasks:

```ts
createProbeAuthorizationService({ store, now?: () => number, randomId?: () => string }) => {
  authorize(input: { source: "user:current_session"; reason: string; idempotency_key: string }): Promise<AuthorizationOutput>;
  beginProbe(input: { authorization_id: string; idempotency_key: string }): Promise<BeginProbeOutput>;
  completeProbe(input: { attempt_id: string; result: ProbeSummary }): Promise<ProbeSummary>;
  failProbe(input: { attempt_id: string; code: string }): Promise<void>;
  setEnabledForUserCommand(enabled: boolean): Promise<{ enabled: boolean }>;
}
```

- [ ] Write failing tests covering disabled authorization, idempotent creation, expiry, mismatched key, atomic one-winner consumption, durable pending attempt, completion replay, and failed-attempt non-reuse.

```js
// representative assertions in test/probe-authorization.test.mjs
test("feature disabled rejects before an authorization is created", async () => {
  const { service, store } = await fixture({ enabled: false });
  await assert.rejects(
    service.authorize({ source: "user:current_session", reason: "Check connectivity", idempotency_key: "auth-1" }),
    (error) => error.code === "PROBE_DISABLED",
  );
  assert.equal((await store.read()).authorizations.length, 0);
});

test("concurrent claims have exactly one winner", async () => {
  const { service } = await fixture({ enabled: true });
  const authorization = await service.authorize({
    source: "user:current_session",
    reason: "Check connectivity",
    idempotency_key: "auth-1",
  });
  const settled = await Promise.allSettled([
    service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
    service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-2" }),
  ]);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(settled.find(({ status }) => status === "rejected").reason.code, "PROBE_AUTHORIZATION_INVALID");
});

test("completed idempotency replay returns the stored summary without a new attempt", async () => {
  const { service, store } = await fixture({ enabled: true });
  const authorization = await service.authorize(validAuthorizationInput);
  const claim = await service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" });
  await service.completeProbe({ attempt_id: claim.attempt_id, result: sampleSummary });
  const replay = await service.beginProbe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" });
  assert.deepEqual(replay, { kind: "replay", result: sampleSummary });
  assert.equal((await store.read()).attempts.length, 1);
});
```

- [ ] Run `node --test test/probe-authorization.test.mjs`. Expected failure: `ERR_MODULE_NOT_FOUND` for `authorization-service.js`.

- [ ] First move the complete existing 15-entry `MODEL_CAPABILITIES` declaration byte-for-byte into the pure module `src/domain/model-capabilities.js` and export it; replace the declaration in `workbench-service.js` with one import. Then implement authorization with `DomainError`, canonical `new Date(ms).toISOString()` timestamps, exact input validation, and one `store.update()` for consume-plus-pending-attempt. This extraction changes no model entry or workbench behavior and gives summary validation a pure dependency.

```js
// src/probe/authorization-service.js core contract
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
      return store.update((state) => {
        const attempt = state.attempts.find((record) => record.id === attempt_id && record.status === "pending");
        if (!attempt) throw new DomainError("STORE_UNAVAILABLE", "pending probe attempt was not found");
        attempt.status = "failed";
        attempt.completed_at = new Date(now()).toISOString();
        attempt.error_code = errorCode;
        state.audit_events.push({ type: "probe_failed", attempt_id, code: errorCode, at: attempt.completed_at });
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
```

Keep these helpers private. `authorizationOutput` always returns the originally issued `consumed: false`; a later probe validates current durable consumption. `copyValidatedProbeSummary` constructs a new object field-by-field, and `requireStableProbeErrorCode` accepts only the Task 6 codes. Do not export a generic state mutator.

- [ ] Run `node --test test/probe-authorization.test.mjs`. Expected: all authorization, concurrency, replay, and non-reuse tests pass.
- [ ] Run `node --test test/probe-store.test.mjs test/probe-authorization.test.mjs`. Expected: all pass.
- [ ] Commit only:

```bash
git add src/domain/workbench-service.js src/domain/model-capabilities.js src/probe/authorization-service.js test/probe-authorization.test.mjs
git commit -m "feat: add single-use probe authorization"
```

---

## Task 3: Normalize Only the Workbench Capability Intersection

**Files:**

- Create: `src/probe/capability-normalizer.js`
- Create: `test/capability-normalizer.test.mjs`

Public contract:

```ts
normalizeLovartCapabilities(root: unknown, options?: { checkedAtMs?: number }) => ProbeSummary
```

- [ ] Write a table-driven failing test for all 15 local models, exact mappings, unknown mappings, unavailable mapped models, unknown upstream identifiers, billing-mode disposal, and fail-closed shapes.

```js
test("normalizer emits only local models with conservative availability", () => {
  const summary = normalizeLovartCapabilities({
    unlimited: true,
    available_models: {
      IMAGE: ["generate_image_nano_banana_pro", "unknown_upstream_model"],
      VIDEO: ["generate_video_seedance_v2_5"],
    },
    detail: { account: "must disappear" },
  }, { checkedAtMs: Date.parse("2026-08-20T00:00:00.000Z") });
  assert.equal(summary.capability_status, "available");
  assert.deepEqual(summary.workbench_models.find(({ name }) => name === "Seedance 2.5"), {
    name: "Seedance 2.5", mode: "video", availability: "available",
  });
  assert.equal(summary.workbench_models.find(({ name }) => name === "Kling 3.0").availability, "unavailable");
  assert.equal(summary.workbench_models.find(({ name }) => name === "Seedance 2.0 VIP").availability, "unknown");
  assert.equal(JSON.stringify(summary).includes("unlimited"), false);
  assert.equal(JSON.stringify(summary).includes("account"), false);
  assert.equal(JSON.stringify(summary).includes("unknown_upstream_model"), false);
});

test("valid connectivity with an unrecognized model-list shape is unknown", () => {
  const summary = normalizeLovartCapabilities({ unlimited: false, models: ["generate_video_seedance_v2_5"] });
  assert.equal(summary.reachable, true);
  assert.equal(summary.authenticated, true);
  assert.equal(summary.capability_status, "unknown");
  assert.ok(summary.workbench_models.every(({ availability }) => availability === "unknown"));
});

test("invalid root envelope fails closed", () => {
  assert.throws(() => normalizeLovartCapabilities([]), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
  assert.throws(() => normalizeLovartCapabilities({ unlimited: "yes" }), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
});
```

- [ ] Run `node --test test/capability-normalizer.test.mjs`. Expected failure: module not found.

- [ ] Import `MODEL_CAPABILITIES` from the pure module created in Task 2. This keeps filesystem/workbench authority out of the probe child. Implement a frozen explicit official-ID mapping and iterate the exported `Map` rather than copying the local inventory. Validate the root object and `unlimited` boolean. Treat missing or differently shaped `available_models` as a successful `unknown` result without fallback scanning.

```js
export const OFFICIAL_MODEL_IDS = Object.freeze({
  "Seedance 2.5": "generate_video_seedance_v2_5",
  "Seedance 2.0 VIP": null,
  "Seedance 2.0 Fast": "generate_video_seedance_v2_0_fast",
  "Minimax H3": "generate_video_minimax_h3",
  "Kling 3.0": "generate_video_kling_v3",
  "Kling 3.0 Omni": "generate_video_kling_v3_omni",
  "Seedream 4.0": "generate_image_seedream_v4",
  "Seedream 3.0": null,
  "Seedream 3.0 Fast": null,
  "Image 2": null,
  "Nano Banana Pro": "generate_image_nano_banana_pro",
  "Nano Banana 2": "generate_image_nano_banana_2",
  "Seedream 5.0": null,
  "Seedream 5.0 Lite": "generate_image_seedream_v5",
  Midjourney: "generate_image_midjourney",
});

export function normalizeLovartCapabilities(root, { checkedAtMs = Date.now() } = {}) {
  if (!root || Array.isArray(root) || typeof root !== "object" || typeof root.unlimited !== "boolean") {
    throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "Lovart response envelope was not recognized");
  }
  const lists = root.available_models;
  const recognized = lists && !Array.isArray(lists) && typeof lists === "object"
    && ["IMAGE", "VIDEO"].every((key) => lists[key] === undefined ||
      (Array.isArray(lists[key]) && lists[key].every((item) => typeof item === "string")));
  const available = recognized ? new Set([...(lists.IMAGE ?? []), ...(lists.VIDEO ?? [])]) : null;
  const checkedAt = new Date(checkedAtMs).toISOString();
  return {
    reachable: true,
    authenticated: true,
    service_version: null,
    capability_status: available ? "available" : "unknown",
    workbench_models: [...MODEL_CAPABILITIES].map(([name, capability]) => ({
      name, mode: capability.mode,
      availability: !available || !OFFICIAL_MODEL_IDS[name]
        ? "unknown"
        : available.has(OFFICIAL_MODEL_IDS[name]) ? "available" : "unavailable",
    })),
    checked_at: checkedAt,
    expires_at: new Date(checkedAtMs + PROBE_RESULT_TTL_MS).toISOString(),
    policy_version: PROBE_POLICY_VERSION,
  };
}
```

- [ ] Run `node --test test/capability-normalizer.test.mjs`. Expected: every mapping and fail-closed case passes.
- [ ] Run the existing workbench model tests plus this test. Expected: the local model table remains unchanged.
- [ ] Commit only:

```bash
git add src/probe/capability-normalizer.js test/capability-normalizer.test.mjs
git commit -m "feat: normalize Lovart capability intersection"
```

---

## Task 4: Build the Fixed One-Shot HTTPS Transport and Signing Contract

**Files:**

- Create: `src/probe/transport.js`
- Create: `test/probe-transport.test.mjs`

Public production contract intentionally accepts credentials and test seams only:

```ts
requestLovartModeQuery({
  accessKey: string;
  secretKey: string;
  nowSeconds?: () => number;
  randomId?: () => string;
  requestImpl?: typeof https.request;
}): Promise<object>
```

There is no origin, path, method, body, proxy, TLS, redirect, retry, timeout, or response-size option.

- [ ] Write a fake-`https.request` harness that records options and returns controlled responses. Add failing tests for exact method/host/path/body/signing headers, 8-second timeout, no retry, redirect rejection, 401/403/429/5xx mapping, TLS/network mapping, 64 KiB limit, JSON-object validation, and absence of proxy environment use.

```js
test("transport performs exactly one fixed signed request", async () => {
  const fake = createHttpsHarness([{ statusCode: 200, body: '{"unlimited":true}' }]);
  await requestLovartModeQuery({
    accessKey: "marker-access",
    secretKey: "marker-secret",
    nowSeconds: () => 1_777_000_000,
    randomId: () => "0123456789abcdef0123456789abcdef",
    requestImpl: fake.request,
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.protocol, "https:");
  assert.equal(fake.calls[0].options.hostname, "lgw.lovart.ai");
  assert.equal(fake.calls[0].options.port, 443);
  assert.equal(fake.calls[0].options.method, "POST");
  assert.equal(fake.calls[0].options.path, "/v1/openapi/mode/query");
  assert.equal(fake.calls[0].options.rejectUnauthorized, true);
  assert.equal(fake.calls[0].body, "{}");
  assert.equal("proxy" in fake.calls[0].options, false);
  assert.equal(fake.calls[0].options.headers["X-Signed-Method"], "POST");
  assert.equal(fake.calls[0].options.headers["X-Signed-Path"], "/v1/openapi/mode/query");
  assert.equal(fake.calls[0].options.headers["Idempotency-Key"], "0123456789abcdef0123456789abcdef");
  assert.equal(JSON.stringify(fake.calls[0]).includes("marker-secret"), false);
});

test("429 is stable and never retried", async () => {
  const fake = createHttpsHarness([{ statusCode: 429, body: "rate limited" }]);
  await assert.rejects(
    requestLovartModeQuery({ accessKey: "a", secretKey: "s", requestImpl: fake.request }),
    (error) => error.code === "UPSTREAM_RATE_LIMITED",
  );
  assert.equal(fake.calls.length, 1);
});
```

- [ ] Run `node --test test/probe-transport.test.mjs`. Expected failure: module not found.

- [ ] Implement the pinned `1.0.11` signing contract exactly: HMAC-SHA256 over `METHOD + "\n" + PATH + "\n" + UNIX_SECONDS` with the secret key. Include the five official `X-*` signing headers, fixed JSON content type, fixed Lovart user agent, and one internally generated idempotency key. The body is not part of the signature. Use fixed request options and exactly one request allocation. Start one eight-second wall-clock timer immediately before `requestImpl`; clear it on every terminal path and destroy the request with a redacted timeout error when it fires. Count response bytes before concatenation and destroy on overflow. Never include headers, body, credentials, or upstream response text in an error.

```js
const signaturePayload = `${LOVART_METHOD}\n${LOVART_PATH}\n${timestamp}`;
const signature = createHmac("sha256", secretKey).update(signaturePayload, "utf8").digest("hex");
const options = {
  protocol: "https:", hostname: "lgw.lovart.ai", port: 443,
  method: LOVART_METHOD, path: LOVART_PATH,
  rejectUnauthorized: true,
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(LOVART_BODY),
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LovartAgentSkill/1.0",
    "X-Access-Key": accessKey,
    "X-Timestamp": String(timestamp),
    "X-Signature": signature,
    "X-Signed-Method": LOVART_METHOD,
    "X-Signed-Path": LOVART_PATH,
    "Idempotency-Key": randomId().replaceAll("-", ""),
  },
};
```

The implementation must keep this exact pinned contract. Any future upstream change requires a new reviewed spec; it is not absorbed during this milestone.

- [ ] Run `node --test test/probe-transport.test.mjs`. Expected: all fixed-boundary and zero-retry tests pass.
- [ ] Run `rg -n 'http_proxy|https_proxy|all_proxy|rejectUnauthorized:\s*false|follow|redirect|retry|origin\s*[:=]|url\s*[:=]' src/probe/transport.js`. Expected: no insecure, proxy, redirect-following, retry, or configurable-destination code.
- [ ] Commit only:

```bash
git add src/probe/transport.js test/probe-transport.test.mjs
git commit -m "feat: add fixed Lovart read-only transport"
```

---

## Task 5: Keep Credentials and Raw Responses Inside the Child Process

**Files:**

- Create: `src/probe/keychain-provider.js`
- Create: `src/probe/child-core.js`
- Create: `src/probe/child.js`
- Create: `src/probe/child-runner.js`
- Create: `test/probe-child.test.mjs`

Final interfaces:

```ts
readProbeCredentials({ execFile?: typeof childProcess.execFile, platform?: string }): Promise<{ accessKey: string; secretKey: string }>;
runReadOnlyProbe({ keychainProvider, transport, normalizer, now?: () => number }): Promise<ProbeSummary>;
createProbeChildRunner({ nodePath?: string, childPath?: string, spawnProcess?: typeof spawn }) => { run(): Promise<ProbeSummary> };
```

- [ ] Write failing unit tests that inject fake Keychain and transport providers into `runReadOnlyProbe`, prove missing credentials cause zero transport calls, prove marker secrets do not occur in the normalized result/error, and test the parent runner with a fake spawned child. Add a static test that `child.js` accepts no user arguments and that the runner passes no credential values or inherited environment.

```js
test("child core keeps fake credentials out of its result", async () => {
  let received;
  const result = await runReadOnlyProbe({
    keychainProvider: async () => ({ accessKey: "ACCESS_MARKER", secretKey: "SECRET_MARKER" }),
    transport: async (credentials) => {
      received = credentials;
      return { unlimited: true, available_models: { IMAGE: [], VIDEO: [] } };
    },
    normalizer: normalizeLovartCapabilities,
    now: () => Date.parse("2026-08-20T00:00:00.000Z"),
  });
  assert.deepEqual(received, { accessKey: "ACCESS_MARKER", secretKey: "SECRET_MARKER" });
  assert.equal(JSON.stringify(result).includes("ACCESS_MARKER"), false);
  assert.equal(JSON.stringify(result).includes("SECRET_MARKER"), false);
});

test("missing Keychain credentials produce zero network calls", async () => {
  let transportCalls = 0;
  await assert.rejects(runReadOnlyProbe({
    keychainProvider: async () => { throw Object.assign(new Error("denied"), { code: "CREDENTIAL_REFERENCE_UNAVAILABLE" }); },
    transport: async () => { transportCalls += 1; },
    normalizer: normalizeLovartCapabilities,
  }), (error) => error.code === "CREDENTIAL_REFERENCE_UNAVAILABLE");
  assert.equal(transportCalls, 0);
});
```

- [ ] Run `node --test test/probe-child.test.mjs`. Expected failure: one or more child modules are missing.

- [ ] Implement `readProbeCredentials` with `/usr/bin/security` and fixed argument arrays, never a shell. Invoke `find-generic-password -s ai.imvia.studio.lovart-readonly -a access-key -w` and then the fixed secret account. Map all failures to `CREDENTIAL_REFERENCE_UNAVAILABLE` without returning `stderr`.

- [ ] Implement `child-core.js` so credentials are local variables used once, the raw object is immediately passed to `normalizer(raw, { checkedAtMs: now() })`, and only a normalized summary returns. Implement `child.js` as a no-argument executable that writes exactly one JSON envelope to stdout:

```json
{"ok":true,"result":{"reachable":true,"authenticated":true,"service_version":null,"capability_status":"available","workbench_models":[],"checked_at":"2026-08-20T00:00:00.000Z","expires_at":"2026-08-20T00:05:00.000Z","policy_version":"lovart-readonly-probe-v1"}}
```

On failure it writes only `{"ok":false,"error":{"code":"STABLE_CODE","message":"redacted stable message"}}`; no stack, cause, raw response, identifier, header, or credential.

- [ ] Implement `child-runner.js` with `spawn(nodePath, [childPath], { shell: false, env: { LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] })`. Bound stdout to 65,536 bytes and stderr to 4,096 bytes, kill on overflow, accept exactly one valid envelope, and map malformed/abnormal child exits to `UPSTREAM_UNREACHABLE` without echoing child output. The only production child argument is its fixed script path.

- [ ] Run `node --test test/probe-child.test.mjs`. Expected: all isolation and child-boundary tests pass.
- [ ] Run `rg -n 'process\.argv|process\.env|shell:\s*true|ACCESS_MARKER|SECRET_MARKER' src/probe`. Expected: no argument parsing, inherited environment use, shell execution, or test marker in production.
- [ ] Commit only:

```bash
git add src/probe/keychain-provider.js src/probe/child-core.js src/probe/child.js src/probe/child-runner.js test/probe-child.test.mjs
git commit -m "feat: isolate Lovart credentials in probe child"
```

---

## Task 6: Orchestrate Probe Claims, Failures, and Stable Replays

**Files:**

- Create: `src/probe/probe-service.js`
- Create: `test/probe-service.test.mjs`

Public factory:

```ts
createLovartProbeService({ authorizationService, runner, platform?: string }) => {
  authorize(input): Promise<AuthorizationOutput>;
  probe(input): Promise<ProbeSummary>;
}
```

- [ ] Write failing service tests for disabled, unsupported platform, success, authentication rejection, timeout, missing Keychain, schema failure, final-store-write failure, completed replay, and concurrent claim. Count runner calls in every case. Assert `authenticated` is `true` only on valid success, `false` only for 401/403, and `null` for network/TLS/timeout/schema failures.

```js
test("successful replay performs no second child run", async () => {
  const fixture = await enabledFixture();
  let childRuns = 0;
  const service = createLovartProbeService({
    authorizationService: fixture.authorizationService,
    runner: { run: async () => { childRuns += 1; return sampleSummary; } },
    platform: "darwin",
  });
  const authorization = await service.authorize(validAuthorizationInput);
  const input = { authorization_id: authorization.authorization_id, idempotency_key: "probe-1" };
  assert.deepEqual(await service.probe(input), sampleSummary);
  assert.deepEqual(await service.probe(input), sampleSummary);
  assert.equal(childRuns, 1);
});

test("unsupported platform does not consume or launch", async () => {
  const fixture = await enabledFixture();
  let childRuns = 0;
  const service = createLovartProbeService({
    authorizationService: fixture.authorizationService,
    runner: { run: async () => { childRuns += 1; } },
    platform: "linux",
  });
  const authorization = await service.authorize(validAuthorizationInput);
  await assert.rejects(
    service.probe({ authorization_id: authorization.authorization_id, idempotency_key: "probe-1" }),
    (error) => error.code === "PLATFORM_UNSUPPORTED",
  );
  assert.equal(childRuns, 0);
});
```

- [ ] Run `node --test test/probe-service.test.mjs`. Expected failure: module not found.

- [ ] Implement the exact order: validate platform; call `beginProbe`; return a completed replay immediately; run child once for a claimed attempt; complete the durable attempt; on child failure call `failProbe` with code only and rethrow a stable `DomainError`. Never retry, never restore the authorization, and never mutate workbench state.

```js
export function createLovartProbeService({ authorizationService, runner, platform = process.platform }) {
  return {
    authorize: (input) => authorizationService.authorize(input),
    async probe(input) {
      if (platform !== "darwin") {
        throw new DomainError("PLATFORM_UNSUPPORTED", "Lovart read-only probe requires macOS Keychain", { authenticated: null });
      }
      const claim = await authorizationService.beginProbe(input);
      if (claim.kind === "replay") return claim.result;
      try {
        const result = await runner.run();
        return await authorizationService.completeProbe({ attempt_id: claim.attempt_id, result });
      } catch (error) {
        const code = stableProbeCode(error?.code);
        await authorizationService.failProbe({ attempt_id: claim.attempt_id, code }).catch(() => undefined);
        throw new DomainError(code, stableProbeMessage(code), {
          authenticated: code === "AUTHENTICATION_FAILED" ? false : null,
        });
      }
    },
  };
}
```

`stableProbeCode` must allow only the design codes: `CREDENTIAL_REFERENCE_UNAVAILABLE`, `UPSTREAM_UNREACHABLE`, `UPSTREAM_SECURITY_REJECTED`, `AUTHENTICATION_FAILED`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_SCHEMA_UNRECOGNIZED`, and `STORE_UNAVAILABLE`; map all other child failures to `UPSTREAM_UNREACHABLE`. Failure envelopes expose only `details.authenticated`: `false` for `AUTHENTICATION_FAILED` and `null` for every other failure. A successful summary always has `authenticated: true`.

- [ ] Run `node --test test/probe-service.test.mjs`. Expected: all failure-matrix, call-count, replay, and durable-consumption tests pass.
- [ ] Run `node --test test/probe-authorization.test.mjs test/probe-service.test.mjs`. Expected: all pass.
- [ ] Commit only:

```bash
git add src/probe/probe-service.js test/probe-service.test.mjs
git commit -m "feat: orchestrate read-only Lovart probe"
```

---

## Task 7: Expose Exactly Two Narrow MCP Tools

**Files:**

- Modify: `src/index.js`
- Modify: `test/mcp-health.test.mjs`
- Create: `test/mcp-probe.test.mjs`

- [ ] Write failing MCP tests that expect exactly 14 tool names, validate both schemas, reject every prohibited probe input field through strict Zod objects, verify stable success/error envelopes, and prove the original 12 schemas are unchanged.

```js
const expectedTools = [
  "imvia_authorize_lovart_probe", "imvia_claim_cost_decision",
  "imvia_create_iteration", "imvia_get_account_status", "imvia_get_state",
  "imvia_health", "imvia_import_result", "imvia_list_pending_jobs",
  "imvia_patch_workbench", "imvia_prepare_generation",
  "imvia_probe_lovart_capabilities", "imvia_record_cost_decision",
  "imvia_update_account_status", "imvia_update_job",
].sort();
assert.deepEqual(tools.map(({ name }) => name).sort(), expectedTools);
```

```js
test("probe schema rejects authority expansion", async () => {
  for (const prohibited of ["url", "origin", "path", "method", "credential", "credential_reference", "retry", "tls", "proxy", "model", "project", "thread", "account"]) {
    const result = await callTool("imvia_probe_lovart_capabilities", {
      authorization_id: "auth-1", idempotency_key: "probe-1", [prohibited]: "forbidden",
    });
    assert.equal(result.isError, true, prohibited);
  }
});
```

- [ ] Run `node --test test/mcp-health.test.mjs test/mcp-probe.test.mjs`. Expected failure: inventory remains 12 and the new tools are unknown.

- [ ] Extend `createServer` with injected `probeService` and `dataDirectory` seams while preserving existing callers:

```js
export function createServer({
  service: providedService,
  probeService: providedProbeService,
  httpService = null,
  dataDirectory: providedDataDirectory,
} = {}) {
```

Inside the factory, resolve `stateDirectory` from `providedDataDirectory`, then `IMVIA_DATA_DIR`, then the existing `.imvia-studio-dev` default. Keep `service = providedService ?? createWorkbenchService(...)`. When `providedProbeService` is absent, create `probeStore`, `authorizationService`, `childRunner`, and `createLovartProbeService` in that order; when it is present, instantiate none of those production dependencies. Leave every existing registration statement unchanged and add only the two registrations below. In `startServer()`, create the production probe service once and pass it into `createServer` so workbench HTTP and MCP still share the same existing workbench service.

Register strict schemas:

```js
const authorizeProbeInput = z.object({
  source: z.literal("user:current_session"),
  reason: z.string().trim().min(1),
  idempotency_key: z.string().trim().min(1),
}).strict();

const runProbeInput = z.object({
  authorization_id: z.string().trim().min(1),
  idempotency_key: z.string().trim().min(1),
}).strict();
```

The handlers call only `probeService.authorize` and `probeService.probe` through the existing structured domain-response wrapper. `startServer()` creates the probe store/service/runner from the same data directory but never enables it.

- [ ] Run `node --test test/mcp-health.test.mjs test/mcp-probe.test.mjs`. Expected: exactly 14 tools and all strict-schema/envelope tests pass.
- [ ] Run `pnpm run test:mcp`. Expected: pass after adding `test/mcp-probe.test.mjs` to the script in Task 8; until then run the direct command above.
- [ ] Commit only:

```bash
git add src/index.js test/mcp-health.test.mjs test/mcp-probe.test.mjs
git commit -m "feat: expose Lovart probe MCP tools"
```

---

## Task 8: Add User-Only Secure Configuration and Feature-Flag Commands

**Files:**

- Create: `scripts/configure-lovart-readonly.swift`
- Create: `scripts/set-lovart-readonly-probe.mjs`
- Modify: `package.json`
- Create: `test/probe-config-scripts.test.mjs`

- [ ] Write failing static and behavioral tests. The static test must require `NSSecureTextField`, `SecItemAdd`/`SecItemUpdate`, the fixed service/accounts, and reject `CommandLine.arguments`, `ProcessInfo.processInfo.environment`, stdin reads, secret printing, shell execution, and dynamic service/account inputs. The Node command test uses a temporary `IMVIA_DATA_DIR`, toggles only `enabled`, and preserves audit history.

```js
test("credential helper uses protected GUI input and fixed Keychain items", async () => {
  const source = await readFile("scripts/configure-lovart-readonly.swift", "utf8");
  assert.match(source, /NSSecureTextField/);
  assert.match(source, /SecItem(Add|Update)/);
  assert.match(source, /ai\.imvia\.studio\.lovart-readonly/);
  assert.match(source, /access-key/);
  assert.match(source, /secret-key/);
  for (const forbidden of ["CommandLine.arguments", "processInfo.environment", "readLine(", "standardInput", "print(access", "print(secret", "/bin/sh"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("flag command changes enabled only", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-flag-"));
  await execFile(process.execPath, ["scripts/set-lovart-readonly-probe.mjs", "enable"], {
    env: { ...process.env, IMVIA_DATA_DIR: dataDirectory },
  });
  const state = JSON.parse(await readFile(path.join(dataDirectory, "lovart-probe-state-v1.json"), "utf8"));
  assert.equal(state.enabled, true);
  assert.deepEqual(state.authorizations, []);
  assert.deepEqual(state.attempts, []);
});
```

- [ ] Run `node --test test/probe-config-scripts.test.mjs`. Expected failure: helper scripts are missing.

- [ ] Implement the Swift AppKit helper. It must show a modal window with two `NSSecureTextField` controls, require non-empty values, and use Security framework dictionaries with fixed `kSecClassGenericPassword`, service, and account constants. Use `SecItemCopyMatching` only to decide add versus update; do not convert existing secret data to a printable string. Clear the text fields and temporary `Data` values after each write as far as Swift value semantics permit. Print only a fixed success/failure message without Keychain status details that could contain user data.

- [ ] Implement `scripts/set-lovart-readonly-probe.mjs`. Accept exactly one positional token, `enable` or `disable`; reject all other arguments. Resolve `IMVIA_DATA_DIR` or the same `.imvia-studio-dev` default as the server, instantiate the isolated probe store and authorization service, and call only `setEnabledForUserCommand`. It must not import Keychain, transport, child, or MCP modules.

- [ ] Add only targeted scripts and keep dependencies unchanged:

```json
"configure:lovart-readonly": "swift scripts/configure-lovart-readonly.swift",
"enable:lovart-readonly-probe": "node scripts/set-lovart-readonly-probe.mjs enable",
"disable:lovart-readonly-probe": "node scripts/set-lovart-readonly-probe.mjs disable",
"test:probe": "node --test test/json-store.test.mjs test/probe-*.test.mjs test/capability-normalizer.test.mjs test/mcp-probe.test.mjs",
"test:mcp": "node --test test/mcp-health.test.mjs test/mcp-probe.test.mjs"
```

Do not run dependency installation: scripts do not require lockfile changes. Run `git diff --exit-code -- pnpm-lock.yaml` and compare `package.json` dependencies before and after; both must be unchanged.

- [ ] Run `node --test test/probe-config-scripts.test.mjs`. Expected: all static and toggle tests pass.
- [ ] On macOS run `swiftc -typecheck scripts/configure-lovart-readonly.swift`. Expected: exit 0. On non-macOS, record a deliberate platform skip; do not install a compiler.
- [ ] Run `pnpm run test:probe`. Expected: all probe tests pass offline.
- [ ] Commit only:

```bash
git add scripts/configure-lovart-readonly.swift scripts/set-lovart-readonly-probe.mjs package.json test/probe-config-scripts.test.mjs
git commit -m "feat: add secure Lovart probe setup commands"
```

---

## Task 9: Enforce the Security Boundary as Executable Policy

**Files:**

- Create: `test/probe-security.test.mjs`
- Modify: `scripts/verify-protected-paths.mjs`
- Modify: `test/protected-paths.test.mjs`
- Modify: `package.json`

- [ ] Write failing security tests that recursively inspect production files under `src/probe`, `src/index.js`, and the two new scripts. Require the pinned provenance constants and fixed endpoint, and reject:

  - filesystem paths or imports containing the existing Lovart plugin/worktree/cache;
  - upload, generation, confirmation, project, thread, result-query, status-query, balance, or generic request-operation exports/endpoints in production probe code;
  - configurable origin/URL/path/method/proxy/TLS/retry fields;
  - `rejectUnauthorized: false`, redirect following, shell execution, inherited parent environment, or real-network test code;
  - credential values, raw response persistence, request headers, signatures, account identifiers, billing mode, or balance in probe state/audit schemas.

```js
test("production probe has no existing Lovart plugin dependency or write authority", async () => {
  const production = await readProductionProbeSources();
  for (const forbidden of ["lovart-codex-plugin", "/lovart插件", ".codex/plugins/cache/lovart",
    "rejectUnauthorized: false", "shell: true", "process.env.HTTP_PROXY", "process.env.HTTPS_PROXY"]) {
    assert.equal(production.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.doesNotMatch(production, /export\s+(?:async\s+)?function\s+(?:upload|generate|confirm|createProject|createThread|queryResult|queryStatus|queryBalance)\b/i);
  assert.doesNotMatch(production, /\/(?:upload|generate|confirm|projects?|threads?|results?|status|balance)(?:\/|["'])/i);
});

test("transport provenance and allowlist remain pinned", async () => {
  const constants = await readFile("src/probe/constants.js", "utf8");
  assert.match(constants, /https:\/\/lgw\.lovart\.ai/);
  assert.match(constants, /\/v1\/openapi\/mode\/query/);
  assert.match(constants, /39c68e32c2262f7f1b3890f684e33b149f9da3d5577fc591b7b4e640a87e4878/);
  assert.match(constants, /561bba809f4ea2e4c4bbb1c02a34e494d21bb688e7a336a058156c26e71bd9d3/);
});
```

- [ ] Run `node --test test/probe-security.test.mjs`. Expected failure: provenance hashes are not yet exported from `constants.js` and any overly broad production identifiers are reported.

- [ ] Add `LOVART_SKILL_VERSION`, `LOVART_CLIENT_SHA256`, and `LOVART_SKILL_SHA256` to `src/probe/constants.js`. Refactor only findings that represent actual authority expansion or leakage. Do not weaken deny lists to make tests pass; use token-aware checks when a harmless word such as the output field `service_version` would otherwise create a false positive.

- [ ] Add a red regression to `test/protected-paths.test.mjs` showing that live-workspace detection is derived from `test/protected-paths.manifest.json` roots and supports both layouts: IMVIA nested beside the roots, or this independent repository beside a `lovart插件/` directory containing the roots. Run `node --test test/protected-paths.test.mjs`. Expected failure in this workspace: the live test is incorrectly skipped by the stale hard-coded lookup.
- [ ] Make manifest resolution portable without changing fingerprint contents. In `scripts/verify-protected-paths.mjs`, set `packageDirectory` to the IMVIA repository root and resolve a relative manifest argument against it. After reading that manifest, select the protected base from exactly two candidates: `path.dirname(packageDirectory)` and `path.join(path.dirname(packageDirectory), "lovart插件")`; choose the first candidate under which every manifest root exists and fail clearly if neither matches. Absolute temporary manifest paths remain supported, and the existing mutation test must still stay within one of those two bases. Apply the same two-candidate check in `test/protected-paths.test.mjs` for `hasProtectedWorkspace`. Change the package script to `node scripts/verify-protected-paths.mjs verify test/protected-paths.manifest.json`.
- [ ] Run `node --test test/probe-security.test.mjs test/protected-paths.test.mjs`. Expected: security tests pass; the live protected-path test now runs and either passes or reports only the preflight external drift. Any new drift created during this implementation is a stop condition.
- [ ] Run `git -C '/Users/a1234/Documents/ChatGPT/lovart插件' status --short --branch` and compare it with preflight, then run `pnpm run verify:protected-paths`. Expected: this implementation created no new protected-path change. Do not clean, reset, or stage anything in the protected repository.
- [ ] Commit only IMVIA files:

```bash
git add src/probe/constants.js test/probe-security.test.mjs scripts/verify-protected-paths.mjs test/protected-paths.test.mjs package.json
git commit -m "test: enforce Lovart probe security boundary"
```

Never stage or modify `test/protected-paths.manifest.json` in this task.

---

## Task 10: Publish the Milestone 6 Contract and Run Release Gates

**Files:**

- Modify: `README.md`
- Modify: `skills/imvia-studio/SKILL.md`
- Modify: `test/skill-contract.test.mjs`
- Modify: `.codex-plugin/plugin.json`
- Modify: `package.json`
- Modify: `src/index.js`

- [ ] First extend `test/skill-contract.test.mjs` with failing exact-phrase and ordering assertions. Preserve all M5 fixture-only and cost-confirmation phrases. Require the M6 Skill section to say:

  1. the user must explicitly request the read-only probe in the current conversation;
  2. general permission, a queued job, earlier approval, or fixture decision is insufficient;
  3. call `imvia_authorize_lovart_probe` before `imvia_probe_lovart_capabilities`;
  4. feature disabled, unsupported platform, invalid/expired/consumed authorization, or missing credential reference must produce zero Lovart requests;
  5. an idempotent completed replay must perform zero Keychain reads and zero Lovart requests;
  6. the probe is advisory and must not alter job, draft, artifact, cost, iteration, or execution behavior;
  7. never upload, generate, confirm, query projects/threads/status/results/balance, expose AK/SK, or call the existing Lovart plugin.

- [ ] Run `node --test test/skill-contract.test.mjs`. Expected failure: Milestone 6 contract phrases are absent.

- [ ] Update `skills/imvia-studio/SKILL.md` with a narrow “Milestone 6 read-only Lovart probe” section after the complete M5 workflow. Do not delete or relax any M5 rule. Make the current-session authorization and zero-call conditions imperative and exact enough for the test.

- [ ] Update `README.md` with architecture, default-disabled status, macOS-only Keychain requirement, user-run configure/enable/disable commands, the two MCP tool contracts, stable error codes, redacted state location, offline verification commands with an explicit repository-root working directory, and a conspicuous statement that no live probe/generation is authorized by installation or tests.

- [ ] Bump the independent plugin version consistently from `0.1.0` to `0.2.0` in `.codex-plugin/plugin.json`, `package.json`, and `src/index.js`. Describe the capability as an optional default-disabled read-only probe. Do not add dependencies and do not change the MCP Server ID `imvia-studio`.

- [ ] Run `node --test test/skill-contract.test.mjs test/mcp-health.test.mjs test/mcp-probe.test.mjs`. Expected: Skill contract, 14-tool inventory, and MCP behavior pass.
- [ ] Run `pnpm test`. Expected in a clean protected workspace: all legacy and new tests pass, with the live fingerprint test skipped only in a standalone clone. If the preflight external drift remains, require every test except the live fingerprint comparison to pass, preserve that single failure as evidence, and keep release/live-probe gates blocked.
- [ ] Run `pnpm run test:orchestration`. Expected: every M5 fixture, source, cost, iteration, and policy test passes unchanged.
- [ ] Run `pnpm run test:probe` and `pnpm run test:mcp`. Expected: pass with zero real network calls.
- [ ] Run `python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .`. Expected: validation passes for MCP Server ID `imvia-studio` and version `0.2.0`.
- [ ] Run `pnpm run verify:protected-paths` and compare it with the preflight output. Expected: no implementation-caused difference. If the external baseline drift still exists, report the exact same drift and leave release/live-probe gates blocked; do not edit the protected manifest.
- [ ] Inspect staged content before committing:

```bash
git status --short
git diff --check
git diff --stat
git diff -- README.md skills/imvia-studio/SKILL.md test/skill-contract.test.mjs .codex-plugin/plugin.json package.json src/index.js
```

- [ ] Commit only the listed files:

```bash
git add README.md skills/imvia-studio/SKILL.md test/skill-contract.test.mjs .codex-plugin/plugin.json package.json src/index.js
git commit -m "docs: publish Milestone 6 read-only probe"
```

- [ ] Perform a final secret and scope scan:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' '\b(AK|SK)\b|access.?key|secret.?key|authorization:|x-signature|raw.?response' .
git status --short --branch
git log --oneline --decorate -12
```

Review every match. Fixed non-secret Keychain account labels and test assertions are allowed; credential values, headers, signatures, raw bodies, or protected-plugin paths in production are not.

- [ ] Request code review focused on authorization concurrency, child isolation, transport allowlisting, secret leakage, state durability, and M5 regression. Fix all Critical/Important findings with new red tests and exact-path commits.
- [ ] Push the implementation branch and update the existing draft PR only after all fake-provider gates pass. Keep the PR draft while protected-path verification is externally blocked.
- [ ] Stop. Do not run `pnpm run configure:lovart-readonly`, do not enable the probe, do not invoke either new MCP tool against real credentials, and do not contact Lovart. A real read-only probe is a separate user authorization after implementation security review.

## Final Acceptance Checklist

- [ ] Exactly 14 MCP tools; original 12 contracts unchanged.
- [ ] Feature defaults disabled and only the user-run local command can toggle it.
- [ ] Two-minute single-use authorization is consumed atomically before Keychain/network access.
- [ ] Completed idempotent replay performs zero Keychain reads and zero network requests.
- [ ] At most one fixed HTTPS request, zero redirects, zero retries, mandatory TLS, 8-second total timeout, 65,536-byte response cap.
- [ ] Credentials and raw response remain inside the child process and never persist or cross the parent boundary.
- [ ] Only the 15-entry local workbench intersection is emitted; unknown and unavailable remain distinct.
- [ ] All stable error codes and tri-state authentication semantics match the design.
- [ ] Probe state is isolated, private, redacted, and advisory.
- [ ] No production Lovart upload/generation/confirmation/project/thread/status/result/balance capability exists.
- [ ] No existing Lovart plugin import, execution, write, reconnect, or configuration exists.
- [ ] Full tests, plugin validation, security scan, and protected-path comparison are recorded.
- [ ] No live Lovart probe or credential provisioning occurred.

## Plan Self-Review

- Spec coverage: Tasks 1–2 cover isolated state, default-disabled policy, two-minute authorization, atomic consumption, durable attempts, and replay. Tasks 3–6 cover the 15-model intersection, fixed signed transport, Keychain child boundary, failure matrix, five-minute summaries, and zero retries. Tasks 7–10 cover the two MCP contracts, secure user commands, executable security policy, existing-plugin protection, Skill/README contract, validation, and release gates.
- Type consistency: `ProbeSummary` is created only by `normalizeLovartCapabilities`, copied field-by-field by `completeProbe`, returned unchanged by replay, serialized by the child envelope, parsed by `child-runner`, and returned by `probeService.probe`. `AuthorizationOutput` and `BeginProbeOutput` have one definition in Task 2 and are consumed unchanged in Tasks 6–7.
- Authority consistency: only `child-core.js` receives credentials and raw response data; only `transport.js` has network authority; only the user command reaches `setEnabledForUserCommand`; neither new MCP handler has any of those direct capabilities.
- Placeholder scan: the plan contains no `TODO`, `TBD`, `FIXME`, omitted implementation body, dynamic endpoint decision, or unresolved product choice. Conditional language is limited to observed platform/workspace state and does not alter the approved design.
- Stop condition: this plan ends before credential provisioning, feature enablement for a live run, real Lovart connectivity, generation, or any next milestone.
