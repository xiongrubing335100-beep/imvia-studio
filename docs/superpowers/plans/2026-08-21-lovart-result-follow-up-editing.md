# IMVIA Studio Phase 2: result workspace and text follow-up plan

> **Execution gate:** Do not implement this plan until Phase 1 verification is
> accepted and this plan is reviewed. This plan intentionally does not include
> image annotation strokes; those belong to the separate Phase 3 plan.

## Goal

Turn the existing empty right-side result panel into a durable result workspace
only after the first artifact is imported, while preserving the current empty
state before any result exists. Add text follow-up editing that sends the
selected artifact, its parent job, and the new instruction through the Phase 1
orchestrator with explicit Lovart activation and a new idempotency boundary.

## Non-negotiable boundaries

- Do not modify the existing Lovart plugin or its protected paths.
- Do not inject messages into the Codex conversation UI.
- Workbench buttons are explicit Lovart actions; generic Codex chat remains
  ImageGen unless the user explicitly addresses IMVIA/Lovart or continues a
  Lovart task with lineage evidence.
- Never call both providers, silently fall back, auto-confirm cost, or expose
  AK/SK, proxy addresses, upstream response text, or raw credential fields.
- Preserve the current empty result visual structure when the selected context
  has no imported artifacts.

## Phase 2 files

Likely prototype files (in the separate prototype workspace):

- `imvia-studio-prototype/src/App.jsx`
- `imvia-studio-prototype/src/interaction-model.js`
- `imvia-studio-prototype/src/services/imvia-client.js`
- `imvia-studio-prototype/src/styles.css`

Independent-repository adapter/backend files:

- `src/domain/workbench-service.js`
- `src/lovart/generation-orchestrator.js`
- `src/http/server.js`
- `test/` focused UI-model, HTTP, and orchestration tests

The prototype source remains the only UI source of truth; generated
`workbench/dist` assets are rebuilt and copied only after tests pass.

## Task 1: Define result presentation state

1. Add a pure presentation model that maps `{ job, artifacts }` to
   `empty | preparing | awaiting_cost | failed | populated` without changing
   stored job semantics.
2. Preserve the existing empty panel for `artifacts.length === 0` even when a
   job is loading, waiting for cost, or failed; show status copy inside the
   existing shell.
3. For the first imported artifact, switch to a populated workspace with:
   - artifact cards grouped by job and ordered by import order;
   - image/video/audio-specific preview affordances;
   - job status, model, project link, and generation time;
   - download/open-project actions that never send credentials to the browser.
4. Add pure tests for empty-to-populated transitions, partial results,
   failures, duplicate artifacts, and stale selected-job changes.

## Task 2: Persist text follow-up lineage

1. Add a versioned follow-up record to the local job/artifact model:
   `parent_job_id`, optional `parent_artifact_id`, `instruction`,
   `activation`, `project_id`, `created_at`, and a new idempotency key.
2. Validate that the parent job is successful or partially successful and that
   the selected artifact belongs to it.
3. Reuse the parent Lovart project by default; do not change the active project
   merely because a follow-up targets an explicit project.
4. Reuse a Lovart thread only when the direct parent thread is present and its
   lineage source is live IMVIA. Never inherit cost approval or a consumed
   decision.
5. Add migration tests for older jobs without follow-up fields and tests that
   reject cross-job artifacts, stale attempts, mismatched projects, and missing
   lineage evidence.

## Task 3: Add orchestrator follow-up operation

1. Add `orchestrator.followUp({ parent_job_id, artifact_id, instruction,
   idempotency_key, activation })`.
2. Build an immutable prompt snapshot from the parent snapshot plus the exact
   follow-up instruction; preserve the original prompt byte-for-byte in the
   stored lineage record.
3. Package only the selected managed artifact and any required parent
   references, upload through the existing managed transfer seam, and submit
   once to the resolved project.
4. Return the same pending-cost envelope and confirmation binding as a fresh
   generation. A failed Lovart request remains failed and is never sent to
   ImageGen.
5. Add fake-only tests for successful text follow-up, pending cost, explicit
   confirmation, retry idempotency, parent-thread reuse, and no fallback.

## Task 4: Expose HTTP/MCP follow-up adapters

1. Add `POST /api/v1/jobs/:jobId/follow-ups` with `{ artifact_id,
   instruction, idempotency_key }`; derive `{ source: "workbench_action" }`
   server-side and reject a client-supplied activation field.
2. Add `imvia_follow_up_generation` with an activation schema requiring either
   explicit Codex activation or contextual `parent_job_id`/`artifact_id`.
3. Add `GET /api/v1/jobs/:jobId` fields needed by the result workspace while
   retaining redaction and `Cache-Control: no-store`.
4. Add contract tests proving generic provider-neutral HTTP payloads cannot
   activate Lovart, credentials are absent, and the workbench action is the
   only implicit activation.

## Task 5: Implement the populated result UI

1. Keep the current empty state pixel-compatible for no-artifact contexts.
2. Render populated result cards only after the HTTP/SSE state includes an
   imported artifact.
3. Add a compact “再次编辑” text box per selected result. Submitting it must
   call the shared follow-up endpoint with the selected job/artifact IDs and
   show a local pending state until SSE reports the new job.
4. Add keyboard/focus/disabled/error states and ensure a second submission is
   impossible while the same idempotency key is pending.
5. Add browser-level tests against a fake HTTP service; do not call real
   Lovart, ImageGen, Keychain, or the existing plugin.

## Task 6: Verification and handoff

Run, in order:

```bash
node --test test/lovart-result-presentation.test.mjs \
  test/lovart-follow-up.test.mjs test/lovart-generation-orchestrator.test.mjs
node --test test/http-server.test.mjs test/mcp-lovart-connection.test.mjs
pnpm run test:orchestration
pnpm run test:mcp
pnpm test
pnpm run test:protection
pnpm run verify:protected-paths
```

Record loopback permission requirements and any existing protected-path drift
without refreshing the baseline. Rebuild the prototype only after the fake
browser tests pass. Then create and review the separate Phase 3 annotation
editor plan before touching canvas/stroke behavior.
