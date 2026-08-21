---
name: imvia-studio
description: Run IMVIA Studio's fixture-only Milestone 5 mock orchestration, optional Milestone 6 read-only probe, and explicit Milestone 7 Lovart connection/creation flow without exposing credentials or touching the existing Lovart plugin.
---

# IMVIA Studio

## Open the web workbench

When the user asks to open, launch, or use IMVIA Studio, call
`imvia_open_workbench` with `{}`. It returns a local `workbench_url`.
Immediately call `codex_app__open_in_codex` with
`{ placement: "right", target: { type: "browser", url: workbench_url } }`.
This opens the bundled IMVIA Studio workbench in Codex's right-side browser
panel. Do not ask the user to start a terminal, paste a URL, or run a local
server command. The page uses the same local IMVIA state and HTTP/SSE service
as the MCP tools. The original Lovart plugin remains independent.

## Milestone 5 fixture-only gate

Never call an installed or real Lovart MCP tool in Milestone 5. Use only a test-provided adapter explicitly labelled `fixture` or `mock_lovart`. If no such adapter is present, stop and report that Milestone 5 cannot execute. Never inspect, configure, reconnect, or fall back to Lovart, and never read credentials.

## Read, suggest, confirm, snapshot

Read with `imvia_get_state` and `imvia_list_pending_jobs`. Suggestions may revision-patch an editable draft with `imvia_patch_workbench`; after workbench confirmation, re-read and prepare exactly one immutable snapshot with `imvia_prepare_generation`. Do not treat queued_for_agent as cost approval.

## Execute the immutable snapshot

Use the mock `lovart_upload` semantics in stable prompt-token order, write `uploading`, then use mock `lovart_generate` semantics with `snapshot.prompt.text` byte-for-byte. Never rewrite a prepared prompt.

## Cost confirmation hard stop

On fixture cost, write `awaiting_cost_confirmation` and display job ID, attempt, amount, unit, and checked time in the current conversation. Before explicit acceptance, mock `lovart_confirm` count must remain zero. Ambiguous, stale, mismatched, inherited, or old-session answers do not count.

For explicit acceptance, call `imvia_record_cost_decision`, then `imvia_claim_cost_decision`, then mock `lovart_confirm` exactly once, then `imvia_update_job` to `generating`. For explicit decline, record `declined` and never call mock `lovart_confirm`. Never auto-retry a consumed decision.

If mock `lovart_confirm` fails, use `imvia_update_job` to persist `confirmation_failed` evidence against the exact claimed decision while remaining in `awaiting_cost_confirmation`, then stop. A retry requires a new explicit current-session acceptance, a new idempotency key, a new decision ID, and a new claim. Never reuse the failed decision.

## Status, billing, results, iteration

Write fixture status through `imvia_update_job`. Cache only sourced billing mode with `imvia_update_account_status`; unknown balance and unit stay null with `UPSTREAM_CAPABILITY_UNAVAILABLE`. Import only already-managed local fixture artifacts through `imvia_import_result`. Continue through `imvia_create_iteration`; reuse a thread only from the direct parent chain, and never inherit cost approval.

## Stop conditions

On revision/status conflict, unknown response, missing mock adapter, or failed confirmation, stop, re-read local state when safe, and explain the state. Do not skip a state, blindly replay a side effect, connect to real Lovart without the Milestone 7 user action, install a marketplace entry, or advance a fixture job into live execution.

## Milestone 6 read-only Lovart probe

The user must explicitly request the read-only probe in the current conversation. General permission, a queued job, earlier approval, or a fixture decision is insufficient. Call `imvia_authorize_lovart_probe` before `imvia_probe_lovart_capabilities`.

Codex must never run `pnpm run configure:lovart-readonly`, `pnpm run enable:lovart-readonly-probe`, or `pnpm run disable:lovart-readonly-probe` for the user. If the probe is disabled, stop and ask the user to run the required setup or enable command themselves.

One explicit request in the current conversation permits exactly one fresh authorization and one probe attempt. After any failure or consumed authorization, never change an idempotency key, re-authorize, or retry; stop and await a new explicit request in the current conversation.

Feature disabled, unsupported platform, invalid, expired, or consumed authorization, or a missing credential reference must produce zero Lovart requests. An idempotent completed replay must perform zero Keychain reads and zero Lovart requests.

The probe is advisory and must not alter job, draft, artifact, cost, iteration, or execution behavior. Never upload, generate, confirm, query projects, threads, status, results, or balance; never expose AK/SK; and never call the existing Lovart plugin.

## Milestone 7 one-click Lovart workflow

When the user explicitly asks to connect Lovart, call `imvia_connect_lovart` with
an empty object. The tool opens the native secure dialog; never ask the user to
paste AK/SK into chat, MCP arguments, environment variables, or a file. The
result is redacted. `imvia_lovart_status` reads only the redacted local state.

After a connected result, call `imvia_generate` with the user's original
prompt. It may return `pending_confirmation`; show the amount and unit and
wait for an explicit current-session acceptance before calling
`imvia_confirm_generation`. Never auto-confirm, auto-retry a consumed action,
or expose credential values. The existing Lovart plugin remains independent:
do not import, execute, configure, reconnect, or modify it.

The launcher uses a portable proxy policy: `IMVIA_PROXY_MODE=auto` (the
default) honors standard proxy variables, then uses the macOS system HTTPS
proxy only when no standard proxy is present, and otherwise connects directly.
`direct`, `env`, and `system` modes are available for explicit deployments. Do
not ask the user to disable a VPN or enter proxy settings into chat.
