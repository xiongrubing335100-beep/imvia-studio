# Lovart One-Click Connection and Creation Design

## Goal

Make the independent IMVIA Studio plugin usable by a non-technical user: open a secure native key dialog from the workbench, save credentials locally, show connection status, and provide a direct Lovart creation path without terminal commands.

## Scope

- Add an IMVIA-owned secure credential flow. Credentials never enter MCP arguments, chat, logs, JSON state, or Git.
- Add a redacted connection status operation that validates credentials with the fixed Lovart mode endpoint.
- Add a Lovart creation adapter for prompt-based generation, status/result polling, and explicit high-cost confirmation.
- Keep the existing Milestone 5 fixture orchestration and Milestone 6 probe behavior available for regression coverage.
- Keep the existing Lovart plugin and all paths under `/Users/a1234/Documents/ChatGPT/lovart插件` untouched.

## User flow

1. The user chooses “连接 Lovart” in the IMVIA workbench.
2. IMVIA opens a native password-style dialog. The user enters AK and SK once.
3. IMVIA stores the pair in its own macOS Keychain service and validates the connection with `POST /v1/openapi/mode/query`.
4. The workbench shows only `connected`, `not_connected`, or a redacted stable error.
5. The user submits a creation prompt. IMVIA sends it to Lovart, polls the thread, and returns artifacts or an explicit pending-cost receipt.
6. A separate explicit confirmation operation is required before any pending high-cost operation is confirmed.

## Security and boundary rules

- The MCP never accepts AK/SK fields.
- The native helper owns the password fields and clears them after use.
- The Node process reads credentials only for the duration of an authenticated child request and never persists raw values.
- The Lovart base URL is fixed to `https://lgw.lovart.ai`; redirects are rejected and TLS verification remains enabled.
- Tests use fake Keychain and fake HTTP transports only; no test contacts Lovart.
- The existing Lovart plugin is not imported, executed, configured, or modified.
- No automatic generation, confirmation, retry, or live network call occurs during installation or tests.

## API shape

New MCP tools:

- `imvia_connect_lovart`: input `{}`; opens the secure native dialog and performs one connection check. Returns redacted status.
- `imvia_lovart_status`: input `{}`; returns the last local status without exposing credentials.
- `imvia_generate`: input `{prompt, project_id?, thread_id?, mode?, prefer_models?, include_tools?}`; returns a generation result or a pending-cost receipt.
- `imvia_confirm_generation`: input `{thread_id}`; confirms only after a separate user acceptance in the current conversation.

The existing 14 tools retain their schemas and behavior.

## Failure behavior

- Cancelled or invalid dialog leaves the previous credential item unchanged and returns `CREDENTIAL_SETUP_CANCELLED` or `CREDENTIAL_SETUP_INVALID`.
- Missing Keychain item returns `NOT_CONNECTED` with no Lovart request.
- HTTP 401/403 returns `AUTHENTICATION_FAILED`; network/TLS/schema failures return stable redacted codes.
- A pending high-cost result never triggers confirmation automatically.

## Verification

- Focused credential, HTTP signing, generation, and MCP contract tests pass with fake dependencies.
- Full existing suite passes except any pre-existing protected-path drift fingerprint failure, which is recorded without changing the baseline.
- Protected Lovart path status and fingerprint are captured before and after; no protected path is staged or modified.

## Milestone 7 implementation verification (2026-08-21)

- Focused new connection/client/generation/MCP/security tests: 19/19 passed.
- Milestone 6 probe/security regression: 145/145 passed.
- Milestone 5 orchestration regression: 58/58 passed.
- Full suite: 259 total, 258 passed, 1 failed only at the pre-existing protected-path fingerprint assertion.
- Plugin validator: passed.
- Protected-path ledger before and after was identical: changed 22, removed 3624, added 3729 (7375 total); ordered difference hash `ff6a497b7058e1031507df99316a45878dca165f885b858489b0c700107a661c`.
- No keychain read, live Lovart request, live creation, existing Lovart plugin execution, or protected-path write was performed.
