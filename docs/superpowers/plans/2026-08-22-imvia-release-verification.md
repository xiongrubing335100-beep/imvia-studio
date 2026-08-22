# IMVIA Studio Release Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the implemented independent first-run Lovart onboarding flow into a signed, four-target, clean-machine-verified release.

**Architecture:** The existing IMVIA plugin remains the only runtime component. A protected CI matrix builds the bundled native credential helper for macOS arm64/x64 and Windows arm64/x64, signs each artifact, assembles a digest manifest, and publishes one installable native bundle. Clean-machine verification then exercises only the IMVIA namespace and confirms that the workbench opens in onboarding or connected state without exposing credentials.

**Tech Stack:** GitHub Actions, Rust stable/Cargo, AppKit Keychain, Windows Credential Manager/CredUI, Node.js 24, the existing IMVIA MCP/HTTP/SSE workbench, and the plugin-creator marketplace/cachebuster utilities.

**Spec:** `docs/superpowers/specs/2026-08-22-imvia-cross-platform-first-run-credentials-design.md`

## Global Constraints

- First supported release covers macOS and Windows.
- End users must not install Swift, Xcode, Command Line Tools, PowerShell modules, Rust, or another developer runtime.
- macOS credentials use `ai.imvia.studio.lovart` / `credentials`; Windows credentials use `IMVIA.Studio.Lovart`.
- IMVIA must never read, migrate, overwrite, or infer the existing Lovart plugin namespace or state.
- Credential setup never authorizes upload, project creation, generation, confirmation, or cost approval.
- The workbench status rail displays Lovart only after an independent IMVIA connection is established.
- Release helpers are resolved only from the installed plugin directory and are verified against `native/manifest.json` before execution.
- Release verification uses designated fake/test credentials and never records production secrets.

---

### Task 1: Configure the protected release environment

**Files:**
- Read: `.github/workflows/credential-helpers.yml`
- Read: `docs/verification/2026-08-22-imvia-cross-platform-first-run-credentials.md`
- External configuration: GitHub Actions repository secrets and runner labels

**Interfaces:**
- Consumes: the existing `build` matrix and `assemble` job.
- Produces: four runners able to execute the existing workflow without source changes.

- [ ] **Step 1: Configure release secrets**

Create these GitHub Actions secrets in the repository that owns the branch:

```text
IMVIA_MACOS_SIGNING_IDENTITY
IMVIA_MACOS_NOTARY_PROFILE
IMVIA_WINDOWS_SIGNING_SUBJECT
```

The macOS runners must have the signing identity and notary profile installed in the protected keychain. Windows runners must have the Authenticode certificate available to `signtool.exe` under the configured subject.

- [ ] **Step 2: Confirm runner availability**

Verify that these labels resolve to the intended machines:

```text
macos-15
macos-15-intel
windows-2025
windows-11-arm
```

If the public Windows ARM64 label is unavailable, provision a protected self-hosted ARM64 runner and change only the `runner` value for `win32-arm64` in `.github/workflows/credential-helpers.yml`.

- [ ] **Step 3: Run a pull-request dry run**

Open or update a pull request and confirm that every matrix entry completes `cargo fmt`, `cargo generate-lockfile`, `cargo test`, and `cargo build`, while no signed artifact is uploaded.

Expected result: all four build jobs pass; the tag-only `assemble` job is skipped.

---

### Task 2: Produce and verify the signed native bundle

**Files:**
- Use: `.github/workflows/credential-helpers.yml`
- Use: `scripts/assemble-credential-helpers.mjs`
- Use: `scripts/verify-credential-helpers.mjs`
- Output: `native/manifest.json` and four target helper files in the CI artifact

**Interfaces:**
- Consumes: the four successful matrix build artifacts and their `signature.json` files.
- Produces: `native/darwin-arm64/imvia-credential-helper`, `native/darwin-x64/imvia-credential-helper`, `native/win32-arm64/imvia-credential-helper.exe`, `native/win32-x64/imvia-credential-helper.exe`, and a SHA-256 manifest.

- [ ] **Step 1: Create a release tag from the reviewed commit**

After the pull-request dry run passes, create a tag from the reviewed branch tip:

```bash
git rev-parse HEAD
git tag -a v0.3.0-imvia-credentials -m "IMVIA first-run Lovart credentials"
git push origin v0.3.0-imvia-credentials
```

Do not tag a dirty worktree or a commit that has not passed the Node/plugin checks.

- [ ] **Step 2: Inspect each matrix job**

Confirm the macOS jobs show successful `codesign --verify` and `xcrun notarytool submit`, and the Windows jobs show successful `signtool sign` and `signtool verify /pa`.

Expected result: every uploaded target artifact contains exactly one helper binary and one `signature.json` with `signed: true` and the matching target.

- [ ] **Step 3: Inspect the assembled manifest**

Download the `imvia-studio-credential-helpers-<tag>` artifact and run:

```bash
cd /path/to/downloaded/plugin-root
node scripts/verify-credential-helpers.mjs
```

Expected result: `credential helpers verified`; the manifest has exactly four confined paths and SHA-256 values matching the downloaded bytes.

---

### Task 3: Run clean-machine helper lifecycle checks

**Files:**
- Read: `native/credential-helper/src/main.rs`
- Read: `src/lovart/helper-client.js`
- Test: `test/lovart-helper-client.test.mjs`, `test/lovart-credentials.test.mjs`

**Interfaces:**
- Consumes: the signed helper binaries from Task 2 and a fresh OS user profile.
- Produces: evidence that status, configure, read, replacement rejection, and clear work without source runtimes or foreign namespaces.

- [ ] **Step 1: Check the fresh profile before setup**

Run the packaged helper with the fixed private protocol request:

```json
{"v":1,"type":"request","op":"status"}
```

Expected result: a redacted `setup_required` response; no credential values are printed.

- [ ] **Step 2: Exercise configure with designated test credentials**

Use the helper UI to enter only designated non-production test values. Let the IMVIA parent validate them against the fake validation endpoint used by the test harness, then confirm that the helper returns `connected` only after the verdict.

Expected result: credentials are present only in the platform store and private helper pipe; no URL, browser state, MCP result, log, or local JSON state contains either value.

- [ ] **Step 3: Verify restart, rejection, and clear**

Restart the helper and run `status`; submit one deliberately rejected candidate and confirm the previous pair remains; run `clear` and confirm a subsequent `status` returns `setup_required`.

Expected result: replacement is validate-before-commit and clear affects only the IMVIA namespace.

- [ ] **Step 4: Record host dependency evidence**

Record that the clean profile has no Rust, Swift, Xcode, Command Line Tools, PowerShell module, or Node installation requirement beyond the packaged plugin and the operating system.

---

### Task 4: Verify the installed workbench first-run flow

**Files:**
- Read: `workbench/dist/index.html`
- Read: `workbench/dist/assets/imvia-lovart-bridge-v3.js`
- Test: `test/workbench-lovart-onboarding.test.mjs`, `test/http-server.test.mjs`, `test/mcp-lovart-connection.test.mjs`

**Interfaces:**
- Consumes: the cache-busted marketplace installation containing the signed native bundle.
- Produces: user-visible evidence for first open, cancel/retry, connected-only rail, replacement, and disconnect.

- [ ] **Step 1: Install the cache-busted plugin and restart Codex**

Install the marketplace entry after the supported cachebuster update, then restart Codex once. Do not run a Swift or shell credential configuration command.

- [ ] **Step 2: Open the workbench with no IMVIA credentials**

Invoke `imvia_open_workbench` once and observe the neutral workbench URL. Confirm that the secure native dialog appears, while the browser contains no Access Key or Secret Key input and no `Lovart 未连接` status rail item.

- [ ] **Step 3: Verify connected transition**

Complete setup with designated test credentials and wait for the redacted onboarding event. Confirm the status rail changes to `Lovart 已连接` only after validation and commit.

- [ ] **Step 4: Verify cancellation and explicit settings actions**

Cancel setup, confirm the local workbench remains usable, then use **重试连接**. For a connected profile, verify **更换密钥** and **断开连接** are in settings and never appear as an always-visible connection button in the rail.

---

### Task 5: Close the protected-path and release sign-off gates

**Files:**
- Read: `test/protected-paths.manifest.json`
- Run: `scripts/verify-protected-paths.mjs`
- Update: `docs/verification/2026-08-22-imvia-cross-platform-first-run-credentials.md`

**Interfaces:**
- Consumes: the clean-machine evidence from Tasks 2–4.
- Produces: a release decision with the external Lovart workspace either matching its baseline or explicitly blocked without mutation.

- [ ] **Step 1: Run the protected-path verifier**

```bash
node scripts/verify-protected-paths.mjs verify test/protected-paths.manifest.json
```

- [ ] **Step 2: If it fails, preserve the external workspace**

Do not run `git reset`, `git checkout`, recursive deletion, or cleanup commands in `/Users/a1234/Documents/ChatGPT/lovart插件`. Record the reported drift and ask the owner whether to restore the external workspace or regenerate its baseline.

- [ ] **Step 3: Complete the verification record**

Add the CI run URL, runner identities, artifact SHA-256 manifest, clean-machine lifecycle results, and protected-path result to `docs/verification/2026-08-22-imvia-cross-platform-first-run-credentials.md`.

- [ ] **Step 4: Release only after all gates pass**

Release is approved only when the signed manifest verifies, all four clean-machine helper lifecycles pass, the installed workbench shows the intended onboarding/connected behavior, and the protected-path result is either clean or explicitly approved as an external baseline exception.

---

## Current blockers

1. This development environment has no `cargo` or `rustc`, so Tasks 1–3 must execute on the protected CI runners.
2. The external Lovart workspace currently differs from `test/protected-paths.manifest.json`; it must not be reset automatically.

Plan complete and saved to `docs/superpowers/plans/2026-08-22-imvia-release-verification.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task with review checkpoints.
2. **Inline Execution** — execute the tasks in this session with checkpoints.
