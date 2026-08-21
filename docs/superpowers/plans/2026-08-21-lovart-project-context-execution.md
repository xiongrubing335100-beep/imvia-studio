# Lovart Project Context and Unified Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable Lovart project selection, explicit/contextual provider routing, and one shared IMVIA execution path for workbench and Codex generation requests.

**Architecture:** Keep the existing local IMVIA project/draft/job store as the source of truth and add a separate Lovart project registry with an active selection. A `ProjectContextService` resolves explicit, active, or automatically-created Lovart projects, while a `GenerationOrchestrator` is the only component allowed to turn a generation request into Lovart side effects. HTTP and MCP adapters call the same services; the workbench does not inject messages into the Codex UI.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/sdk` 1.30.0, Zod 3.25.76, local JSON persistence with fail-closed locking, Node test runner, bundled React workbench source in the separate prototype workspace.

**Spec:** `docs/superpowers/specs/2026-08-21-lovart-project-execution-result-editing-design.md`

## Global Constraints

- Do not modify, overwrite, import, execute, configure, or reconnect the existing Lovart plugin.
- Keep the existing Lovart protected-path baseline and before/after fingerprint verification.
- Do not expose AK/SK through MCP arguments, HTTP requests from the browser, chat, JSON state, logs, test fixtures, or Git.
- Do not store a user-specific VPN or proxy address. Use the normal host networking path and the fixed official Lovart endpoint.
- Do not automatically confirm a cost.
- Do not silently fall back from Lovart to Codex ImageGen or from ImageGen to Lovart.
- Do not invoke both providers for one user request.
- Do not claim a precise mask-edit capability until a supported upstream contract is verified.
- Use fake Keychain, fake HTTP transport, and fake Lovart responses for automated tests; no test contacts real Lovart.
- Keep the existing Milestone 5 fixture, Milestone 6 probe, connection, and orchestration contracts passing unless a schema change is explicitly covered by compatibility tests.

## File map

### Phase 1 files in this plan

- Create: `src/domain/lovart-project-context.js` — pure project locator normalization and selection helpers.
- Create: `src/lovart/project-context-service.js` — project validation, creation, registry update, and active-project resolution.
- Create: `src/lovart/generation-orchestrator.js` — shared direct-generation submission, execution, recovery, and redacted job result mapping.
- Create: `test/lovart-project-context.test.mjs` — pure locator and selection tests.
- Create: `test/lovart-project-service.test.mjs` — fake-client project lifecycle tests.
- Create: `test/lovart-generation-orchestrator.test.mjs` — fake-Lovart end-to-end orchestration tests.
- Create: `test/lovart-routing-policy.test.mjs` — provider activation and continuation tests.
- Modify: `src/domain/workbench-service.js` — schema version, migration, registry operations, live job snapshots, and live-safe transitions.
- Modify: `src/domain/source-policy.js` — preserve fixture-only rules while adding explicitly named live IMVIA sources.
- Modify: `src/lovart/client.js` — project create/validate requests and stable response handling.
- Modify: `src/lovart/generation-service.js` — expose gateway operations needed by the orchestrator without changing credential behavior.
- Modify: `src/index.js` — project MCP tools, activation schema, and orchestrator wiring.
- Modify: `src/http/server.js` — project and generation/job HTTP routes.
- Modify: `skills/imvia-studio/SKILL.md` — explicit Lovart activation and contextual continuation rules.
- Modify: `test/skill-contract.test.mjs` — exact routing and zero-call contract assertions.
- Modify: `test/lovart-client.test.mjs` — project endpoint request/response tests.
- Modify: `test/lovart-generation.test.mjs` — live-source and orchestrator compatibility tests.
- Modify: `test/mcp-lovart-connection.test.mjs` — new MCP tool inventory and activation schemas.
- Modify: `test/mcp-health.test.mjs` — tool inventory only when the approved schema changes require it.
- Modify: `test/http-server.test.mjs` — project and direct-generation route tests.
- Modify: `test/workbench-service.test.mjs` — state migration and live snapshot tests.

### Later plans, created after Phase 1 passes

- Phase 2 plan: result cards, empty-to-populated transition, text follow-up, and live thread lineage.
- Phase 3 plan: image annotation editor, stroke document persistence, annotation upload packaging, and capability-gated messaging.

### Spec coverage map

- Project resolution, automatic creation, selection, persistence, and migration: Tasks 1–3.
- Shared side-effect path, live-safe evidence, idempotency, recovery, and cost binding: Tasks 4–5.
- Explicit/contextual provider isolation and Codex routing contract: Task 6.
- Workbench project/job adapter surface: Task 7.
- Credentials, fixed endpoint, protected plugin boundary, regression, and acceptance evidence: Tasks 0 and 8.
- Empty-to-populated result UI, text revisions, and live thread lineage: the Phase 2 plan created at Task 8 Step 5.
- Image annotation editor, annotation artifacts, and upstream capability gate: the Phase 3 plan created after Phase 2 passes.

## Phase 1 tasks

### Task 0: Capture baselines before code changes

**Files:**
- Read-only: repository status, protected-path manifest, current test/build outputs.

**Interfaces:**
- Produces the baseline evidence that every later task must preserve.

- [ ] **Step 1: Confirm the worktree and protected boundary**

Run from the independent IMVIA worktree:

```bash
git status --short --branch
pnpm run verify:protected-paths
```

Expected: the branch is clean except for no user changes, and the protected-path verifier records the current baseline without writing to the Lovart workspace.

- [ ] **Step 2: Run the existing focused suites**

```bash
pnpm run test:orchestration
pnpm run test:probe
pnpm run test:mcp
pnpm test
```

Record any known external protected-fingerprint failure separately. Do not change the baseline to make a test pass.

- [ ] **Step 3: Record the baseline in the task report**

Create the Phase 1 report only after the plan is approved and implementation starts. Include command, result count, and protected-path evidence; never include credentials.

### Task 1: Add pure Lovart project locator and routing primitives

**Files:**
- Create: `src/domain/lovart-project-context.js`
- Test: `test/lovart-project-context.test.mjs`

**Interfaces:**
- `normalizeLovartProjectLocator(locator) -> { project_id, canvas_url }` or throws `DomainError` with `INVALID_LOVART_PROJECT_LOCATOR`.
- `chooseLovartProject({ explicit_project_id, active_project_id }) -> { project_id, source }` or `{ project_id: null, source: "auto_create" }`.
- `assertContinuationParent({ activation_source, parent_job_id, artifact_id })` rejects contextual continuation without a lineage reference.

- [ ] **Step 1: Write failing locator tests**

Add tests for:

```js
assert.deepEqual(normalizeLovartProjectLocator("project-1"), {
  project_id: "project-1",
  canvas_url: "https://www.lovart.ai/canvas?projectId=project-1",
});
assert.deepEqual(
  normalizeLovartProjectLocator("https://www.lovart.ai/canvas?projectId=project-1"),
  { project_id: "project-1", canvas_url: "https://www.lovart.ai/canvas?projectId=project-1" },
);
assert.throws(() => normalizeLovartProjectLocator("https://evil.example/?projectId=project-1"), /INVALID_LOVART_PROJECT_LOCATOR/);
assert.throws(() => normalizeLovartProjectLocator(""), /INVALID_LOVART_PROJECT_LOCATOR/);
```

Also cover empty explicit selection, active fallback, auto-create selection, and continuation without a parent job or artifact.

- [ ] **Step 2: Run the focused test to verify RED**

```bash
node --test test/lovart-project-context.test.mjs
```

Expected: FAIL because the new module and exports do not exist.

- [ ] **Step 3: Implement the pure functions**

Use URL parsing, require `https:`, require `www.lovart.ai`, require the `/canvas` pathname, and require a non-empty `projectId`. Reject credentials, fragments containing another locator, and arbitrary hosts. Normalize IDs without changing their case.

- [ ] **Step 4: Run focused and regression tests**

```bash
node --test test/lovart-project-context.test.mjs test/source-policy.test.mjs
```

Expected: PASS with the existing fixture source policy unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/domain/lovart-project-context.js test/lovart-project-context.test.mjs
git commit -m "feat: add Lovart project locator policy"
```

### Task 2: Add versioned Lovart project registry and migration

**Files:**
- Modify: `src/domain/workbench-service.js`
- Test: `test/workbench-service.test.mjs`
- Test: `test/lovart-project-service.test.mjs`

**Interfaces:**
- `service.getLovartProjects() -> { active_lovart_project_id, projects }`.
- `service.setLovartProject({ project_id, name, canvas_url, source }) -> { active_project, projects }`.
- `service.recordLovartProject({ project_id, name, canvas_url, source }) -> { project }` without changing active selection unless the caller requests it.
- State schema changes from `"1"` to `"2"`; migration from schema `"1"` is non-destructive.

- [ ] **Step 1: Write failing state and migration tests**

Cover:

```js
const state = await service.getState();
assert.equal(state.schema_version, "2");
assert.equal(state.active_lovart_project_id, null);
assert.deepEqual(state.lovart_projects, []);

const selected = await service.setLovartProject({
  project_id: "project-1",
  name: "人物海报",
  canvas_url: "https://www.lovart.ai/canvas?projectId=project-1",
  source: "user_selected",
});
assert.equal(selected.active_project.project_id, "project-1");
```

Create a legacy schema `"1"` fixture with `projects[0].lovart_project_id = "legacy-project"`, reload the service, and assert that the registry contains the legacy project, the local project remains intact, and a private backup is created before replacement.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
node --test test/workbench-service.test.mjs test/lovart-project-service.test.mjs
```

Expected: FAIL because the registry, schema version, and migration are absent.

- [ ] **Step 3: Implement initial schema and migration**

Add `lovart_projects` and `active_lovart_project_id` to `createInitialState`. Add a load-time migration that clones the old document, imports each non-empty `projects[].lovart_project_id`, validates the result, and atomically replaces the state only after validation. On any migration error, preserve the original state and surface `STATE_MIGRATION_FAILED`.

- [ ] **Step 4: Implement registry operations**

Validate all project IDs through `normalizeLovartProjectLocator` before persistence. Store only normalized IDs and official canvas URLs. `setLovartProject` updates `last_used_at`, the active ID, and an audit event; it does not mutate existing job snapshots.

- [ ] **Step 5: Run focused and full domain tests**

```bash
node --test test/workbench-service.test.mjs test/lovart-project-context.test.mjs test/iteration.test.mjs test/cost-confirmation.test.mjs
```

Expected: PASS, including all existing fixture iteration and cost tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain/workbench-service.js test/workbench-service.test.mjs test/lovart-project-service.test.mjs
git commit -m "feat: persist active Lovart project context"
```

### Task 3: Add fake-tested Lovart project gateway operations

**Files:**
- Modify: `src/lovart/client.js`
- Modify: `src/lovart/generation-service.js`
- Create: `src/lovart/project-context-service.js`
- Test: `test/lovart-client.test.mjs`
- Test: `test/lovart-project-service.test.mjs`

**Interfaces:**
- `client.createProject({ project_name? }) -> { project_id, project_name? }` using `POST /v1/openapi/project/save` with an empty project ID.
- `client.validateProject({ project_id }) -> { valid, project_name? }` using `GET /v1/openapi/project/validate`.
- `projectContextService.list() -> { active_lovart_project_id, projects }`.
- `projectContextService.select({ locator, source }) -> project` validates upstream before changing active state.
- `projectContextService.create({ name? }) -> project` creates upstream, validates the returned ID, persists it, and selects it.
- `projectContextService.resolve({ explicit_locator? }) -> { project_id, source }` applies explicit, active, then auto-create resolution.

- [ ] **Step 1: Add failing fake-fetch client tests**

Assert that project creation sends an empty `project_id`, the fixed official path, signed headers, and no credentials in the JSON body. Assert that validation uses the exact project ID query and maps invalid responses to `INVALID_LOVART_PROJECT` without mutating local state.

- [ ] **Step 2: Run the client tests to verify RED**

```bash
node --test test/lovart-client.test.mjs
```

Expected: FAIL because project methods do not exist.

- [ ] **Step 3: Implement fixed-path client methods**

Keep `baseUrl === LOVART_BASE_URL`, `redirect: "error"`, stable error mapping, and the existing signed-header behavior. Do not add a user-configurable proxy or base URL.

- [ ] **Step 4: Implement `ProjectContextService`**

Inject the domain service and client factory so tests can use a fake client. `resolve` must persist an auto-created project before returning it and must never create a second project for an existing active ID.

- [ ] **Step 5: Run project and connection regression tests**

```bash
node --test test/lovart-client.test.mjs test/lovart-connection-security.test.mjs test/lovart-credentials.test.mjs
```

Expected: PASS with zero live network calls.

- [ ] **Step 6: Commit**

```bash
git add src/lovart/client.js src/lovart/generation-service.js src/lovart/project-context-service.js test/lovart-client.test.mjs test/lovart-project-service.test.mjs
git commit -m "feat: add fake-tested Lovart project gateway"
```

### Task 4: Permit explicit live IMVIA job evidence without weakening fixtures

**Files:**
- Modify: `src/domain/source-policy.js`
- Modify: `src/domain/workbench-service.js`
- Test: `test/source-policy.test.mjs`
- Test: `test/workbench-service.test.mjs`

**Interfaces:**
- `assertM5Source` continues to accept only fixture/mock evidence for Milestone 5 operations.
- `isAllowedLiveSource(source)` accepts only named IMVIA live sources such as `imvia:lovart_submit`, `imvia:lovart_status`, `imvia:lovart_import`, and `imvia:lovart_confirm`.
- `service.createDirectGenerationJob({ snapshot, lovart_project_id, activation_source, idempotency_key }) -> { job, idempotent }`.
- `service.updateLiveJob({ job_id, expected_status, next_status, attempt, source, ... }) -> { job }` enforces the live transition table and exact attempt.

- [ ] **Step 1: Write failing source and direct-job tests**

Assert fixture methods reject `imvia:lovart_submit`, live methods reject arbitrary `lovart:...`, and a direct job stores an immutable snapshot containing the resolved project and activation source. Assert a later active-project change does not change the job's project.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
node --test test/source-policy.test.mjs test/workbench-service.test.mjs
```

Expected: FAIL because live source classification and direct jobs do not exist.

- [ ] **Step 3: Implement separate fixture and live source predicates**

Do not broaden `assertFixtureSource`. Add a separate live assertion and call it only from the new orchestrator path. Preserve Milestone 5 error codes and tests.

- [ ] **Step 4: Implement direct job creation and live transitions**

Use the existing idempotency map. A repeated key for the same project and activation returns the original job; a key reused for different content raises `IDEMPOTENCY_CONFLICT`. Store `queued` or the existing compatible queued status consistently, and map live statuses without allowing illegal fixture transitions.

- [ ] **Step 5: Run orchestration regression**

```bash
pnpm run test:orchestration
```

Expected: all existing fixture tests pass, including zero real Lovart calls.

- [ ] **Step 6: Commit**

```bash
git add src/domain/source-policy.js src/domain/workbench-service.js test/source-policy.test.mjs test/workbench-service.test.mjs
git commit -m "feat: add isolated live IMVIA job evidence"
```

### Task 5: Implement the shared generation orchestrator

**Files:**
- Create: `src/lovart/generation-orchestrator.js`
- Modify: `src/lovart/generation-service.js`
- Create: `test/lovart-generation-orchestrator.test.mjs`
- Modify: `test/lovart-generation.test.mjs`

**Interfaces:**
- `createGenerationOrchestrator({ projectContextService, workbenchService, generationService, idFactory, now })` returns:
  - `submit({ prompt, project_locator?, thread_id?, attachments?, mode?, prefer_models?, include_tools?, activation, idempotency_key }) -> { job, result? }`;
  - `get({ job_id }) -> { job, artifacts }`;
  - `confirm({ job_id, attempt, cost_fingerprint, decision_id }) -> { job, result }`.

- [ ] **Step 1: Write failing fake-Lovart orchestration tests**

Cover these exact flows:

1. no active project creates one once, creates a job snapshot with that ID, submits one prompt, and imports one result;
2. an explicit project is validated and used without changing the active project unless selection was requested;
3. a pending cost response updates the job to `awaiting_cost_confirmation` and does not call confirm;
4. explicit confirmation calls the upstream confirm exactly once and imports the result;
5. a second submit with the same idempotency key returns the original job without a second send; and
6. a stored thread resumes polling after a simulated restart without a second submit.

- [ ] **Step 2: Run the new suite to verify RED**

```bash
node --test test/lovart-generation-orchestrator.test.mjs
```

Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement project resolution and immutable job creation**

Resolve the project before direct job creation, freeze the prompt and generation settings, record `activation`, and use the job idempotency key as the side-effect boundary.

- [ ] **Step 4: Implement upload, submit, poll, cost pause, and import mapping**

Use the existing generation service for authenticated transport. Persist a receipt before any potentially repeated side effect. Map upstream errors to stable redacted codes. Never rewrite a prepared prompt or silently change provider/model.

- [ ] **Step 5: Implement confirmation binding**

Require the current job ID, attempt, cost fingerprint, and claimed decision. Reject stale, declined, consumed, or mismatched decisions before calling Lovart.

- [ ] **Step 6: Run the focused live adapter suite**

```bash
node --test test/lovart-generation-orchestrator.test.mjs test/lovart-generation.test.mjs test/fake-lovart-adapter.test.mjs
```

Expected: PASS with fake adapters only and zero live requests.

- [ ] **Step 7: Commit**

```bash
git add src/lovart/generation-orchestrator.js src/lovart/generation-service.js test/lovart-generation-orchestrator.test.mjs test/lovart-generation.test.mjs
git commit -m "feat: unify Lovart generation execution"
```

### Task 6: Add activation-aware MCP tools and skill routing contract

**Files:**
- Modify: `src/index.js`
- Modify: `skills/imvia-studio/SKILL.md`
- Modify: `test/skill-contract.test.mjs`
- Modify: `test/mcp-lovart-connection.test.mjs`
- Modify: `test/mcp-health.test.mjs` only if the approved inventory changes.

**Interfaces:**
- `activationSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("codex_explicit") }).strict(),
  z.object({ source: z.literal("codex_context_continuation"), parent_job_id: z.string().min(1).optional(), artifact_id: z.string().min(1).optional() }).strict(),
]).superRefine((value, context) => {
  if (value.source === "codex_context_continuation" && !value.parent_job_id && !value.artifact_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context continuation requires parent_job_id or artifact_id" });
  }
})`.
- `imvia_generate` calls `orchestrator.submit` and returns `{ job, result? }`.
- `imvia_get_generation` reads redacted local state.
- `imvia_confirm_generation` calls `orchestrator.confirm` with job/attempt/fingerprint/decision.
- project tools expose only normalized IDs, names, and canvas links.

- [ ] **Step 1: Add failing MCP schema and skill tests**

Assert that generic image requests are not described as IMVIA triggers, explicit plugin/Lovart wording is required, continuation requires a parent job or artifact, and no skill text permits automatic fallback or automatic confirmation. Assert all credential fields remain absent from every new schema.

- [ ] **Step 2: Run contract tests to verify RED**

```bash
node --test test/skill-contract.test.mjs test/mcp-lovart-connection.test.mjs
```

Expected: FAIL because the activation schema and new tools are absent.

- [ ] **Step 3: Wire the MCP tools**

Inject the orchestrator into `createServer`. Keep the existing health, probe, fixture, connection, and account tools unchanged. Route only explicit live activation to the orchestrator.

- [ ] **Step 4: Update the skill contract**

State: `@`/explicit Lovart or IMVIA activation opens a task-scoped Lovart context; clearly related follow-ups may continue it; new or ambiguous requests use Codex default capability; workbench actions are explicit; no provider fallback; no automatic confirmation.

- [ ] **Step 5: Run the complete MCP and skill suite**

```bash
pnpm run test:mcp
node --test test/skill-contract.test.mjs test/orchestration-policy.test.mjs test/fake-lovart-adapter.test.mjs
```

Expected: PASS with the existing 14-tool compatibility assertions updated only when the approved inventory requires it.

- [ ] **Step 6: Commit**

```bash
git add src/index.js skills/imvia-studio/SKILL.md test/skill-contract.test.mjs test/mcp-lovart-connection.test.mjs test/mcp-health.test.mjs
git commit -m "feat: enforce explicit Lovart activation routing"
```

### Task 7: Add project and generation HTTP adapters for the later workbench phases

**Files:**
- Modify: `src/http/server.js`
- Test: `test/http-server.test.mjs`

**Interfaces:**
- `GET /api/v1/lovart/projects` returns `{ active_lovart_project_id, projects }`.
- `POST /api/v1/lovart/projects/select` accepts `{ locator }` and returns the selected normalized project.
- `POST /api/v1/lovart/projects/create` accepts `{ name? }` and returns the created project.
- `POST /api/v1/generations` accepts the direct-generation payload and returns `{ job_id, status }` immediately.
- `GET /api/v1/jobs/:jobId` returns redacted job and artifacts.
- `POST /api/v1/jobs/:jobId/cost-decisions` accepts the exact current cost fingerprint and decision.

- [ ] **Step 1: Add failing HTTP tests**

Use injected fake project and orchestrator services. Assert project responses contain no credential fields, direct generation returns before polling completes, invalid locators return `400`, unknown jobs return `404`, and the server derives `workbench_action` without accepting an activation field from JSON.

- [ ] **Step 2: Run HTTP tests to verify RED**

```bash
node --test test/http-server.test.mjs
```

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement routes and error mapping**

Keep loopback-only binding, `no-store` response headers for state, the existing SSE route, and stable `DomainError` status mapping. Delegate all mutations to project and generation services.

- [ ] **Step 4: Run HTTP, security, and connection tests**

```bash
node --test test/http-server.test.mjs test/lovart-connection-security.test.mjs test/system-proxy.test.mjs
```

Expected: PASS with no credentials or user proxy address in response bodies.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.js test/http-server.test.mjs
git commit -m "feat: expose unified Lovart project and job routes"
```

### Task 8: Phase 1 verification and handoff

**Files:**
- Modify: phase report under `.superpowers/sdd/` only if the repository task ledger requires it; keep it uncommitted unless the task ledger explicitly requires staging.

**Interfaces:**
- Produces a green Phase 1 backend checkpoint consumed by the later result-editing plans.

- [ ] **Step 1: Run all Phase 1 focused tests**

```bash
node --test test/lovart-project-context.test.mjs test/lovart-project-service.test.mjs test/lovart-generation-orchestrator.test.mjs test/lovart-routing-policy.test.mjs
pnpm run test:orchestration
pnpm run test:mcp
```

Expected: all focused tests and existing orchestration/MCP tests pass.

- [ ] **Step 2: Run the full suite and build/validation checks**

```bash
pnpm test
pnpm run test:protection
pnpm run verify:protected-paths
```

Expected: no new failures beyond the already recorded external protected-path drift, with the before/after protected ledger unchanged.

- [ ] **Step 3: Inspect scope and secrets**

```bash
git status --short
git diff --name-only origin/codex/milestone-6-readonly-probe-implementation...HEAD
rg -n "AK|SK|secret|access_key|secret_key" src skills test --glob '!test/fixtures/**'
```

Expected: only approved IMVIA files changed; no raw credential value or credential field is emitted by new code or tests.

- [ ] **Step 4: Commit the Phase 1 verification report**

Use a separate commit only if the task ledger requires a tracked report. Otherwise leave the report ignored/untracked and report its path in the handoff.

- [ ] **Step 5: Create the Phase 2 plan**

After Phase 1 is green, write and review `docs/superpowers/plans/2026-08-21-lovart-result-follow-up-editing.md` before modifying result UI or iteration behavior.

## Execution checkpoints

- Checkpoint A: Tasks 1–3 green — project locator, registry, and fake project gateway.
- Checkpoint B: Tasks 4–5 green — live-safe job evidence and shared orchestrator.
- Checkpoint C: Tasks 6–7 green — explicit/contextual routing plus workbench HTTP adapters.
- Checkpoint D: Task 8 green — Phase 1 complete; only then start the separate result-editing plan.

Every checkpoint must leave the worktree in a reviewable state and must not touch the existing Lovart plugin.
