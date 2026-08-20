---
name: imvia-studio
description: Run IMVIA Studio's fixture-only Milestone 5 mock orchestration; do not use real Lovart services, credentials, marketplace, or UI.
---

# IMVIA Studio

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

On revision/status conflict, unknown response, missing mock adapter, or failed confirmation, stop, re-read local state when safe, and explain the state. Do not skip a state, blindly replay a side effect, connect to real Lovart, install a marketplace entry, or advance to Milestone 6.
