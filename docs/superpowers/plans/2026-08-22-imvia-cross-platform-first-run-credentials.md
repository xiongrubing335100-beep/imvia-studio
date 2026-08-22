# IMVIA Studio Cross-Platform First-Run Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a first-workbench-open Lovart credential flow for macOS and Windows that uses IMVIA-owned system credentials, ships precompiled native helpers, and requires no developer tooling on user machines.

**Architecture:** A versioned Rust helper provides native secure input and platform credential-store access. Node resolves and integrity-checks the packaged helper, performs the existing fixed-endpoint Lovart validation through a private stdio handshake, and exposes only redacted onboarding state to MCP, HTTP, SSE, and the workbench. The workbench renders onboarding separately from its connected-only status rail.

**Tech Stack:** Node.js ESM, Node built-in test runner, MCP SDK, loopback HTTP/SSE, Rust 2021, `serde`/`serde_json`, `zeroize`, macOS AppKit and Security Framework, Windows CredUI and Credential Manager APIs, GitHub Actions build matrix.

**Spec:** `docs/superpowers/specs/2026-08-22-imvia-cross-platform-first-run-credentials-design.md`

## Global Constraints

- Support `darwin-arm64`, `darwin-x64`, `win32-arm64`, and `win32-x64`.
- IMVIA credential namespaces are exactly `ai.imvia.studio.lovart` / `credentials` on macOS and `IMVIA.Studio.Lovart` on Windows.
- Never query, migrate, overwrite, or infer any state owned by the existing Lovart plugin.
- Never place Access Key or Secret Key in command arguments, environment variables, URLs, browser state, HTTP, MCP, logs, JSON state, analytics, or test snapshots.
- Never invoke `swift`, `powershell`, `cmd`, a compiler, or a source script at runtime.
- First workbench open is the executable onboarding boundary; plugin installation performs no Lovart request and starts no custom process.
- Credential setup does not activate upload, project creation, generation, cost confirmation, or any chargeable action.
- Preserve the user's existing uncommitted changes. Before each overlapping edit, inspect the current diff and merge intentionally.
- Do not modify `/Users/a1234/Documents/ChatGPT/lovart插件` or any protected Lovart path.
- Use TDD, make one focused commit per task, and stage only the files listed by that task.

## File Structure

### New Node modules

- `src/lovart/helper-manifest.js`: platform/architecture mapping, manifest parsing, digest verification, and helper path confinement.
- `src/lovart/helper-client.js`: shell-free child-process lifecycle and versioned NDJSON protocol.
- `src/lovart/onboarding-service.js`: single-flight first-run state machine and redacted subscriptions.

### Native helper

- `native/credential-helper/Cargo.toml`: Rust dependencies and target-specific framework features.
- `native/credential-helper/Cargo.lock`: reproducible helper dependency graph.
- `native/credential-helper/src/main.rs`: command dispatch and process exit mapping.
- `native/credential-helper/src/protocol.rs`: versioned stdin/stdout messages and secret-safe serialization.
- `native/credential-helper/src/store.rs`: `CredentialStore` trait and shared credential model.
- `native/credential-helper/src/store/macos.rs`: Keychain implementation.
- `native/credential-helper/src/store/windows.rs`: Credential Manager implementation.
- `native/credential-helper/src/ui.rs`: `CredentialPrompt` trait.
- `native/credential-helper/src/ui/macos.rs`: AppKit secure prompt.
- `native/credential-helper/src/ui/windows.rs`: CredUI secure prompt.

### Packaging

- `scripts/assemble-credential-helpers.mjs`: copy signed build artifacts into the plugin and emit their digest manifest.
- `scripts/verify-credential-helpers.mjs`: reject missing, misplaced, executable-mode, target, or digest errors.
- `.github/workflows/credential-helpers.yml`: four-target build, test, signing, assembly, and artifact workflow.
- `native/manifest.json`: release-generated helper path and SHA-256 metadata.

### Existing application files

- `src/lovart/credentials.js`: platform-neutral credential service using `helper-client.js`.
- `src/lovart/generation-service.js`: candidate validation callback through the existing `/v1/openapi/mode/query` request.
- `src/index.js`: shared onboarding service wiring and first-run-aware MCP tools.
- `src/http/server.js`: redacted onboarding routes/events and neutral workbench redirects.
- `workbench/dist/assets/imvia-lovart-bridge-v3.js`: onboarding surface, retry/settings actions, and connected-only badge.
- `workbench/dist/assets/imvia-lovart-onboarding.css`: onboarding and connected badge styles.
- `workbench/dist/index.html`: load bridge v3 and onboarding stylesheet.
- `skills/imvia-studio/SKILL.md`: first-open setup contract and preserved generation activation boundary.
- `.codex-plugin/plugin.json`, `README.md`, `package.json`: product description, scripts, and distribution instructions.

---

### Task 1: Helper manifest resolver and private protocol client

**Files:**
- Create: `src/lovart/helper-manifest.js`
- Create: `src/lovart/helper-client.js`
- Create: `test/lovart-helper-manifest.test.mjs`
- Create: `test/lovart-helper-client.test.mjs`

**Interfaces:**
- Produces: `helperTarget(platform, arch) -> string`.
- Produces: `resolveCredentialHelper({ pluginRoot, platform, arch, readFileImpl, hashFileImpl }) -> Promise<{ target, path, sha256 }>`.
- Produces: `createHelperClient({ resolveHelper, spawnImpl, requestId }) -> { status(), configure({ validate, onState }), read(), clear() }`.
- Protocol: UTF-8 NDJSON, `v: 1`, one JSON object per line, maximum line size 16 KiB, no shell.

- [ ] **Step 1: Write resolver tests that fail before the module exists**

```js
test("maps only the four packaged targets", () => {
  assert.equal(helperTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(helperTarget("darwin", "x64"), "darwin-x64");
  assert.equal(helperTarget("win32", "arm64"), "win32-arm64");
  assert.equal(helperTarget("win32", "x64"), "win32-x64");
  assert.throws(() => helperTarget("linux", "x64"), (error) => error.code === "PLATFORM_UNSUPPORTED");
});

test("rejects a helper whose digest differs from the manifest", async () => {
  await assert.rejects(
    resolveCredentialHelper(fixture({ manifestDigest: "a".repeat(64), actualDigest: "b".repeat(64) })),
    (error) => error.code === "UPSTREAM_SECURITY_REJECTED",
  );
});
```

- [ ] **Step 2: Run the resolver test and verify the expected module-not-found failure**

Run: `node --test test/lovart-helper-manifest.test.mjs`

Expected: FAIL because `src/lovart/helper-manifest.js` does not exist.

- [ ] **Step 3: Implement target mapping, path confinement, schema validation, and digest verification**

```js
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);

export function helperTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.has(target)) throw stableFailure("PLATFORM_UNSUPPORTED");
  return target;
}

export async function resolveCredentialHelper({ pluginRoot, platform, arch, readFileImpl, hashFileImpl }) {
  const target = helperTarget(platform, arch);
  const manifest = JSON.parse(await readFileImpl(path.join(pluginRoot, "native/manifest.json"), "utf8"));
  const entry = manifest?.version === 1 ? manifest.helpers?.[target] : null;
  if (!entry) throw stableFailure("HELPER_NOT_PACKAGED");
  const candidate = path.resolve(pluginRoot, entry.path);
  if (!candidate.startsWith(`${path.resolve(pluginRoot)}${path.sep}`)) throw stableFailure("UPSTREAM_SECURITY_REJECTED");
  if (await hashFileImpl(candidate) !== entry.sha256) throw stableFailure("UPSTREAM_SECURITY_REJECTED");
  return { target, path: candidate, sha256: entry.sha256 };
}
```

- [ ] **Step 4: Write protocol-client tests with a fake child process**

Cover exact behaviors: fixed operation argument, `shell: false`, 16 KiB line limit, one validation verdict, timeout termination, duplicate candidate rejection, redacted public errors, and no secret substring in error/log output.

```js
const client = createHelperClient({ resolveHelper: async () => helper, spawnImpl: fakeSpawn });
const result = await client.configure({
  validate: async ({ accessKey, secretKey }) => {
    assert.equal(accessKey, "ak_private");
    assert.equal(secretKey, "sk_private");
    return { accepted: true, code: "CONNECTED" };
  },
});
assert.deepEqual(result, { status: "connected", code: "CONNECTED" });
assert.equal(JSON.stringify(result).includes("private"), false);
```

- [ ] **Step 5: Implement the NDJSON client and run both focused suites**

The client must spawn `resolved.path` with exactly one of `status`, `configure`, `read`, or `clear`; set `shell: false`, `windowsHide: true`, and a minimal secret-free environment containing only locale values required by the native UI; parse only known message shapes; call `onState("validating")` immediately before candidate validation; and destroy the child on timeout or protocol violation.

Run: `node --test test/lovart-helper-manifest.test.mjs test/lovart-helper-client.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the protocol boundary**

```bash
git add src/lovart/helper-manifest.js src/lovart/helper-client.js test/lovart-helper-manifest.test.mjs test/lovart-helper-client.test.mjs
git commit -m "feat: add credential helper protocol boundary"
```

### Task 2: Rust protocol core and macOS helper

**Files:**
- Create: `native/credential-helper/Cargo.toml`
- Create: `native/credential-helper/Cargo.lock`
- Create: `native/credential-helper/src/main.rs`
- Create: `native/credential-helper/src/protocol.rs`
- Create: `native/credential-helper/src/store.rs`
- Create: `native/credential-helper/src/store/macos.rs`
- Create: `native/credential-helper/src/ui.rs`
- Create: `native/credential-helper/src/ui/macos.rs`
- Create: `native/credential-helper/tests/protocol.rs`

**Interfaces:**
- Consumes: Node protocol from Task 1.
- Produces: executable commands `status`, `configure`, `read`, `clear`.
- Produces: `CredentialStore::{status, read, write, clear}` and `CredentialPrompt::prompt`.

- [ ] **Step 1: Add failing Rust protocol tests**

```rust
#[test]
fn result_messages_never_serialize_credentials() {
    let value = serde_json::to_string(&ResultMessage::connected("CONNECTED")).unwrap();
    assert_eq!(value, r#"{"v":1,"type":"result","status":"connected","code":"CONNECTED"}"#);
}

#[test]
fn credential_pair_zeroizes_on_drop() {
    fn assert_zeroize_on_drop<T: zeroize::ZeroizeOnDrop>() {}
    assert_zeroize_on_drop::<CredentialPair>();
}
```

- [ ] **Step 2: Create the Rust crate and verify RED**

Use Rust edition 2021 with `serde 1`, `serde_json 1`, `zeroize 1.9`, `security-framework 3.7`, `objc2-foundation 0.3.2`, and `objc2-app-kit 0.3.2`; commit the resolved `Cargo.lock`. Keep macOS dependencies under `target.'cfg(target_os = "macos")'.dependencies`.

Run: `cargo test --manifest-path native/credential-helper/Cargo.toml`

Expected: FAIL until protocol types and traits exist.

- [ ] **Step 3: Implement protocol types and the command dispatcher**

```rust
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct CredentialPair {
    pub access_key: String,
    pub secret_key: String,
}

pub trait CredentialStore {
    fn status(&self) -> StoreStatus;
    fn read(&self) -> Result<CredentialPair, HelperError>;
    fn write(&self, pair: &CredentialPair) -> Result<(), HelperError>;
    fn clear(&self) -> Result<(), HelperError>;
}

pub trait CredentialPrompt {
    fn prompt(&self) -> Result<PromptOutcome, HelperError>;
}
```

`main.rs` must reject unknown or additional arguments, write protocol messages only to stdout, avoid printing `Debug` representations of secrets, and map all internal failures to the stable codes in the spec.

- [ ] **Step 4: Add macOS store tests and implementation**

Use `security_framework::passwords::{generic_password, set_generic_password, delete_generic_password}` with service `ai.imvia.studio.lovart` and account `credentials`. Serialize the pair as UTF-8 JSON only inside the Keychain value. Treat `errSecItemNotFound` as `SETUP_REQUIRED`; map authorization failures to `CREDENTIAL_STORE_DENIED`.

```rust
impl CredentialStore for MacCredentialStore {
    fn read(&self) -> Result<CredentialPair, HelperError> {
        let bytes = generic_password(SERVICE, ACCOUNT).map_err(map_keychain_error)?;
        decode_pair(Zeroizing::new(bytes))
    }
}
```

- [ ] **Step 5: Add the AppKit secure prompt**

Use `NSApplication`, `NSAlert`, one `NSTextField` labelled **Access Key**, one `NSSecureTextField` labelled **Secret Key**, and **连接** / **取消** buttons. Activate as an accessory application, trim both fields, reject an empty field with `SETUP_INVALID`, and clear both controls before exit.

The implementation must run AppKit creation on the main thread and return `PromptOutcome::Cancelled` without touching Keychain when the user cancels.

- [ ] **Step 6: Run Rust and Node protocol tests**

Run: `cargo test --manifest-path native/credential-helper/Cargo.toml`

Run: `node --test test/lovart-helper-client.test.mjs`

Expected: PASS. No test opens a real prompt or reads the real Keychain; platform tests inject fake prompt/store adapters.

- [ ] **Step 7: Commit the macOS helper**

```bash
git add native/credential-helper
git commit -m "feat: add packaged macOS credential helper"
```

### Task 3: Windows CredUI and Credential Manager backend

**Files:**
- Modify: `native/credential-helper/Cargo.toml`
- Modify: `native/credential-helper/src/main.rs`
- Modify: `native/credential-helper/src/store.rs`
- Create: `native/credential-helper/src/store/windows.rs`
- Modify: `native/credential-helper/src/ui.rs`
- Create: `native/credential-helper/src/ui/windows.rs`
- Create: `native/credential-helper/tests/windows_contract.rs`

**Interfaces:**
- Consumes: `CredentialStore`, `CredentialPrompt`, and protocol types from Task 2.
- Produces: Windows implementations with target `IMVIA.Studio.Lovart`.

- [ ] **Step 1: Add target-independent Windows contract tests**

```rust
#[test]
fn windows_target_is_imvia_owned() {
    assert_eq!(WINDOWS_TARGET, "IMVIA.Studio.Lovart");
}

#[test]
fn cancelled_prompt_never_calls_store_write() {
    let store = RecordingStore::default();
    let result = configure(&CancelledPrompt, &store, &RejectingValidator).unwrap();
    assert_eq!(result.code, "SETUP_CANCELLED");
    assert_eq!(store.write_count(), 0);
}
```

- [ ] **Step 2: Add Windows dependencies and verify RED in the Windows matrix**

Use `windows-sys 0.61.2` features for `Win32_Foundation`, `Win32_Security_Credentials`, `Win32_UI_WindowsAndMessaging`, and `Win32_System_Memory`. Keep them under `target.'cfg(target_os = "windows")'.dependencies`.

Run on Windows x64: `cargo test --manifest-path native/credential-helper/Cargo.toml --target x86_64-pc-windows-msvc`

Expected: FAIL until the Windows modules exist.

- [ ] **Step 3: Implement Credential Manager storage**

Use `CredReadW`, `CredWriteW`, `CredDeleteW`, and `CredFree` with `CRED_TYPE_GENERIC`, target `IMVIA.Studio.Lovart`, username `credentials`, and local-machine persistence. Validate the blob size before writing, copy returned blobs once, zero temporary buffers, and always free OS memory.

```rust
impl CredentialStore for WindowsCredentialStore {
    fn write(&self, pair: &CredentialPair) -> Result<(), HelperError> {
        let mut blob = Zeroizing::new(encode_pair(pair)?);
        write_generic_credential(WINDOWS_TARGET, "credentials", &mut blob)
            .map_err(map_windows_error)
    }
}
```

- [ ] **Step 4: Implement the native Windows prompt**

Use `CredUIPromptForWindowsCredentialsW`; map the username field to Access Key and the password field to Secret Key. Unpack with `CredUnPackAuthenticationBufferW`, zero and free the returned authentication buffer with `SecureZeroMemory` and `CoTaskMemFree`, and map `ERROR_CANCELLED` to `SETUP_CANCELLED`.

- [ ] **Step 5: Run Windows tests for both architectures**

Run on Windows x64: `cargo test --manifest-path native/credential-helper/Cargo.toml --target x86_64-pc-windows-msvc`

Run on Windows ARM64: `cargo test --manifest-path native/credential-helper/Cargo.toml --target aarch64-pc-windows-msvc`

Expected: PASS. Automated tests use fake stores and do not modify the runner's real Credential Manager.

- [ ] **Step 6: Commit the Windows backend**

```bash
git add native/credential-helper
git commit -m "feat: add Windows credential helper backend"
```

### Task 4: Four-target build, signing, assembly, and integrity verification

**Files:**
- Create: `scripts/assemble-credential-helpers.mjs`
- Create: `scripts/verify-credential-helpers.mjs`
- Create: `test/credential-helper-packaging.test.mjs`
- Create: `.github/workflows/credential-helpers.yml`
- Modify: `package.json`
- Generate in release artifact: `native/manifest.json`
- Generate in release artifact: `native/darwin-arm64/imvia-credential-helper`
- Generate in release artifact: `native/darwin-x64/imvia-credential-helper`
- Generate in release artifact: `native/win32-arm64/imvia-credential-helper.exe`
- Generate in release artifact: `native/win32-x64/imvia-credential-helper.exe`

**Interfaces:**
- Consumes: Rust helper from Tasks 2–3.
- Produces: installed-plugin manifest consumed by `resolveCredentialHelper`.

- [ ] **Step 1: Write packaging tests against a temporary artifact tree**

```js
test("assembly emits exactly four confined helper entries", async () => {
  const manifest = await assembleFixture();
  assert.deepEqual(Object.keys(manifest.helpers).sort(), [
    "darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64",
  ]);
  for (const entry of Object.values(manifest.helpers)) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
});
```

Also fail on an unsigned metadata flag, a symlink, a non-executable macOS binary, an unexpected fifth target, a path outside `native/`, or a digest mismatch.

- [ ] **Step 2: Implement assembly and verification scripts**

`assemble-credential-helpers.mjs` accepts four explicit artifact directories, copies only the expected filenames, computes SHA-256, writes manifest version 1, and never searches PATH. `verify-credential-helpers.mjs` recomputes every digest and validates target/path uniqueness.

Add scripts:

```json
{
  "build:credential-helper": "cargo build --release --manifest-path native/credential-helper/Cargo.toml",
  "test:credential-helper": "cargo test --manifest-path native/credential-helper/Cargo.toml",
  "verify:credential-helpers": "node scripts/verify-credential-helpers.mjs"
}
```

- [ ] **Step 3: Add the CI matrix**

Use `macos-15` for arm64, `macos-15-intel` for x64, `windows-2025` for x64, and `windows-11-arm` for ARM64. Each pull-request job runs Rust tests and builds `--release` without publishing a distributable. The protected release job requires Apple signing/notarization and Windows Authenticode secrets, fails when either is absent, verifies each platform signature, and uploads one target-named artifact. A final assembly job downloads all four signed artifacts, writes `native/manifest.json`, runs `npm run verify:credential-helpers`, and uploads the assembled plugin payload.

- [ ] **Step 4: Run local packaging tests**

Run: `node --test test/credential-helper-packaging.test.mjs`

Run on the current macOS target after a release build: `npm run verify:credential-helpers`

Expected: PASS for a complete signed release payload; fail closed with `HELPER_NOT_PACKAGED` for an incomplete source checkout.

- [ ] **Step 5: Commit packaging automation**

```bash
git add .github/workflows/credential-helpers.yml package.json scripts/assemble-credential-helpers.mjs scripts/verify-credential-helpers.mjs test/credential-helper-packaging.test.mjs
git commit -m "build: package signed credential helpers"
```

### Task 5: Platform-neutral credential service and validation-before-commit

**Files:**
- Modify: `src/lovart/credentials.js`
- Modify: `src/lovart/generation-service.js`
- Modify: `test/lovart-credentials.test.mjs`
- Modify: `test/lovart-generation.test.mjs`
- Modify: `test/lovart-connection-security.test.mjs`

**Interfaces:**
- Consumes: `createHelperClient` from Task 1.
- Produces: `createCredentialService({ helperClient, platform, arch, now })` with `status`, `connect`, `getCredentials`, and `clear`.
- Changes: `generationService.connect({ onState })` supplies the fixed-endpoint validation callback to `credentialService.connect({ validate, onState })`.

- [ ] **Step 1: Replace macOS-only tests with cross-platform contract tests**

Add tests for both `darwin` and `win32`, invalid candidate preserving an existing pair, cancellation causing zero validation calls, validation failure causing zero helper commits, clear deleting only IMVIA credentials, and public results containing no test key markers.

```js
const result = await service.connect({
  validate: async () => ({ accepted: false, code: "AUTHENTICATION_FAILED" }),
});
assert.deepEqual(result, {
  status: "setup_required",
  code: "AUTHENTICATION_FAILED",
  message: "Lovart authentication was rejected.",
});
assert.equal(helper.commitCount, 0);
assert.equal(helper.previousPairIntact, true);
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test test/lovart-credentials.test.mjs test/lovart-generation.test.mjs test/lovart-connection-security.test.mjs`

Expected: FAIL because the current service accepts only macOS and saves before upstream validation.

- [ ] **Step 3: Refactor the credential service**

Remove `runNativeHelper`, `defaultRunHelper`, `defaultReadKeychain`, `credentialHelperPath`, the `swift` invocation, and the legacy access/secret account constants. Map helper errors only to the stable codes in the design.

```js
export function createCredentialService({ helperClient, platform = process.platform, arch = process.arch, now = () => Date.now() } = {}) {
  async function connect({ validate, onState }) {
    return redact(await helperClient.configure({
      onState,
      validate: async (pair) => {
        const verdict = await validate(pair);
        return verdict.accepted ? { accepted: true, code: "CONNECTED" } : verdict;
      },
    }), now);
  }
  return Object.freeze({ status, connect, getCredentials, clear });
}
```

- [ ] **Step 4: Move upstream validation into the handshake**

```js
async function connect({ onState } = {}) {
  return credentialService.connect({
    onState,
    validate: async (credentials) => {
      try {
        await clientFactory(credentials).queryMode();
        return { accepted: true, code: "CONNECTED" };
      } catch (error) {
        const safe = stableError(error);
        return { accepted: false, code: safe.code, message: safe.message };
      }
    },
  });
}
```

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/lovart-credentials.test.mjs test/lovart-generation.test.mjs test/lovart-connection-security.test.mjs`

Expected: PASS.

```bash
git add src/lovart/credentials.js src/lovart/generation-service.js test/lovart-credentials.test.mjs test/lovart-generation.test.mjs test/lovart-connection-security.test.mjs
git commit -m "feat: validate IMVIA credentials before commit"
```

### Task 6: Single-flight first-run onboarding service

**Files:**
- Create: `src/lovart/onboarding-service.js`
- Create: `test/lovart-onboarding.test.mjs`

**Interfaces:**
- Consumes: `credentialService.status()` and `generationService.connect({ onState })`.
- Produces: `createOnboardingService({ credentialService, connect, now })` with `status()`, `ensureStarted()`, `retry()`, `replace()`, `disconnect()`, and `subscribe(listener)`.
- Emits: `{ type: "lovart.onboarding", data: { state, code?, checked_at? } }` with no secrets.

- [ ] **Step 1: Write state-machine tests**

```js
test("two first opens start one helper session", async () => {
  const onboarding = createOnboardingService({ credentialService, connect: deferredConnect });
  const [first, second] = await Promise.all([onboarding.ensureStarted(), onboarding.ensureStarted()]);
  assert.equal(connectCalls, 1);
  assert.equal(first.state, "setup_active");
  assert.equal(second.state, "setup_active");
});
```

Cover all states from the spec, event ordering, cancellation, retry creating one fresh session, connected users causing zero connects, disconnect returning to `setup_required`, and serialized events containing no test key marker.

- [ ] **Step 2: Verify RED**

Run: `node --test test/lovart-onboarding.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the coordinator**

Use one private `activePromise`, a frozen redacted snapshot, and a listener set. `ensureStarted()` returns immediately with `setup_active` after scheduling the connection promise; it must not await user input. Completion publishes `validating` before validation begins and then one terminal state.

```js
async function ensureStarted() {
  const current = await credentialService.status();
  if (current.status === "connected") return publish(connectedSnapshot(current));
  if (!activePromise) {
    publish({ state: "setup_active" });
    activePromise = Promise.resolve()
      .then(() => connect({ onState: (state) => publish({ state }) }))
      .then(finish, fail)
      .finally(() => { activePromise = null; });
  }
  return snapshot;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/lovart-onboarding.test.mjs`

Expected: PASS.

```bash
git add src/lovart/onboarding-service.js test/lovart-onboarding.test.mjs
git commit -m "feat: coordinate first-run Lovart onboarding"
```

### Task 7: Wire first-open MCP, redacted HTTP, and SSE state

**Files:**
- Modify: `src/index.js`
- Modify: `src/http/server.js`
- Modify: `test/mcp-lovart-connection.test.mjs`
- Modify: `test/mcp-workbench.test.mjs`
- Modify: `test/http-server.test.mjs`
- Modify: `test/mcp-health.test.mjs`

**Interfaces:**
- Consumes: onboarding service from Task 6.
- MCP: `imvia_open_workbench` returns neutral URL plus redacted `onboarding` snapshot.
- HTTP: `GET /api/v1/lovart/status`, `POST /api/v1/lovart/connect`, `POST /api/v1/lovart/disconnect`.
- SSE: `lovart.onboarding` events.

- [ ] **Step 1: Add failing MCP tests**

Assert `imvia_open_workbench` invokes `ensureStarted()` once, returns without waiting for the deferred setup promise, returns `/workbench?imvia=live` without `lovart` or `code` query parameters, and exposes no credential fields.

```js
assert.deepEqual(opened.structuredContent.data.onboarding, { state: "setup_active" });
assert.equal(new URL(opened.structuredContent.data.workbench_url).searchParams.has("lovart"), false);
```

- [ ] **Step 2: Add failing HTTP and SSE tests**

Replace redirect-status assertions with a neutral `303 /workbench?imvia=live`. Assert status/retry/disconnect endpoints return redacted states and an onboarding transition reaches `/api/v1/events` as `event: lovart.onboarding`.

- [ ] **Step 3: Wire one shared onboarding instance**

Create the helper client, credential service, generation service, and onboarding service once in `startServer()`. Pass the same onboarding instance to `startHttpServer()` and `createServer()` so MCP, HTTP, and the workbench observe one active setup session.

```js
const onboardingService = createOnboardingService({
  credentialService,
  connect: ({ onState }) => generationService.connect({ onState }),
});
```

`imvia_connect_lovart` calls `onboardingService.retry()`. Add `imvia_disconnect_lovart` with empty strict input and explicit user-facing description. Extend the stable error allowlist with the design codes.

- [ ] **Step 4: Remove URL-carried connection state and publish SSE transitions**

Delete `redirectToWorkbench` query construction. Subscribe HTTP's event publisher to onboarding events alongside domain service events. Keep all payloads behind `redactedConnection`/redacted onboarding normalization.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/mcp-lovart-connection.test.mjs test/mcp-workbench.test.mjs test/http-server.test.mjs test/mcp-health.test.mjs`

Expected: PASS.

```bash
git add src/index.js src/http/server.js test/mcp-lovart-connection.test.mjs test/mcp-workbench.test.mjs test/http-server.test.mjs test/mcp-health.test.mjs
git commit -m "feat: start Lovart onboarding on first workbench open"
```

### Task 8: Workbench onboarding and connected-only status rail

**Files:**
- Create: `workbench/dist/assets/imvia-lovart-bridge-v3.js`
- Create: `workbench/dist/assets/imvia-lovart-onboarding.css`
- Modify: `workbench/dist/index.html`
- Create: `test/workbench-lovart-onboarding.test.mjs`
- Modify: `test/http-server.test.mjs`

**Interfaces:**
- Consumes: bootstrap redacted status, `/api/v1/lovart/status`, `/api/v1/lovart/connect`, `/api/v1/lovart/disconnect`, and `lovart.onboarding` SSE events.
- Produces: onboarding DOM rooted at `[data-imvia-lovart-onboarding]` and connected badge at `[data-imvia-lovart-connected]`.

- [ ] **Step 1: Write source-contract tests**

```js
assert.equal(source.includes("URLSearchParams"), false);
assert.equal(source.includes("Lovart 未连接"), false);
assert.equal(source.includes("连接 Lovart</button>"), false);
assert.ok(source.includes("Lovart 已连接"));
assert.ok(source.includes("重试连接"));
assert.ok(source.includes("lovart.onboarding"));
```

Also assert `index.html` no longer loads `imvia-lovart-bridge-v2.js`, loads bridge v3 and the onboarding stylesheet, and contains no credential input elements.

- [ ] **Step 2: Verify RED**

Run: `node --test test/workbench-lovart-onboarding.test.mjs test/http-server.test.mjs`

Expected: FAIL against bridge v2.

- [ ] **Step 3: Implement the onboarding renderer**

Render these states:

- `setup_required`: explanation and **重试连接**;
- `setup_active`: non-blocking **正在打开安全输入框…**;
- `validating`: **正在验证 Lovart 连接…**;
- `cancelled`: cancellation explanation and retry;
- `failed`: stable-code-specific message and retry when allowed;
- `connected`: remove onboarding and show only **Lovart 已连接**.

The bridge must never create Access Key or Secret Key inputs, never read URL connection parameters, and never embed raw server messages. Retry and disconnect use empty POST bodies. Use `EventSource("/api/v1/events")` for transitions and fall back to periodic redacted status polling when SSE closes.

- [ ] **Step 4: Add settings actions without polluting the status rail**

Attach **更换密钥** and **断开连接** to a dedicated settings menu mounted by bridge v3. The connected badge remains non-interactive. Require a browser confirmation before disconnect; the server still treats the POST as explicit user intent.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/workbench-lovart-onboarding.test.mjs test/http-server.test.mjs`

Expected: PASS.

```bash
git add workbench/dist/index.html workbench/dist/assets/imvia-lovart-bridge-v3.js workbench/dist/assets/imvia-lovart-onboarding.css test/workbench-lovart-onboarding.test.mjs test/http-server.test.mjs
git commit -m "feat: add first-run Lovart onboarding UI"
```

### Task 9: Skill contract, migration, marketplace intent, and user documentation

**Files:**
- Modify: `skills/imvia-studio/SKILL.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `test/skill-contract.test.mjs`
- Modify: `test/source-policy.test.mjs`
- Create: `test/lovart-credential-migration.test.mjs`
- Create: `scripts/update-marketplace-auth-policy.mjs`
- Create: `test/marketplace-policy.test.mjs`
- Update through supported helper: `/Users/a1234/.agents/plugins/marketplace.json`

**Interfaces:**
- Preserves: explicit Lovart generation activation and all cost-confirmation gates.
- Changes: first-open missing credentials may automatically start setup; reconnect remains explicit.
- Marketplace: `policy.authentication` changes from `ON_USE` to `ON_INSTALL`.

- [ ] **Step 1: Add failing skill and migration tests**

Assert the skill includes all of these exact rules:

```text
The first workbench open may start IMVIA credential onboarding when IMVIA credentials are missing.
Credential onboarding never activates upload, project creation, generation, confirmation, or cost approval.
IMVIA Studio never reads, migrates, overwrites, or infers credentials or state from the existing Lovart plugin.
The workbench status rail shows Lovart only when the independent IMVIA connection is established.
```

Migration tests cover: existing complete IMVIA item skips setup, incomplete IMVIA item starts setup, existing Lovart-plugin fixture state is ignored, and upgrade does not clear IMVIA credentials.

- [ ] **Step 2: Update the skill and documentation**

Replace the old “bundled workbench exposes 连接 Lovart” first-run wording. Keep `imvia_connect_lovart` for explicit retry/replacement and document `imvia_disconnect_lovart`. Remove instructions that imply users need Swift or developer tools. Document macOS/Windows support, independent namespaces, and connected-only status behavior.

- [ ] **Step 3: Remove legacy runtime configuration**

Delete `configure:lovart` from `package.json`. Delete `scripts/configure-lovart.swift` only after `rg` confirms no runtime, test, documentation, or skill reference remains. Keep the separate Milestone 6 read-only probe scripts unchanged.

Run: `rg -n 'configure-lovart\.swift|configure:lovart|exec\("swift"|Lovart 未连接' . --glob '!docs/superpowers/specs/**' --glob '!docs/superpowers/plans/**'`

Expected: no matches outside historical design/plan documents.

- [ ] **Step 4: Add a validated marketplace-policy command**

Write `test/marketplace-policy.test.mjs` first. It must prove that the command rejects a wrong marketplace name, a missing or duplicate plugin entry, a non-local source, and an unsupported policy; and that it changes only `policy.authentication` while preserving `installation`, `category`, source path, root display name, and plugin ordering.

Implement `scripts/update-marketplace-auth-policy.mjs` with explicit arguments `--marketplace`, `--plugin`, and `--authentication`; parse and validate before writing through an atomic same-directory temporary file and rename. This command is the supported non-interactive update path; never edit marketplace JSON by hand.

Run: `node --test test/marketplace-policy.test.mjs`

Expected: PASS.

- [ ] **Step 5: Apply marketplace intent and cachebuster through commands**

Validate the marketplace name first:

```bash
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py
```

Then apply only the authentication policy:

```bash
node scripts/update-marketplace-auth-policy.mjs --marketplace '/Users/a1234/.agents/plugins/marketplace.json' --plugin imvia-studio --authentication ON_INSTALL
```

Then update the plugin cachebuster with:

```bash
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py '/Users/a1234/Documents/ChatGPT/imvia stuio'
```

Record the validated marketplace policy in the verification log; never print credentials.

- [ ] **Step 6: Run contract tests and commit repository changes**

Run: `node --test test/skill-contract.test.mjs test/source-policy.test.mjs test/lovart-credential-migration.test.mjs test/marketplace-policy.test.mjs`

Expected: PASS.

```bash
git add .codex-plugin/plugin.json README.md package.json skills/imvia-studio/SKILL.md scripts/configure-lovart.swift scripts/update-marketplace-auth-policy.mjs test/skill-contract.test.mjs test/source-policy.test.mjs test/lovart-credential-migration.test.mjs test/marketplace-policy.test.mjs
git commit -m "docs: make Lovart connection a first-run flow"
```

### Task 10: Full security, regression, clean-machine, and reinstall verification

**Files:**
- Modify: `test/protected-paths.test.mjs`
- Modify: `test/probe-security.test.mjs`
- Create: `docs/verification/2026-08-22-imvia-cross-platform-first-run-credentials.md`

**Interfaces:**
- Consumes: completed Tasks 1–9.
- Produces: reproducible verification evidence and a cache-busted installed plugin.

- [ ] **Step 1: Run focused Node and Rust suites**

```bash
node --test test/lovart-helper-manifest.test.mjs test/lovart-helper-client.test.mjs test/credential-helper-packaging.test.mjs test/lovart-credentials.test.mjs test/lovart-generation.test.mjs test/lovart-connection-security.test.mjs test/lovart-onboarding.test.mjs test/mcp-lovart-connection.test.mjs test/mcp-workbench.test.mjs test/http-server.test.mjs test/workbench-lovart-onboarding.test.mjs test/lovart-credential-migration.test.mjs test/marketplace-policy.test.mjs test/skill-contract.test.mjs test/source-policy.test.mjs
cargo test --manifest-path native/credential-helper/Cargo.toml
```

Expected: PASS with zero real credential-store reads and zero live Lovart calls.

- [ ] **Step 2: Run the complete repository suite and validation**

```bash
pnpm test
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py '/Users/a1234/Documents/ChatGPT/imvia stuio'
node scripts/verify-protected-paths.mjs verify test/protected-paths.manifest.json
```

Expected: PASS. Any pre-existing protected-path drift must be recorded and must not be “fixed” by touching the Lovart repository.

- [ ] **Step 3: Verify release artifacts on all four CI targets**

For each target, run `status` against a clean user profile, run `configure` with designated non-production test credentials against a fake validation server, restart the helper, verify `status` is connected, run `clear`, and verify `status` is setup-required. Confirm the host has no Rust, Swift, Xcode, Command Line Tools, or extra PowerShell module dependency beyond the OS itself.

The Windows ARM64 runner is currently a GitHub-hosted public-preview target; if unavailable to the repository, use a labelled self-hosted Windows ARM64 runner and record that runner identity in the verification document.

- [ ] **Step 4: Add and run protected-path and probe-security assertions**

Extend `test/protected-paths.test.mjs` to snapshot the protected Lovart ledger around fake onboarding, retry, replacement, disconnect, and workbench-open operations. Extend `test/probe-security.test.mjs` to prove first-run onboarding neither authorizes nor runs the optional Milestone 6 read-only probe.

Run: `node --test test/protected-paths.test.mjs test/probe-security.test.mjs`

Expected: PASS without changing `test/protected-paths.manifest.json`.

- [ ] **Step 5: Perform leakage and independence scans**

Use unique canary strings in fake helpers, then search captured stdout, stderr, MCP envelopes, HTTP fixtures, URLs, workbench state, JSON state, analytics fixtures, and test snapshots. The canaries may appear only inside the fake child-process pipe assertion that proves credential transfer.

Capture the existing Lovart protected-path ledger before and after the clean-machine run and assert it is byte-for-byte unchanged.

- [ ] **Step 6: Write verification evidence**

Record exact commands, commit SHA, platform/architecture, helper digest, signature result, test counts, marketplace policy, plugin validator result, protected-path result, and any non-blocking runner limitation in `docs/verification/2026-08-22-imvia-cross-platform-first-run-credentials.md`. Do not record credential values or raw helper stderr.

- [ ] **Step 7: Reinstall the cache-busted plugin**

Read the marketplace name, then reinstall from it:

```bash
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py
codex plugin add imvia-studio@personal
```

Start a new Codex task and verify that `imvia_open_workbench` uses the new skill and MCP tool definitions.

- [ ] **Step 8: Commit verification-only repository changes**

```bash
git add test/protected-paths.test.mjs test/probe-security.test.mjs docs/verification/2026-08-22-imvia-cross-platform-first-run-credentials.md
git commit -m "test: verify cross-platform first-run credentials"
```

## Official implementation references

- macOS Keychain generic-password API: <https://docs.rs/security-framework/latest/security_framework/passwords/index.html>
- Rust AppKit `NSAlert`: <https://docs.rs/objc2-app-kit/latest/objc2_app_kit/struct.NSAlert.html>
- Windows credential prompt: <https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creduipromptforcredentialsw>
- Rust `CredWriteW` binding: <https://docs.rs/windows-sys/latest/windows_sys/Win32/Security/Credentials/fn.CredWriteW.html>
- Secret zeroization: <https://docs.rs/zeroize/latest/zeroize/>
- Current GitHub-hosted runner labels: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
