# IMVIA Studio MCP

This is an independent development plugin for fixture-only Milestone 5 mock
orchestration. It does not connect to Lovart, access credentials, install a
marketplace entry, or change a UI.

## Current development scope

- MCP Server ID: `imvia-studio`
- MCP tools: exactly the 12 local tools listed below
- Development data directory reserved: `.imvia-studio-dev/`
- Loopback HTTP/SSE: `127.0.0.1:4190` by default
- Versioned local JSON state in `.imvia-studio-dev/` during development
- Fixture-only mock adapters with immutable snapshots, ordered job transitions,
  cost-confirmation display, and idempotent fixture result import
- Imported files must already exist inside the active IMVIA data directory;
  the plugin hashes and registers them without moving or deleting the source
- No real Lovart call, marketplace install, or UI change is part of Milestone 5.

## Tool inventory

The MCP server exposes exactly these 12 local tools:

- `imvia_claim_cost_decision`
- `imvia_create_iteration`
- `imvia_get_account_status`
- `imvia_get_state`
- `imvia_health`
- `imvia_import_result`
- `imvia_list_pending_jobs`
- `imvia_patch_workbench`
- `imvia_prepare_generation`
- `imvia_record_cost_decision`
- `imvia_update_account_status`
- `imvia_update_job`

## Fixture-only orchestration

Only test-provided adapters labelled `fixture` or `mock_lovart` may model the
Lovart upload, generation, and confirmation steps. The prepared prompt is used
byte-for-byte, and stable prompt-token references determine upload order.

Cost decisions are single-use: record the explicit decision, claim it, then
confirm the fixture cost exactly once before generating. A queued job is not
cost approval. A failed fixture confirmation is persisted against the claimed
decision; retry requires a new current-session acceptance, idempotency key,
decision ID, and claim. Account status caches only sourced billing mode;
unavailable balance and unit values remain `null` with
`UPSTREAM_CAPABILITY_UNAVAILABLE`.

Fixture checked times use canonical UTC ISO text with millisecond precision
and allow at most five minutes of clock skew into the future. Optional expiry
times must use the same form and cannot precede their checked time.

Iterations may reuse a thread only from the direct parent chain and never
inherit a prior cost approval. Result import accepts only already-managed local
fixture artifacts.

## Verification

From the standalone repository root in a dedicated shell:

```sh
cd /path/to/imvia-studio
pnpm install --frozen-lockfile
pnpm run test:orchestration
node --test test/*.test.mjs
```

The recorded protected-path baseline belongs to the original development
workspace. Verify it only from that workspace root, where the three protected
Lovart paths exist:

```sh
cd /path/to/original-development-workspace
node imvia-studio/scripts/verify-protected-paths.mjs verify imvia-studio/test/protected-paths.manifest.json
```

The protected-path manifest covers `lovart-codex-plugin`,
`lovart-local-marketplace`, and `lovart-output`. The verifier is read-only and
fails on added, removed, changed, or retargeted protected entries.

The targeted command verifies the fixture-only policy, cost confirmation,
account status, iterations, mock adapter, agent workflow, and skill contract.
