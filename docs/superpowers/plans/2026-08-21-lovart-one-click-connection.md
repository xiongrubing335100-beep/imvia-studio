# Lovart One-Click Connection and Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-technical IMVIA Studio user connect Lovart through one secure native dialog and then create work through the independent MCP plugin.

**Architecture:** Add an IMVIA-owned credential/status service, a small signed Lovart HTTP client behind injected transports, and four MCP tools that expose connection, status, generation, and explicit confirmation. Keep all raw credentials inside the native setup/read boundary and leave the existing Lovart plugin completely untouched.

**Tech Stack:** Node.js ESM, MCP SDK 1.30.0, Zod 3.25.76, macOS Swift/AppKit/Security helper, Node built-in `crypto` and `fetch`, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-21-lovart-one-click-connection-design.md`

## Global Constraints

- The MCP never accepts AK/SK fields and never returns or logs raw credentials.
- Lovart requests use only `https://lgw.lovart.ai` with TLS verification and no redirects.
- The existing Lovart plugin and every path under `/Users/a1234/Documents/ChatGPT/lovart插件` remain unmodified.
- Tests use fake Keychain, dialog, clock, and HTTP transports; no test contacts Lovart.
- Do not change package dependencies or the existing Milestone 5/6 tool schemas.

---

### Task 1: IMVIA-owned secure credential flow

**Files:**
- Create: `src/lovart/credentials.js`
- Create: `scripts/configure-lovart.swift`
- Create: `test/lovart-credentials.test.mjs`
- Modify: `package.json` (add only `configure:lovart` script)

**Interfaces:**
- Produces `createCredentialService({ platform, runHelper, readKeychain })` with `connect()` and `status()`.
- Produces the stable constants `LOVART_KEYCHAIN_SERVICE`, `LOVART_ACCESS_ACCOUNT`, and `LOVART_SECRET_ACCOUNT`.

- [ ] **Step 1: Write failing tests** for cancelled setup, invalid setup, successful redacted setup, missing Keychain items, and no credential values in returned objects.
- [ ] **Step 2: Run `node --test test/lovart-credentials.test.mjs`** and verify the new imports/behavior fail.
- [ ] **Step 3: Implement the macOS AppKit/Security dialog and Node service** with atomic validation, output redaction, and explicit platform errors.
- [ ] **Step 4: Run the focused credential test** and verify it passes.
- [ ] **Step 5: Commit** with `git add src/lovart/credentials.js scripts/configure-lovart.swift test/lovart-credentials.test.mjs package.json && git commit -m "feat: add one-click Lovart credential setup"`.

### Task 2: Signed Lovart connection and creation adapter

**Files:**
- Create: `src/lovart/client.js`
- Create: `src/lovart/generation-service.js`
- Create: `test/lovart-client.test.mjs`
- Create: `test/lovart-generation.test.mjs`

**Interfaces:**
- Produces `createLovartClient({ credentials, fetchImpl, baseUrl })` with `queryMode()`, `send()`, `status()`, `result()`, and `confirm()`.
- Produces `createGenerationService({ credentialService, client, now, pollIntervalMs })` with `connect()`, `generate(input)`, and `confirm(input)`.

- [ ] **Step 1: Write failing transport tests** for HMAC headers, fixed paths, no redirects, 401 mapping, and malformed responses.
- [ ] **Step 2: Run the focused client test** and verify it fails before implementation.
- [ ] **Step 3: Implement the fixed-endpoint client** using built-in crypto/fetch and injected fakes; never include secrets in thrown errors.
- [ ] **Step 4: Write failing generation tests** for send/poll/result, pending confirmation, explicit confirmation, and no automatic retry.
- [ ] **Step 5: Implement generation service** with bounded polling and redacted stable result shapes.
- [ ] **Step 6: Run both focused suites** and verify all pass.
- [ ] **Step 7: Commit** with `git add src/lovart/client.js src/lovart/generation-service.js test/lovart-client.test.mjs test/lovart-generation.test.mjs && git commit -m "feat: add Lovart creation adapter"`.

### Task 3: Workbench MCP connection and creation tools

**Files:**
- Modify: `src/index.js`
- Create: `test/mcp-lovart-connection.test.mjs`
- Modify: `test/mcp-health.test.mjs`
- Modify: `test/mcp-workbench.test.mjs`

**Interfaces:**
- Registers `imvia_connect_lovart`, `imvia_lovart_status`, `imvia_generate`, and `imvia_confirm_generation` with strict Zod schemas.
- Tool responses use the existing `{api_version, ok, data|error}` envelope and never contain credential fields.

- [ ] **Step 1: Add failing MCP contract tests** for exact tool names, strict inputs, redacted outputs, and pending confirmation behavior.
- [ ] **Step 2: Run `node --test test/mcp-lovart-connection.test.mjs test/mcp-health.test.mjs test/mcp-workbench.test.mjs`** and verify the inventory mismatch fails.
- [ ] **Step 3: Wire one shared generation service into `createServer()`** while preserving all existing tool behavior and fixture-only tests.
- [ ] **Step 4: Run the focused MCP suites** and verify they pass.
- [ ] **Step 5: Commit** with `git add src/index.js test/mcp-lovart-connection.test.mjs test/mcp-health.test.mjs test/mcp-workbench.test.mjs && git commit -m "feat: expose one-click Lovart workbench tools"`.

### Task 4: User-facing documentation and security regression

**Files:**
- Modify: `README.md`
- Modify: `skills/imvia-studio/SKILL.md`
- Create: `test/lovart-connection-security.test.mjs`
- Modify: `test/protected-paths.test.mjs` only if the existing inventory needs a new IMVIA file entry

**Interfaces:**
- Documents the no-terminal user flow and the explicit high-cost confirmation rule.
- Security tests assert no AK/SK literals, no credential fields in MCP schemas/results, and no protected-path references in runtime imports.

- [ ] **Step 1: Write failing security/documentation contract tests** for the user flow and secret redaction.
- [ ] **Step 2: Run the focused security tests** and verify missing text/guards fail.
- [ ] **Step 3: Update README and skill instructions** with concise Chinese/English user-facing connection steps and stable failure guidance.
- [ ] **Step 4: Run focused security tests and `pnpm test:probe`**; verify all pass.
- [ ] **Step 5: Commit** with `git add README.md skills/imvia-studio/SKILL.md test/lovart-connection-security.test.mjs test/protected-paths.test.mjs && git commit -m "docs: document one-click Lovart workflow"`.

### Task 5: Full verification and protected-path evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-08-21-lovart-one-click-connection-design.md` only for verification notes
- Create: `.superpowers/sdd/2026-08-21-lovart-one-click-connection/task-5-report.md` (ignored report, never stage)

- [ ] **Step 1: Record `git status` and the protected-path verifier before validation.**
- [ ] **Step 2: Run `pnpm test`, `pnpm test:probe`, MCP focused tests, and package/security checks.**
- [ ] **Step 3: Run the protected-path verifier after validation** and compare counts and ordered hashes without re-baselining.
- [ ] **Step 4: Write the report** with changed files, pass/fail counts, protected-path evidence, and any pre-existing external drift.
- [ ] **Step 5: Commit only IMVIA source/tests/docs** and verify `git status --short --branch` is clean.
