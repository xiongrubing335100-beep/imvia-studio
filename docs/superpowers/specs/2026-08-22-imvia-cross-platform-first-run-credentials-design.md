# IMVIA Studio Cross-Platform First-Run Credentials Design

## Status

Approved direction, awaiting review of this written specification before implementation planning.

## Goal

Make Lovart connection a first-run IMVIA Studio onboarding step on macOS and Windows, without requiring end users to install Swift, Xcode, Command Line Tools, PowerShell modules, a language runtime, or any other developer tooling.

IMVIA Studio remains completely independent from the existing Lovart plugin. The two plugins must not share, discover, migrate, overwrite, or infer each other's credentials, connection state, projects, threads, settings, or local storage.

## Superseded behavior

This design supersedes only the credential onboarding and connection-status portions of `2026-08-21-lovart-one-click-connection-design.md`:

- A user no longer starts first-time setup from a persistent **连接 Lovart** button in the workbench status rail.
- IMVIA no longer invokes `swift scripts/configure-lovart.swift` at runtime.
- Missing credentials are handled as first-run onboarding, not as a normal status-rail condition.

The prior design's explicit generation activation, cost confirmation, provider isolation, fixed Lovart endpoint, redacted errors, and prohibition on automatic generation remain in force.

## Product decisions

1. The first supported release covers macOS and Windows.
2. IMVIA owns a separate credential namespace on every platform.
3. Plugin installation itself performs no network request and opens no custom process.
4. The first call that opens the IMVIA workbench is the authoritative onboarding trigger.
5. The marketplace entry declares `policy.authentication: "ON_INSTALL"` to describe product intent, but the first workbench open remains the reliable executable boundary.
6. Credential setup may start automatically, but setup does not authorize upload, generation, cost confirmation, project creation, or any other Lovart side effect.
7. The workbench status rail displays a Lovart item only when IMVIA is connected.
8. Cancelling setup does not break the local workbench. Lovart-dependent actions stay locked and may reopen the setup flow after an explicit user action.

## User experience

### First open without IMVIA credentials

1. The user installs IMVIA Studio and restarts Codex as required by plugin installation.
2. The user opens IMVIA Studio.
3. `imvia_open_workbench` checks only the IMVIA-owned credential namespace.
4. The workbench opens in a neutral onboarding state while a bundled native credential helper starts.
5. The helper shows secure Access Key and Secret Key fields outside the browser.
6. After submission, IMVIA validates the candidate credentials against the fixed Lovart endpoint.
7. On success, the helper commits the credentials to the platform security store and the workbench transitions to its normal connected state.
8. The right-side status rail displays **Lovart 已连接**.

### Returning connected user

1. IMVIA reads the redacted state of its own credential item.
2. If a complete credential pair exists, the workbench opens normally without another prompt.
3. No existing Lovart-plugin state is inspected.

### Cancellation or setup failure

- The workbench remains available for local and non-Lovart functionality.
- The status rail does not show **Lovart 未连接** and does not contain a connection button.
- The onboarding area explains the redacted failure and provides **重试连接**.
- An explicit Lovart-dependent action may reopen onboarding.
- No credential, project, upload, generation, or confirmation side effect occurs after cancellation.

### Reconnect, replace, and disconnect

- **更换密钥** and **断开连接** live in workbench settings, not in the status rail.
- Replacing credentials validates the candidate pair before replacing the last working pair.
- Disconnect requires an explicit user action and deletes only the IMVIA-owned credential item.
- These actions never affect the existing Lovart plugin.

## Architecture

### Components

#### First-run coordinator

The MCP-side coordinator owns the onboarding state machine and is called by `imvia_open_workbench`.

It exposes redacted states only:

- `checking`
- `setup_required`
- `setup_active`
- `validating`
- `connected`
- `cancelled`
- `failed`

The coordinator prevents duplicate helper processes. Concurrent workbench opens observe the same setup session instead of starting multiple dialogs.

#### Credential service

`src/lovart/credentials.js` becomes a platform-neutral service that depends on a helper adapter. It must not contain platform UI code or invoke source files through a compiler.

The service owns:

- redacted status checks;
- a single active setup session;
- candidate validation and commit sequencing;
- reading credentials for authenticated Lovart calls;
- explicit replacement and deletion;
- stable redacted error mapping.

#### Bundled credential helper

A precompiled native helper is packaged for each supported operating-system and CPU combination:

```text
native/
├── darwin-arm64/imvia-credential-helper
├── darwin-x64/imvia-credential-helper
├── win32-arm64/imvia-credential-helper.exe
└── win32-x64/imvia-credential-helper.exe
```

The release build produces these binaries. End-user machines only execute them.

The helper implementation should use one cross-platform codebase where practical, with thin platform storage adapters. Rust is the preferred implementation language because it can produce self-contained binaries for the required targets without a user-installed runtime. The implementation plan must validate the selected GUI and secure-storage libraries before coding.

#### Platform credential stores

- macOS: Keychain generic-password item with service `ai.imvia.studio.lovart` and account `credentials`.
- Windows: Credential Manager generic credential with target `IMVIA.Studio.Lovart`.

Both values contain only the IMVIA credential pair. Names from the existing Lovart plugin are protected foreign namespaces and must never be queried.

#### Workbench onboarding UI

The workbench loads from a neutral URL. Connection state and errors must not be encoded in query parameters.

The UI obtains redacted state from the loopback API or existing event stream and renders one of:

- an onboarding surface while setup is required, active, validating, cancelled, or failed;
- the normal workbench with **Lovart 已连接** in the status rail when connected.

The browser never receives Access Key or Secret Key fields.

## Helper protocol

The Node process launches a resolved absolute helper path with `execFile` or `spawn`, a fixed command argument, shell execution disabled, and inherited anonymous pipes.

Supported operations:

- `configure`: show the secure dialog, exchange a candidate pair with the parent over private stdio, and commit only after a validation verdict;
- `status`: report whether the IMVIA credential item contains a complete pair;
- `read`: return the pair only to the parent process over private stdio for the lifetime of one authenticated operation;
- `clear`: delete only the IMVIA credential item after explicit user intent.

Public MCP, HTTP, and workbench responses contain only stable redacted envelopes. Secrets must never appear in command-line arguments, environment variables, URLs, browser state, MCP arguments or results, logs, local JSON state, test snapshots, analytics, or thrown error messages.

### Candidate validation handshake

Credential replacement must not destroy a previously working pair.

1. The helper collects a candidate pair without storing it.
2. The candidate travels to the parent through the helper's private stdio protocol.
3. The existing fixed-endpoint Lovart client performs one validation request.
4. The parent returns a redacted commit or reject verdict to the helper.
5. On commit, the helper writes the candidate pair to the IMVIA platform store.
6. On reject, cancellation, timeout, or process failure, the candidate is discarded and any previous credential item remains unchanged.
7. Both processes clear candidate buffers and references as soon as practical.

No generation, project lookup, upload, cost check, or confirmation is part of validation.

## Workbench-open sequence

`imvia_open_workbench` must return promptly and must not block for the entire duration of user credential entry.

1. Start or reuse the local workbench service.
2. Read redacted IMVIA credential status.
3. If connected, return the normal neutral workbench URL.
4. If setup is required, create or reuse a setup session and start the native helper asynchronously.
5. Return the same neutral workbench URL with a redacted setup-session identifier held server-side, not in the URL.
6. The workbench subscribes to redacted setup state and transitions automatically after validation.

Repeated `imvia_open_workbench` calls while setup is active must not create additional dialogs.

## API and tool changes

### Retained tools

- `imvia_open_workbench`: becomes first-run aware and starts or reuses onboarding when needed.
- `imvia_lovart_status`: returns redacted IMVIA-only status.
- `imvia_connect_lovart`: remains available for explicit retry or credential replacement, but is no longer the normal first-run entry point.

### Loopback endpoints

- `GET /api/v1/lovart/status`: redacted connected or setup-required state.
- `POST /api/v1/lovart/connect`: explicit retry or replacement only.
- The existing workbench state/event transport carries redacted onboarding transitions.

No endpoint accepts credential fields.

### Stable result codes

At minimum:

- `CONNECTED`
- `SETUP_REQUIRED`
- `SETUP_ACTIVE`
- `SETUP_CANCELLED`
- `SETUP_INVALID`
- `HELPER_NOT_PACKAGED`
- `HELPER_LAUNCH_FAILED`
- `PLATFORM_UNSUPPORTED`
- `CREDENTIAL_STORE_DENIED`
- `AUTHENTICATION_FAILED`
- `UPSTREAM_UNREACHABLE`
- `UPSTREAM_SECURITY_REJECTED`

Messages must explain the user's next safe action without exposing stderr or credential material.

## Packaging and distribution

1. Build helpers in a macOS and Windows CI matrix for all four target combinations.
2. Sign and notarize macOS binaries and apply Windows Authenticode signing before packaging.
3. Include an integrity manifest with a digest for each helper.
4. Resolve helpers strictly from the installed plugin directory based on `process.platform` and `process.arch`.
5. Verify the digest before execution.
6. Never fall back to `swift`, `powershell`, `cmd`, a source script, a PATH lookup, or a binary from another plugin.
7. Fail closed with `HELPER_NOT_PACKAGED`, `PLATFORM_UNSUPPORTED`, or `UPSTREAM_SECURITY_REJECTED` when resolution or verification fails.

The personal marketplace entry changes from `authentication: "ON_USE"` to `authentication: "ON_INSTALL"` through the supported marketplace/cachebuster update flow. It must not be edited ad hoc during implementation.

## Security invariants

- IMVIA and the existing Lovart plugin remain different providers and credential owners.
- No code searches another plugin's directories, Keychain services, Credential Manager targets, environment variables, config files, project state, or processes.
- Credential setup never counts as generation activation or cost approval.
- A saved credential never triggers a Lovart request except an explicit validation or user-requested authenticated operation.
- The browser and loopback HTTP service never handle raw credentials.
- Child-process stderr is consumed only for bounded internal diagnostics and is never returned directly.
- Tests use fake helpers, fake credential stores, and fake Lovart transports.
- Source distributions contain no real credentials and no test fixture resembling a production key.

## Failure and recovery behavior

- Missing helper: show a redacted installation-integrity error and disable retry until the plugin is repaired.
- Unsupported platform or architecture: keep local features available and explain the supported targets.
- User cancellation: return to the setup-required onboarding surface without changing stored credentials.
- Invalid candidate: preserve the previous pair, show an authentication error, and allow explicit retry.
- Store access denied: preserve the previous pair and offer a retry after the user resolves the OS permission prompt.
- Helper crash or protocol mismatch: terminate the session, discard candidate material, and allow one explicit fresh retry.
- Network failure during validation: do not store an unvalidated first-time pair and do not replace a working pair.
- Duplicate open or connect requests: reuse or reject against the active setup session; never show multiple dialogs.

## Migration

- Existing valid credentials under `ai.imvia.studio.lovart` are recognized and do not trigger onboarding.
- Existing IMVIA users without a complete pair enter first-run onboarding on their next workbench open.
- The legacy Swift source remains only until migration tests pass, then is removed from runtime packaging and scripts.
- No migration reads or writes any existing Lovart-plugin credential namespace.
- Plugin upgrades preserve IMVIA credential items unless the user explicitly disconnects.

## Implementation boundaries

Expected areas of change:

- `.codex-plugin/plugin.json` metadata and user-facing descriptions;
- personal marketplace metadata through the plugin cachebuster/update flow;
- `skills/imvia-studio/SKILL.md` activation and onboarding contract;
- `src/lovart/credentials.js` platform-neutral service;
- a new helper resolver and first-run coordinator under `src/lovart/`;
- `src/index.js` tool wiring;
- `src/http/server.js` redacted onboarding endpoints/events;
- workbench UI bundle source and rebuilt `workbench/dist` assets;
- release build, signing, integrity-manifest, and packaging automation;
- focused credential, MCP, HTTP, security, workbench, packaging, and migration tests.

The implementation must not modify files in the existing Lovart plugin repository.

## Verification and acceptance criteria

### Cross-platform packaging

- A clean macOS machine without Xcode or Command Line Tools can complete first-run setup.
- A clean Windows machine without a developer runtime can complete first-run setup.
- All supported platform/architecture packages contain the correct signed helper and matching integrity digest.
- No runtime path invokes Swift, PowerShell, a compiler, or a source script.

### User flow

- The first workbench open with no IMVIA credential automatically starts exactly one setup dialog.
- Successful setup transitions to the connected workbench without a manual page reload.
- Returning connected users receive no prompt.
- Cancellation leaves local workbench features usable and Lovart actions locked.
- The status rail shows only the connected state.
- Retry, replacement, and disconnect behave as specified.

### Independence and security

- Tests install or simulate both IMVIA and the existing Lovart plugin and prove that neither plugin's credential or state changes when operating the other.
- Searches of URLs, logs, MCP envelopes, HTTP payloads, JSON state, snapshots, and analytics find no candidate or stored key material.
- Invalid replacement preserves the last working IMVIA pair.
- Setup never creates a Lovart project, upload, generation, confirmation, or chargeable action.

### Regression

- Existing generation activation, immutable submission, explicit cost confirmation, result import, and iteration tests continue to pass.
- Milestone 5 fixture behavior and Milestone 6 default-disabled probe behavior remain isolated.
- Plugin validation and protected-path verification pass.

## Rollout

1. Introduce the helper protocol and fake adapters behind the existing credential-service interface.
2. Add packaged macOS and Windows helpers and CI verification.
3. Add first-run coordinator and redacted state transitions.
4. Update the workbench onboarding and connected-only status rail.
5. Update the skill contract and marketplace authentication timing.
6. Run cross-platform clean-machine smoke tests.
7. Remove runtime Swift setup and publish a cache-busted plugin build.

Rollback restores the previous plugin package without deleting the IMVIA credential namespace. A rollback must not touch the existing Lovart plugin.
