# Lovart Project Context, Unified Execution, and Result Editing Design

## Status

Approved in chat on 2026-08-21. This document is the product and technical design for the next IMVIA Studio implementation sequence. It does not authorize changes to the existing Lovart plugin.

## Goal

Turn the independent IMVIA Studio plugin into a complete Lovart creation surface with two equivalent entry points:

- a non-technical user can create and edit through the workbench, with each submit action handed to the active Codex task for processing; and
- a user can explicitly invoke IMVIA Studio or Lovart in a Codex conversation and use the same project, job, result, and revision history.

The design adds persistent Lovart project context, a shared execution service, result-side follow-up editing, and image annotation editing. It also preserves a strict provider boundary: Codex must not invoke Lovart for an ordinary image or video request unless the user explicitly activated the plugin or is clearly continuing an active Lovart task.

## Product decisions

1. IMVIA, rather than the existing Lovart plugin, owns the shared project and job state.
2. The workbench and Codex MCP tools call the same IMVIA orchestration service.
3. The workbench does not call Lovart directly. A workbench action creates an immutable local handoff, and the active Codex task receives and executes that exact job through MCP.
4. A missing Lovart project is created once on the first generation and then reused until the user explicitly changes it.
5. A submitted job snapshots its Lovart project ID. Later project changes cannot reroute that job.
6. A result edit always creates a new revision. It never overwrites the source artifact.
7. Image drawing is called annotation editing until a real Lovart mask capability has been verified. The UI must not claim precise inpainting before that capability exists.
8. The existing empty result panel remains visually unchanged while the selected result context has no artifacts. The full result workspace appears only after the first artifact is imported.

## Alternatives considered

### Call the existing Lovart plugin from the workbench

This would reuse project management quickly, but it would split state between two plugins, couple IMVIA to another local plugin, and violate the existing zero-modification and zero-reconnection boundary. It is rejected.

### Send a synthetic UI message from the workbench into Codex

Directly scripting the Codex chat UI depends on host browser APIs that are not part of the plugin contract and would fail when no Codex turn is active. It remains rejected. The supported equivalent is a durable local submission plus an MCP wait/receive tool owned by the active Codex task.

### Shared IMVIA execution service

Both entry points call one durable service. This keeps state, cost confirmation, retries, and result lineage consistent and is the selected approach.

## Hard boundaries

- Do not modify, overwrite, import, execute, configure, or reconnect the existing Lovart plugin.
- Keep the existing Lovart protected-path baseline and before/after fingerprint verification.
- Do not expose AK/SK through MCP arguments, HTTP requests from the browser, chat, JSON state, logs, test fixtures, or Git.
- Do not store a user-specific VPN or proxy address. Use the normal host networking path and the fixed official Lovart endpoint.
- Do not automatically confirm a cost.
- Do not silently fall back from Lovart to Codex ImageGen or from ImageGen to Lovart.
- Do not invoke both providers for one user request.
- Do not claim a precise mask-edit capability until a supported upstream contract is verified.

## Architecture

```text
Workbench action -- durable handoff --> Codex MCP receiver
                                      |
Codex MCP tool ------------------------+-- IMVIA GenerationOrchestrator -- LovartGateway -- Lovart
                                                            |
                                                            +-- ProjectContextService
                                                            +-- durable JobStore
                                                            +-- result and revision history
                                                            +-- redacted real-time events
```

### ProjectContextService

This component parses, validates, creates, lists, selects, and resolves Lovart projects. Project resolution has one order:

1. an explicit project for the current request;
2. the persisted active Lovart project; or
3. one automatically created project.

Automatic creation uses a durable idempotency claim so concurrent first jobs cannot create multiple default projects. An uncertain create response is resolved by validation before any retry.

### GenerationOrchestrator

This is the only component allowed to turn an IMVIA generation request into Lovart side effects. It freezes the request, resolves the project, uploads references, submits the Lovart chat, records the thread, polls status, pauses for cost confirmation, imports results, and publishes redacted events.

HTTP handlers and MCP handlers adapt their inputs into the same orchestration request. Neither handler implements a second execution path.

### LovartGateway

This component owns authenticated calls to the fixed `https://lgw.lovart.ai` base URL. It adds the independently implemented operations required by this design:

- project creation;
- project validation;
- reference upload;
- chat submission;
- thread status and result retrieval; and
- explicit cost confirmation.

Credentials are obtained from the existing IMVIA-owned secure credential service only for the operation that needs them.

### JobStore and executor claims

The existing durable store remains the source of truth. Each executable job has a single durable executor claim. Workbench and Codex submissions may race, but only one executor can advance a given job. Restart recovery uses stored receipts and thread IDs instead of blindly replaying side effects.

## Invocation isolation

### Activation sources

Every Lovart job records exactly one of these sources:

- `workbench_action`: the user clicked generate, continue editing, or annotation edit in the IMVIA workbench;
- `codex_explicit`: the current user request explicitly invokes the plugin, IMVIA Studio, or Lovart; or
- `codex_context_continuation`: the current request clearly continues an identified Lovart job or artifact.

`codex_context_continuation` requires a valid parent job or artifact ID in the same Lovart lineage. A bare boolean or a historical connection is not sufficient.

### Context rules

Explicit activation starts a task-scoped Lovart context. Natural follow-up instructions may continue that context when they refer to the current Lovart result, project, or edit chain. Context is not a permanent conversation-wide provider selection.

A new topic, a standalone request, an ambiguous request, or an explicit request for Codex ImageGen returns routing to Codex's default capability. Connection state, saved credentials, an active project, and prior Lovart use are never activation evidence by themselves.

The plugin skill contract must encode these rules. The MCP server records the declared activation source and validates lineage for continuation, but it does not persist a global `lovart_enabled` permission flag.

### Required routing outcomes

| User action | Provider outcome |
| --- | --- |
| “Generate a poster” without a provider | Codex default capability; zero Lovart calls |
| “Edit this image” without a provider or Lovart lineage | Codex default capability; zero Lovart calls |
| Explicitly invoke Lovart or IMVIA Studio | IMVIA/Lovart only |
| Clearly edit the current Lovart result | IMVIA/Lovart only |
| Click a workbench generation or edit action | IMVIA/Lovart only |
| Lovart fails | Report the failure; no ImageGen fallback |
| ImageGen fails | Report the failure; no Lovart fallback |

## Persisted model

The next state schema adds a Lovart project registry and active selection without replacing the existing local IMVIA project model.

### Lovart project

```text
lovart_project
- project_id
- name
- canvas_url
- source: auto_created | user_selected | codex_selected
- validated_at
- created_at
- last_used_at
```

State also stores `active_lovart_project_id`. A project locator accepts only a non-empty Lovart project ID or an official canvas URL of the form `https://www.lovart.ai/canvas?projectId=...`. The normalized project ID, not the original free-form string, is authoritative.

### Job additions

```text
job
- id
- lovart_project_id
- lovart_thread_id
- snapshot
- activation_source
- activation_parent_job_id
- parent_job_id
- source_artifact_id
- iteration_index
- edit_kind: null | text_instruction | visual_annotation
- annotation_artifact_id
- status
- attempt
- upload_receipts
- estimated_cost
- cost_decisions
- error
- created_at
- updated_at
```

The immutable snapshot contains the prompt, reference order, mode, model preference, generation settings, and selected Lovart project. Project selection is never read again to route an already submitted job.

### Edit lineage

A text edit stores the source artifact, parent job, instruction, and inherited Lovart thread. A visual annotation edit additionally stores an annotation artifact. The source image, annotation raster, editable stroke document, and generated result remain separate artifacts.

Lineage supports branches. The first UI presents a simple version list and labels a branch with “based on version N”; it does not require a complex tree visualization.

## Job state machine

```text
queued
  -> resolving_project
  -> uploading
  -> submitted
  -> generating
  -> importing
  -> succeeded
```

Additional transitions are:

```text
generating -> awaiting_cost_confirmation -> generating
any executable state -> failed | timeout | cancelled
importing -> partially_succeeded
```

Recovery rules are explicit:

- a stored Lovart thread ID resumes status polling and is never resubmitted;
- a stored upload receipt is reused;
- an uncertain project creation validates before retry;
- an uncertain generation submission must reconcile a stored request receipt before retry;
- a consumed cost decision cannot be reused; and
- a changed cost invalidates every previous decision for that attempt.

## MCP contract

The target MCP surface adds or changes these tools:

- `imvia_get_active_lovart_project`: reads the local active project without contacting Lovart;
- `imvia_list_lovart_projects`: reads the local registry;
- `imvia_set_lovart_project`: accepts an official project locator, validates it, records it, and makes it active;
- `imvia_create_lovart_project`: explicitly creates and selects a project;
- `imvia_generate`: submits through the orchestrator and returns a terminal result, timeout, or pending cost confirmation;
- `imvia_get_generation`: reads a redacted job and result state;
- `imvia_confirm_generation`: confirms a job only with the current cost fingerprint and attempt;
- `imvia_edit_result`: creates and executes a child revision from a managed artifact.

Codex-side `imvia_generate` and `imvia_edit_result` require an activation object. Explicit activation records `codex_explicit`; continuation records `codex_context_continuation` and must identify its parent job or artifact. Project mutation tools also require an explicit Codex activation because they can contact Lovart or change persistent routing.

The existing state, draft, preparation, iteration, account, probe, and health operations remain available unless a later implementation plan explicitly deprecates one with compatibility tests.

## Workbench HTTP contract

The workbench uses HTTP adapters over the same domain services:

- `GET /api/v1/lovart/projects`
- `POST /api/v1/lovart/projects/select`
- `POST /api/v1/lovart/projects/create`
- `POST /api/v1/generations`
- `GET /api/v1/jobs/:jobId`
- `POST /api/v1/jobs/:jobId/cost-decisions`
- `POST /api/v1/artifacts/:artifactId/iterations`
- `POST /api/v1/artifacts/:artifactId/annotations`
- `GET /api/v1/events`

The browser receives a job ID immediately and follows redacted server-sent events. The browser never receives credentials or signs Lovart requests. The server derives `workbench_action` from its dedicated loopback-only workbench route rather than trusting a browser-supplied activation value. The implementation plan must separately preserve the existing loopback bind and request-origin protections.

## Workbench interaction

### Current Lovart project

A compact Lovart project row appears below the image/video tabs and above model selection. It shows the active project name and connection state, with actions to open or change the project.

When no project is selected, it states that the first generation will create one automatically and offers “select existing” and “create now”. The selection dialog supports recent projects, an official Lovart project link or ID, and explicit creation. Invalid input leaves the prior active project unchanged.

### Generation action

The primary action becomes “Send to IMVIA to generate”. Its status text may show project creation, upload, submission, generation, cost confirmation, or result import. A stable idempotency key prevents double-click duplication.

The action is delivered to the already-active Codex task; the user does not have to copy the form, paste a prompt, or type a manual “continue” message. A result created from Codex appears in the same workbench state and history.

### Empty and populated result states

The existing empty result layout is preserved while the selected result context has zero imported artifacts. It keeps the current icon, copy, spacing, and overall composition. Progress, failure, timeout, or pending-cost copy may update inside that empty shell, but result controls, the edit composer, and version history remain hidden.

As soon as the first artifact is imported, the panel changes to the populated result workspace. Additional artifacts appear incrementally; the UI does not wait for the entire batch.

### Populated result workspace

The workspace shows current project and job status, result cards, download and preview actions, a Lovart canvas link, version provenance, and a follow-up composer. Image cards also expose annotation editing. Video cards support text follow-up but not drawing.

When several artifacts exist, the first is selected by default. An explicit user reference to another result changes the selection. A follow-up always identifies one source artifact before submission.

### Text follow-up

The composer shows the selected result and accepts a required instruction. Submission creates a child job, retains the project, and reuses the direct parent's Lovart thread when valid. The original artifact remains unchanged.

### Image annotation editor

The editor opens in a large modal with an immutable source image and a separate translucent annotation canvas. It supports brush, eraser, brush size, undo, redo, clear, zoom, and pan. The user must provide an instruction before sending an annotation.

Sending packages the source artifact, exported annotation image, editable stroke document, instruction, parent job, project, and valid thread context. An instruction with no strokes becomes a normal image follow-up. Strokes with no instruction remain unsent and prompt the user to add an instruction. Closing with unsent changes asks before discarding them.

Until Lovart exposes and IMVIA verifies a formal mask parameter, the original and annotation are sent as references with an instruction that explains the annotation. Product copy calls this “annotation editing”, not “mask” or “precise inpainting”.

### Cost confirmation

When a job has no artifact and awaits cost confirmation, the confirmation appears inside the existing empty result shell. It shows the amount and unit and offers confirm or decline. The same decision may be presented in Codex, but a decision can be consumed exactly once across both surfaces.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| Invalid project locator | Keep the existing project and show a correction message |
| Project creation failure | Do not submit generation; retain the job for retry |
| Authentication failure | Show a redacted reconnect action; do not reveal credential details |
| Network unavailable | Retain durable state and resume only safe operations |
| Partial upload failure | Identify failed references and do not submit an incomplete request silently |
| Changed estimated cost | Invalidate old decisions and display the new cost |
| Generation timeout | Retain the thread for later status reconciliation |
| Partial result import | Show successful artifacts and identify missing imports |
| Content rejection | Show the stable Lovart error and do not change provider or model automatically |
| Local import failure | Retain remote result metadata and offer a safe re-import |

Automatic retries are limited to idempotent reads and reconciled operations. Project creation, generation submission, and cost confirmation are never blindly replayed.

## Security requirements

- Keep credential operations inside the existing IMVIA secure credential boundary.
- Keep the Lovart base URL fixed; reject redirects and preserve TLS verification.
- Accept only official Lovart project URLs.
- Accept local references only through the IMVIA managed-file policy.
- Validate file extension, MIME type, real file signature, size, and image dimensions.
- Bound annotation canvas dimensions, stroke count, request body size, and stored document size.
- Redact upstream bodies, signed headers, project validation internals, and credential-related errors from user-visible responses.
- Keep the existing Lovart plugin protected-path manifest, baseline, and automated fingerprint check.

## Migration

Migration is non-destructive and versioned:

1. copy the original state to a private backup in the IMVIA data directory;
2. import any existing `projects[].lovart_project_id` into the new registry;
3. preserve every draft, job, artifact, account status, audit event, and iteration relation;
4. populate new fields with explicit legacy defaults;
5. validate the complete migrated document before atomic replacement; and
6. leave the original state active if any validation or replacement step fails.

No migration reads or writes the existing Lovart plugin state.

## Test strategy

### Unit and state-machine tests

- project locator normalization and official-domain rejection;
- explicit, active, and auto-create resolution order;
- concurrent first submission creates exactly one project;
- project switching does not mutate submitted snapshots;
- every legal and illegal job transition;
- restart reconciliation without duplicate submission;
- one-use cost decisions and stale-fingerprint rejection;
- text and annotation lineage without source mutation; and
- legacy-state migration and rollback behavior.

### Contract and integration tests

- strict MCP schemas and stable redacted results;
- HTTP route validation and server-derived workbench activation;
- workbench and MCP submissions converge on one orchestrator;
- fake Keychain, fake transport, and fake Lovart only by default;
- partial upload, pending cost, timeout, partial result, and import recovery; and
- no test invokes the existing Lovart plugin.

### Workbench tests

- current empty result view remains unchanged with zero artifacts;
- progress and cost confirmation render inside the empty shell;
- the first imported artifact switches to the populated workspace;
- later artifacts appear incrementally;
- project selection, invalid selection, and auto-created project display;
- text follow-up selects and preserves the correct artifact;
- annotation drawing, erasing, undo, redo, clear, close confirmation, and submission packaging; and
- video results never show drawing controls.

### Provider-isolation tests

- a generic generation or edit request has zero IMVIA/Lovart tool calls;
- explicit Lovart activation has zero ImageGen calls;
- valid Lovart context continuation is allowed;
- an unrelated new topic does not inherit Lovart activation;
- connection, credentials, project selection, and prior history alone never activate Lovart; and
- neither provider is used as a silent fallback.

### Security and regression tests

- exact secret scan and credential-field rejection;
- fixed-host, redirect, upload-policy, and annotation-size tests;
- existing orchestration, probe, workbench, connection, and plugin-validation suites;
- prototype build and independent plugin build;
- protected Lovart path status and fingerprint before and after; and
- a clean-worktree and committed-file scope check.

## Acceptance criteria

1. With no project selected, the first real generation creates exactly one Lovart project and saves it as active.
2. Later workbench and explicit Codex Lovart requests reuse that project until the user changes it.
3. An explicit project change affects future jobs only.
4. A workbench click hands the exact form summary to the active Codex task and can complete a Lovart job without a manual “continue” message.
5. Generic Codex image requests cause zero Lovart calls.
6. Explicit or valid contextual Lovart requests cause zero ImageGen calls.
7. The empty result page remains in its current visual state until the first artifact exists.
8. Text follow-up creates a child revision in the same project and never overwrites its source.
9. Image annotation sends source, annotation, and instruction while remaining labeled annotation editing.
10. Restart, duplicate clicks, and concurrent entry points do not duplicate projects, generation, upload, or cost consumption.
11. AK/SK never appear in browser, MCP, state, logs, tests, diffs, or reports.
12. Existing Lovart protected paths have identical before/after fingerprints and are never touched.

## Delivery sequence

The implementation plan must preserve this order:

1. project context, invocation isolation, shared orchestrator, state migration, and fake-service coverage;
2. workbench one-click execution, durable events, and empty-to-populated result transition;
3. real result cards, text follow-up, live thread lineage, and version history;
4. image annotation editor and reference-based annotation submission;
5. full security, migration, restart, provider-isolation, regression, build, and protected-path verification; and
6. only after explicit user authorization, one real end-to-end project creation, generation, and follow-up verification without exposing credentials or automatically confirming cost.

Each numbered delivery slice is an independent checkpoint. Its focused tests, security checks, compatibility checks, and protected-path evidence must pass before work begins on the next slice.

## Out of scope

- modification of the existing Lovart plugin;
- browser automation of the Lovart website;
- synthetic message injection into the Codex chat UI;
- automatic or implicit Lovart activation for generic media requests;
- automatic provider fallback;
- automatic cost confirmation;
- a complex graphical version tree in the first UI;
- video drawing or timeline-mask editing; and
- a claim of formal mask or precise inpainting support before upstream verification.
