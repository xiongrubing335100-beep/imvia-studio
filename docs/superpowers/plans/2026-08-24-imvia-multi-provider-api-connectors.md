# IMVIA Studio Multi-Provider API Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, multi-provider connection center for image and video generation APIs while keeping every workbench task routed through the current Codex conversation bridge.

**Architecture:** Add a provider registry and connection-profile store beside the existing Lovart services. A generic REST connector handles declarative providers; trusted adapter modules handle signed or non-standard providers. A provider execution router selects exactly one provider from the immutable snapshot, delegates to the existing Lovart orchestrator or a generic connector, normalizes progress/results, and never silently falls back.

**Tech Stack:** Node.js ESM, built-in `fetch`, existing `JsonStore`, MCP SDK, local HTTP/SSE workbench service, Rust/macOS/Windows credential helper, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-24-imvia-multi-provider-api-connectors-design.md`

## Global Constraints

- First phase supports image and video generation only: text, speech, and file-processing APIs remain outside the implementation scope.
- Every workbench generation still uses `/api/v1/workbench/submissions`, the current Codex conversation bridge, and `imvia_execute_workbench_submission`; browser code must never call a provider API directly.
- Credentials use the bundled IMVIA private credential helper with connection-level profiles; do not use macOS Keychain and do not read or modify the existing Lovart plugin credentials.
- A task snapshot contains `provider_id`, `connection_id`, and `connection_config_revision`, but never a plaintext secret.
- Provider selection is explicit per task. No cross-provider auto-selection, retry, or failover is allowed.
- Standard REST configuration defaults to HTTPS; private or loopback endpoints require an explicit `allow_private_network` setting.
- Generic REST templates are data-only. Browser input cannot inject JavaScript or load arbitrary adapter code.
- Results are an unrestricted `artifacts` array; do not truncate, pad, or merge provider results.
- Do not publish, push, or commit changes without explicit user approval.

## File Map

### New backend files

- `src/providers/constants.js`: provider kinds, media capabilities, normalized task states, and credential field types.
- `src/providers/connector-contract.js`: descriptor/config validation and adapter method contract.
- `src/providers/provider-registry.js`: registration and capability/model lookup.
- `src/providers/connection-store.js`: private JSON persistence for connection profiles and config revisions.
- `src/providers/provider-credentials.js`: connection-profile credential helper facade.
- `src/providers/request-template.js`: safe URL, header, JSON, multipart, and field-template rendering.
- `src/providers/response-path.js`: bounded response field-path extraction and result normalization helpers.
- `src/providers/generic-rest-connector.js`: declarative REST submission, polling, cancellation, and read-only validation.
- `src/providers/provider-execution-router.js`: exact-provider execution, progress forwarding, cost handling, and result import.

### Existing backend files to modify

- `src/domain/workbench-service.js`: provider fields in drafts/snapshots, migration, validation, and job metadata.
- `src/domain/model-capabilities.js`: expose provider-agnostic capability shape while preserving existing Lovart model behavior.
- `src/lovart/helper-client.js`: pass validated connection profile IDs and dynamic credential field definitions to the native helper.
- `src/lovart/credentials.js`: retain the Lovart compatibility facade and add profile-scoped generic credential operations without changing its private-file behavior.
- `native/credential-helper/src/protocol.rs`, `main.rs`, `store.rs`, `store/local.rs`, `ui/macos.rs`, `ui/windows.rs`: profile-scoped private storage and dynamic secure credential prompts.
- `native/credential-helper-swift/main.swift`: mirror the profile-scoped helper protocol for the bundled macOS fallback.
- `src/index.js`: construct provider services, expose connection/provider MCP tools, and route `imvia_execute_workbench_submission` through the provider router.
- `src/http/server.js`: add redacted provider/connection management routes and preserve the bridge-only generation guard.

### New/modified workbench files

- `workbench/dist/assets/imvia-provider-connections-v1.js`: connection manager, provider selector, model list, native credential actions, and read-only test actions.
- `workbench/dist/assets/imvia-provider-connections-v1.css`: isolated connection-manager and provider-selector styling.
- `workbench/dist/index.html`: load the new provider module and stylesheet.
- `workbench/dist/assets/imvia-result-workspace.js`: include provider/connection metadata in immutable submissions and render provider-aware status/project actions.
- `workbench/dist/assets/imvia-result-ui-v1.js`: make loading/result presentation provider-neutral while retaining Lovart labels for Lovart jobs.
- `workbench/dist/assets/imvia-model-auto-v1.js`: consume the selected provider's model list and keep `Auto` scoped to that provider.

### Tests

- `test/provider-contract.test.mjs`
- `test/provider-registry.test.mjs`
- `test/connection-store.test.mjs`
- `test/provider-credentials.test.mjs`
- `test/generic-rest-connector.test.mjs`
- `test/provider-execution-router.test.mjs`
- `test/workbench-provider-selection.test.mjs`
- `test/provider-http.test.mjs`
- `test/workbench-provider-ui.test.mjs`
- `test/provider-e2e.test.mjs`
- Modify `test/lovart-helper-client.test.mjs`, `test/mcp-workbench.test.mjs`, `test/workbench-service.test.mjs`, `test/workbench-result-ui.test.mjs`, `test/skill-contract.test.mjs`.

---

### Task 1: Define provider descriptors and registry

**Files:**
- Create: `src/providers/constants.js`
- Create: `src/providers/connector-contract.js`
- Create: `src/providers/provider-registry.js`
- Test: `test/provider-contract.test.mjs`
- Test: `test/provider-registry.test.mjs`

**Interfaces:**
- `createProviderDescriptor(input) -> ProviderDescriptor`
- `validateConnectionConfig(config) -> normalizedConfig`
- `createProviderRegistry({ builtIns = [], adapters = [] }) -> { register, get, list, modelsFor, resolve }`
- `ProviderDescriptor` has `{ id, display_name, kind, capabilities, models, adapter_id, credential_fields }`.
- Adapter contract has `validateConnection`, `submit`, `poll`, `cancel`, and `importResults`; each method receives `{ connection, credential, snapshot, attachments, onProgress }` and returns a redacted provider result.

- [ ] **Step 1: Write failing descriptor tests.** Assert invalid IDs, duplicate models, unsupported media capabilities, unsafe credential field IDs, and missing adapter methods are rejected with stable `VALIDATION_FAILED` details.
- [ ] **Step 2: Run `node --test test/provider-contract.test.mjs` and verify the new exports are missing.**
- [ ] **Step 3: Implement descriptor normalization and constants.** Enforce IDs matching `/^[a-z][a-z0-9._-]{1,63}$/`, capabilities limited to `image` and `video`, and credential fields containing only `{ id, label, secret, required }`.
- [ ] **Step 4: Write registry tests.** Cover Lovart registration, a generic REST descriptor, capability filtering, model filtering by mode, duplicate registration, and unknown provider errors.
- [ ] **Step 5: Implement `createProviderRegistry`.** Return immutable descriptors, reject duplicate IDs, and expose only redacted metadata to callers.
- [ ] **Step 6: Run both contract test files and verify PASS.**

### Task 2: Persist connection profiles and extend private credential profiles

**Files:**
- Create: `src/providers/connection-store.js`
- Create: `src/providers/provider-credentials.js`
- Modify: `src/lovart/helper-client.js`
- Modify: `src/lovart/credentials.js`
- Modify: `native/credential-helper/src/protocol.rs`
- Modify: `native/credential-helper/src/main.rs`
- Modify: `native/credential-helper/src/store.rs`
- Modify: `native/credential-helper/src/store/local.rs`
- Modify: `native/credential-helper/src/ui/macos.rs`
- Modify: `native/credential-helper/src/ui/windows.rs`
- Modify: `native/credential-helper-swift/main.swift`
- Test: `test/connection-store.test.mjs`
- Test: `test/provider-credentials.test.mjs`
- Modify: `test/lovart-helper-client.test.mjs`
- Test: `native/credential-helper/tests/profile_protocol.rs`

**Interfaces:**
- `createConnectionStore({ dataDirectory, registry }) -> { list, get, create, update, remove, markTested }`
- `createProviderCredentialService({ helperClient, platform, arch }) -> { status, configure, read, clear }`
- `configure({ connection_id, fields, validate, onState }) -> redactedStatus`
- `read({ credential_ref }) -> credentialValues` (backend-only; never returned over HTTP)
- Helper request includes `profile_id` and a validated `fields` array; legacy Lovart calls omit both and continue using the existing Lovart private profile.

- [ ] **Step 1: Write connection-store tests.** Assert a new profile gets a UUID, `config_revision: 1`, no secret fields, private file permissions, atomic updates, duplicate-name rejection, and deletion of only the selected profile.
- [ ] **Step 2: Run `node --test test/connection-store.test.mjs` and verify failure.**
- [ ] **Step 3: Implement `connection-store.js` on `JsonStore` using `provider-connections-v1.json`.** Store descriptors, endpoint mappings, capability declarations, `credential_ref`, enabled state, timestamps, and revision; never accept a secret key in the persisted profile.
- [ ] **Step 4: Write credential facade tests.** Assert dynamic fields are redacted in events/results, profile IDs reject path traversal, legacy Lovart status/read/clear remain unchanged, and a cancelled native prompt does not overwrite the previous profile.
- [ ] **Step 5: Extend the Node helper client protocol.** Add `profileId` and `fields` options, validate them before spawning, and keep the long-running configure timeout behavior.
- [ ] **Step 6: Extend Rust and Swift helper protocols/UI.** Render one secure field per requested credential field, return a `values` object only to the Node child, store profile files under the IMVIA private data directory with mode `0600`, and preserve the fixed Lovart profile compatibility path.
- [ ] **Step 7: Run `node --test test/provider-credentials.test.mjs test/lovart-helper-client.test.mjs` and `cargo test --manifest-path native/credential-helper/Cargo.toml`.** Expected result: PASS with no Keychain access and no credential values in serialized result messages.

### Task 3: Implement the declarative generic REST connector

**Files:**
- Create: `src/providers/request-template.js`
- Create: `src/providers/response-path.js`
- Create: `src/providers/generic-rest-connector.js`
- Test: `test/generic-rest-connector.test.mjs`

**Interfaces:**
- `renderRequestTemplate({ template, snapshot, credential, attachments }) -> { url, method, headers, body }`
- `readResponsePath(value, path) -> value | undefined`
- `createGenericRestConnector({ fetchImpl = fetch, sleep, now }) -> { validateConnection, submit, poll, cancel, importResults }`
- Connection config operations are `{ validate, upload?, submit, status, cancel?, result }`; each operation has method, relative path, headers/body mappings, and response field paths.

- [ ] **Step 1: Write failing template tests.** Cover HTTPS enforcement, private-network opt-in, relative URL resolution, header redaction, JSON body rendering, multipart file attachments, and rejection of template tokens outside the allowed field set.
- [ ] **Step 2: Run `node --test test/generic-rest-connector.test.mjs` and verify failure.**
- [ ] **Step 3: Implement safe URL/template rendering.** Allow only scalar snapshot fields, declared credential field references, and managed attachment handles; never stringify the full snapshot or credentials into a request.
- [ ] **Step 4: Write connector tests using a fake `fetchImpl`.** Cover read-only validation, synchronous result, asynchronous task ID, polling progress, provider rate-limit response, malformed response, cancellation support, and result arrays.
- [ ] **Step 5: Implement submission and polling.** Send upload requests first when declared, emit `uploading`, `submitted`, and `generating` progress, poll with bounded exponential backoff, stop at configured timeout, and map provider errors to `AUTHENTICATION_FAILED`, `UPSTREAM_RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_SCHEMA_UNRECOGNIZED`, or `VALIDATION_FAILED`.
- [ ] **Step 6: Implement result normalization.** Convert URL/Base64/file responses to the existing managed artifact import input with `kind`, `mime_type`, `source_url`, `source_artifact_id`, and metadata; preserve every returned artifact.
- [ ] **Step 7: Run the connector test file and verify PASS.**

### Task 4: Route immutable workbench jobs to exactly one provider

**Files:**
- Create: `src/providers/provider-execution-router.js`
- Modify: `src/domain/workbench-service.js`
- Modify: `src/domain/model-capabilities.js`
- Modify: `src/lovart/generation-orchestrator.js`
- Test: `test/provider-execution-router.test.mjs`
- Modify: `test/workbench-service.test.mjs`
- Test: `test/workbench-provider-selection.test.mjs`

**Interfaces:**
- `createProviderExecutionRouter({ registry, connectionStore, lovartOrchestrator, genericConnectorFactory, workbenchService, artifactTransfer }) -> { executePrepared, get, confirm }`
- `executePrepared({ job_id, snapshot_digest, onProgress }) -> { job, artifacts, results }`
- `get({ job_id }) -> redactedJobResult`
- `confirm({ job_id, attempt, cost_fingerprint, decision_id, onProgress }) -> result`

- [ ] **Step 1: Add failing snapshot tests.** Assert new drafts accept `provider_id` and `connection_id`, snapshots freeze `connection_config_revision`, legacy snapshots migrate to `provider_id: "lovart"`, and missing/disabled connections are rejected before any provider call.
- [ ] **Step 2: Run the targeted workbench tests and verify failure.**
- [ ] **Step 3: Update workbench state validation/migration.** Add provider fields to `ALLOWED_PATCH_FIELDS`, default legacy jobs to Lovart, validate provider capability/model/mode combinations through the registry, and include provider metadata in status messages and redacted state.
- [ ] **Step 4: Add router tests with fake Lovart and generic adapters.** Assert Lovart jobs call only the existing Lovart orchestrator, generic jobs call only the generic connector, unknown providers fail before transport, and no fallback occurs after a provider error.
- [ ] **Step 5: Implement the router.** Resolve the immutable provider and connection revision, call the selected executor, translate progress into existing job transitions, enforce cost confirmation, import all returned artifacts, and preserve idempotency across retries.
- [ ] **Step 6: Update the existing generation orchestrator boundary.** Keep its Lovart behavior intact while allowing the router to own provider selection; do not move Lovart credential or project logic into the generic connector.
- [ ] **Step 7: Run `node --test test/provider-execution-router.test.mjs test/workbench-service.test.mjs test/workbench-provider-selection.test.mjs` and verify PASS.**

### Task 5: Expose redacted provider management and wire MCP execution

**Files:**
- Modify: `src/http/server.js`
- Modify: `src/index.js`
- Test: `test/provider-http.test.mjs`
- Modify: `test/mcp-workbench.test.mjs`

**Interfaces:**
- `GET /api/v1/providers?mode=image|video -> { providers: [...] }`
- `GET /api/v1/connections -> { connections: [...] }`
- `POST /api/v1/connections -> redacted connection`
- `PATCH /api/v1/connections/:id -> redacted connection`
- `POST /api/v1/connections/:id/credentials -> redacted status` (opens the native helper; request has no secret fields)
- `POST /api/v1/connections/:id/test -> redacted test result`
- `DELETE /api/v1/connections/:id -> deletion receipt`
- `imvia_list_providers`, `imvia_list_provider_connections`, and `imvia_test_provider_connection` MCP tools return only redacted metadata.
- `imvia_execute_workbench_submission` keeps its existing input and delegates to `providerExecutionRouter.executePrepared`.

- [ ] **Step 1: Write HTTP tests.** Assert all response bodies omit `credential_values`, `access_key`, and `secret_key`; invalid connection IDs return `NOT_FOUND`; browser generation at `/api/v1/generations` remains rejected with `WORKBENCH_BRIDGE_REQUIRED`.
- [ ] **Step 2: Run `node --test test/provider-http.test.mjs test/mcp-workbench.test.mjs` and verify failure.**
- [ ] **Step 3: Inject registry, connection store, credential service, and router into `startHttpServer` and `createServer`.** Preserve existing dependency injection hooks used by tests.
- [ ] **Step 4: Implement provider and connection routes.** Validate session tokens on mutating workbench requests, return redacted connection metadata, and publish SSE events for connection status and task progress.
- [ ] **Step 5: Register MCP list/test tools and replace only the execution delegate.** Keep existing Lovart-specific tools available and maintain the explicit provider isolation text in descriptions.
- [ ] **Step 6: Run the targeted HTTP/MCP tests and verify PASS.**

### Task 6: Add the connection manager and provider selector to the workbench

**Files:**
- Create: `workbench/dist/assets/imvia-provider-connections-v1.js`
- Create: `workbench/dist/assets/imvia-provider-connections-v1.css`
- Modify: `workbench/dist/index.html`
- Modify: `workbench/dist/assets/imvia-model-auto-v1.js`
- Modify: `workbench/dist/assets/imvia-result-workspace.js`
- Test: `test/workbench-provider-ui.test.mjs`

**Interfaces:**
- `loadProviderCatalog({ mode }) -> Promise<ProviderSummary[]>`
- `loadConnections() -> Promise<ConnectionSummary[]>`
- `openConnectionManager({ document, onChanged }) -> void`
- `serializeProviderSelection({ providerId, connectionId, model }) -> snapshotProvider`
- Dispatch browser event `imvia:provider-selection-changed` with `{ provider_id, connection_id, models }`.

- [ ] **Step 1: Write pure UI serialization tests.** Assert provider selection emits only IDs and model metadata, no credential fields; model lists filter by image/video mode; disabled connections cannot be selected; Lovart remains the default when no provider is stored.
- [ ] **Step 2: Run `node --test test/workbench-provider-ui.test.mjs` and verify failure.**
- [ ] **Step 3: Implement the connection manager module.** Add a settings panel with add/edit/test/enable/disable/delete actions, native credential action buttons, redacted status, and template import/export that strips credentials before download.
- [ ] **Step 4: Implement the provider selector.** Mount it above the existing model overlay, keep selection in `document.documentElement.dataset.imviaProvider` and `dataset.imviaConnection`, and update the model overlay through the custom event without editing the underlying React controls directly.
- [ ] **Step 5: Update `imvia-model-auto-v1.js`.** Read the selected provider catalog, retain `Auto` as an in-provider model value, and render the provider-specific logo/name without allowing an unregistered provider.
- [ ] **Step 6: Update `imvia-result-workspace.js`.** Add provider IDs, connection IDs, and selected model to `readWorkbenchSubmission`; keep project-location controls visible only for Lovart; preserve the bridge submission endpoint and loading behavior.
- [ ] **Step 7: Load the module and stylesheet from `index.html`, run the UI test file, and verify PASS.**

### Task 7: Generalize loading, status, and result presentation

**Files:**
- Modify: `workbench/dist/assets/imvia-result-ui-v1.js`
- Modify: `workbench/dist/assets/imvia-result-workspace.js`
- Modify: `workbench/dist/assets/imvia-lovart-status-v1.js`
- Modify: `test/workbench-result-ui.test.mjs`

**Interfaces:**
- `generationPresentation(job, { providerLabel }) -> { busy, label }`
- `renderProviderLoading({ providerLabel }) -> html`
- `renderResultBody({ cards, followUp, count, providerLabel }) -> html`

- [ ] **Step 1: Add failing result tests.** Assert generic jobs show `提供商生成中...`, Lovart jobs retain `Lovart生成中...`, single and multiple result layouts remain unchanged, provider metadata appears in result cards, and provider-specific project links are omitted when unavailable.
- [ ] **Step 2: Run `node --test test/workbench-result-ui.test.mjs` and verify failure.**
- [ ] **Step 3: Implement provider-neutral presentation helpers.** Replace hard-coded Lovart labels with the provider label passed from the job snapshot, preserve the existing Lovart text for Lovart jobs, and include only redacted provider metadata.
- [ ] **Step 4: Update result workspace rendering and continuation controls.** Continue editing only when the selected provider declares continuation support; otherwise show the unified result actions without constructing a Lovart-only follow-up request.
- [ ] **Step 5: Run the result UI test file and verify PASS.**

### Task 8: Add end-to-end fake-provider coverage and verification gates

**Files:**
- Create: `test/provider-e2e.test.mjs`
- Modify: `test/skill-contract.test.mjs`
- Modify: `package.json`
- Create: `docs/verification/2026-08-24-imvia-multi-provider-api-connectors.md`

- [ ] **Step 1: Write the fake-provider end-to-end test.** Start the injected HTTP service with an in-memory generic adapter, submit a workbench snapshot through `/api/v1/workbench/submissions`, claim it through the bridge, execute the exact job, emit progress, return two images and one video, and assert all three artifacts are imported without a second provider call.
- [ ] **Step 2: Add security assertions.** Search serialized HTTP responses, SSE events, job snapshots, and MCP results for credential field names and assert no secret values occur.
- [ ] **Step 3: Add a focused script in `package.json`.** Define `test:providers` as `node --test test/provider-*.test.mjs test/workbench-provider-selection.test.mjs test/workbench-provider-ui.test.mjs test/provider-e2e.test.mjs`.
- [ ] **Step 4: Run focused verification.** Use `pnpm test:providers`, `pnpm test:orchestration`, and `pnpm test:protection`; record platform-dependent native helper results separately.
- [ ] **Step 5: Write the verification record.** Document exact commands, passed tests, and any environment-only limitations without claiming a failed sandbox check is a provider implementation failure.

## Plan Self-Review

- Provider registry, connection persistence, credential isolation, generic REST execution, exact routing, HTTP/MCP wiring, UI selection, status/result presentation, and end-to-end verification each have a dedicated task.
- The plan preserves the existing Lovart path and adds no cross-provider fallback.
- All interfaces used by later tasks are named in earlier task sections.
- No task contains an unresolved placeholder or unspecified error-handling instruction.
- The plan does not authorize implementation, publishing, or commits; execution requires a separate user choice.
