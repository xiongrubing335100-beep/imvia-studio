import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { createCostFingerprint } from "../src/domain/cost-confirmation.js";

async function createTestService(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-workbench-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return { dataDirectory, service: createWorkbenchService({ dataDirectory }) };
}

test("initializes and reloads a private local project and draft", async (context) => {
  const { dataDirectory, service } = await createTestService(context);
  const initial = await service.getState();

  assert.equal(initial.schema_version, "2");
  assert.equal(initial.active_lovart_project_id, null);
  assert.deepEqual(initial.lovart_projects, []);
  assert.equal(initial.projects.length, 1);
  assert.equal(initial.draft.revision, 0);
  assert.equal(initial.draft.mode, "video");
  assert.equal(initial.draft.prompt.text, "");

  const reloaded = await createWorkbenchService({ dataDirectory }).getState();
  assert.equal(reloaded.project.id, initial.project.id);
  assert.equal(reloaded.draft.id, initial.draft.id);
  assert.equal(reloaded.draft.revision, 0);
});

test("renames the active local project and persists the name", async (context) => {
  const { dataDirectory, service } = await createTestService(context);
  const initial = await service.getState();

  const renamed = await service.renameProject({
    project_id: initial.project.id,
    name: "秋日人物海报",
  });

  assert.equal(renamed.project.name, "秋日人物海报");
  assert.equal((await createWorkbenchService({ dataDirectory }).getState()).project.name, "秋日人物海报");
  await assert.rejects(
    () => service.renameProject({ project_id: initial.project.id, name: "   " }),
    (error) => error.code === "VALIDATION_FAILED",
  );
});

test("persists the active Lovart project separately from the local project", async (context) => {
  const { service } = await createTestService(context);
  const selected = await service.setLovartProject({
    project_id: "project-1",
    name: "人物海报",
    canvas_url: "https://www.lovart.ai/canvas?projectId=project-1",
    source: "user_selected",
  });

  assert.equal(selected.active_project.project_id, "project-1");
  assert.equal(selected.projects.length, 1);
  const listed = await service.getLovartProjects();
  assert.equal(listed.active_lovart_project_id, "project-1");
  assert.equal(listed.projects[0].name, "人物海报");
  assert.equal((await service.getState()).project.lovart_project_id, "project-1");

  const recorded = await service.recordLovartProject({
    project_id: "project-2",
    name: "视频项目",
    canvas_url: "https://www.lovart.ai/canvas?projectId=project-2",
    source: "auto_created",
  });
  assert.equal(recorded.project.project_id, "project-2");
  assert.equal((await service.getLovartProjects()).active_lovart_project_id, "project-1");
});

test("migrates legacy Lovart project ids without changing the local project", async (context) => {
  const { dataDirectory, service } = await createTestService(context);
  const initial = await service.getState();
  const statePath = path.join(dataDirectory, "state.json");
  const legacy = JSON.parse(await readFile(statePath, "utf8"));
  legacy.schema_version = "1";
  delete legacy.lovart_projects;
  delete legacy.active_lovart_project_id;
  legacy.projects[0].lovart_project_id = "legacy-project";
  await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

  const reloaded = createWorkbenchService({ dataDirectory });
  const migrated = await reloaded.getState();
  assert.equal(migrated.schema_version, "2");
  assert.equal(migrated.project.id, initial.project.id);
  assert.equal(migrated.active_lovart_project_id, "legacy-project");
  assert.deepEqual(migrated.lovart_projects.map(({ project_id, canvas_url }) => ({ project_id, canvas_url })), [{
    project_id: "legacy-project",
    canvas_url: "https://www.lovart.ai/canvas?projectId=legacy-project",
  }]);
  const backupNames = (await readdir(dataDirectory)).filter((entry) => entry.includes("backup-v1-to-v2"));
  assert.equal(backupNames.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(dataDirectory, backupNames[0]), "utf8")).schema_version, "1");
});

test("migrates the misleading queued handoff message to the session-bridge wording", async (context) => {
  const { dataDirectory, service } = await createTestService(context);
  const submitted = await service.createWorkbenchSubmission({
    idempotency_key: "bridge-message-1",
    snapshot: { mode: "image", prompt: { text: "Bridge message", tokens: [] }, attachments: [], settings: {} },
  });
  const statePath = path.join(dataDirectory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.jobs.find((job) => job.id === submitted.job.id).status_message = "已发送给 Codex，等待处理。";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  const reloaded = await createWorkbenchService({ dataDirectory }).getState({ include: ["jobs"] });
  assert.equal(reloaded.jobs[0].status_message, "任务已保存，等待会话桥发送到当前 Codex 会话。");
});

test("creates an immutable direct Lovart job snapshot with live activation evidence", async (context) => {
  const { service } = await createTestService(context);
  await service.setLovartProject({ project_id: "project-1", name: "项目一", source: "user_selected" });
  const snapshot = { mode: "image", prompt: { text: "A cinematic portrait", tokens: [] }, settings: { ratio: "16:9" } };
  const prepared = await service.createDirectGenerationJob({
    snapshot,
    lovart_project_id: "project-1",
    activation_source: { source: "codex_explicit" },
    idempotency_key: "direct-1",
  });
  assert.equal(prepared.job.status, "queued_for_agent");
  assert.equal(prepared.job.lovart_project_id, "project-1");
  assert.deepEqual(prepared.job.snapshot.activation, { source: "codex_explicit" });
  const retry = await service.createDirectGenerationJob({
    snapshot,
    lovart_project_id: "project-1",
    activation_source: { source: "codex_explicit" },
    idempotency_key: "direct-1",
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.job.id, prepared.job.id);

  await service.setLovartProject({ project_id: "project-2", source: "user_selected" });
  const state = await service.getState({ include: ["jobs"] });
  assert.equal(state.jobs[0].lovart_project_id, "project-1");
  assert.equal(state.jobs[0].snapshot.lovart_project_id, "project-1");
});

test("live job transitions accept only named live evidence and exact attempts", async (context) => {
  const { service } = await createTestService(context);
  const { job } = await service.createDirectGenerationJob({
    snapshot: { mode: "image", prompt: { text: "A tree", tokens: [] } },
    lovart_project_id: "project-1",
    activation_source: { source: "workbench" },
    idempotency_key: "direct-live-1",
  });
  await assert.rejects(
    () => service.updateLiveJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "fixture:lovart_submit" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  const updated = await service.updateLiveJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "imvia:lovart_upload" });
  assert.equal(updated.job.status, "uploading");
  await assert.rejects(
    () => service.updateLiveJob({ job_id: job.id, expected_status: "uploading", next_status: "submitted", attempt: 2, source: "imvia:lovart_submit" }),
    (error) => error.code === "STATUS_CONFLICT",
  );
  const submitted = await service.updateLiveJob({ job_id: job.id, expected_status: "uploading", next_status: "submitted", attempt: 1, source: "imvia:lovart_submit" });
  assert.equal(submitted.job.status, "submitted");
});

test("applies a field-level patch without overwriting unrelated draft values", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();

  const patched = await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "codex",
    reason: "Set the requested model and duration.",
    patch: {
      model: "Seedance 2.5",
      "settings.duration_seconds": 10,
    },
  });

  assert.deepEqual(patched.changed_fields, ["model", "settings.duration_seconds"]);
  assert.equal(patched.draft.revision, 1);
  assert.equal(patched.draft.model, "Seedance 2.5");
  assert.equal(patched.draft.settings.duration_seconds, 10);
  assert.equal(patched.draft.prompt.text, "");
});

test("rejects a stale revision without applying any part of its patch", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "codex",
    reason: "First edit.",
    patch: { model: "Seedance 2.5" },
  });

  await assert.rejects(
    () => service.patchWorkbench({
      draft_id: initial.draft.id,
      base_revision: 0,
      actor: "codex",
      reason: "Stale edit.",
      patch: { "prompt.text": "This must not be saved." },
    }),
    (error) => error.code === "REVISION_CONFLICT",
  );

  const current = await service.getState();
  assert.equal(current.draft.revision, 1);
  assert.equal(current.draft.model, "Seedance 2.5");
  assert.equal(current.draft.prompt.text, "");
});

test("creates an immutable task snapshot and returns it for an idempotent retry", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "codex",
    reason: "Add an approved prompt.",
    patch: { "prompt.text": "A cinematic rainy street." },
  });

  const prepared = await service.prepareGeneration({
    draft_id: initial.draft.id,
    expected_revision: 1,
    idempotency_key: "session-001",
  });
  assert.equal(prepared.job.status, "queued_for_agent");
  assert.equal(prepared.job.snapshot.prompt.text, "A cinematic rainy street.");

  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 1,
    actor: "user",
    reason: "Update the draft after preparation.",
    patch: { "prompt.text": "A new draft prompt." },
  });
  const retry = await service.prepareGeneration({
    draft_id: initial.draft.id,
    expected_revision: 1,
    idempotency_key: "session-001",
  });
  const state = await service.getState({ include: ["jobs"] });

  assert.equal(retry.job.id, prepared.job.id);
  assert.equal(retry.job.snapshot.prompt.text, "A cinematic rainy street.");
  assert.equal(state.jobs.length, 1);
});

test("stores a workbench button submission as an immutable Codex handoff without executing it", async (context) => {
  const { service } = await createTestService(context);
  await service.setLovartProject({ project_id: "project-from-form", source: "user_selected" });
  const snapshot = {
    mode: "image",
    model: "Seedream 4.0",
    prompt: { text: "  Use the two references.\n", tokens: [] },
    attachments: ["imvia-workbench:/assets/person-reference.png"],
    settings: { ratio: "3:4", resolution: "2K", count: 1 },
  };

  const submitted = await service.createWorkbenchSubmission({ snapshot, idempotency_key: "browser-submit-1" });
  assert.equal(submitted.job.status, "queued_for_agent");
  assert.equal(submitted.job.direct_generation, false);
  assert.equal(submitted.job.activation.source, "workbench_action");
  assert.equal(submitted.job.lovart_project_id, "project-from-form");
  assert.equal(submitted.job.snapshot.lovart_project_id, "project-from-form");

  snapshot.prompt.text = "mutated after submit";
  await service.setLovartProject({ project_id: "project-changed-later", source: "user_selected" });
  const [stored] = await service.listPendingJobs();
  assert.equal(stored.snapshot.prompt.text, "  Use the two references.\n");
  assert.equal(stored.lovart_project_id, "project-from-form");
});

test("defaults an image workbench submission to an unconstrained Auto count", async (context) => {
  const { service } = await createTestService(context);

  const submitted = await service.createWorkbenchSubmission({
    snapshot: {
      mode: "image",
      model: "Image 2",
      prompt: { text: "Split this image into every useful component.", tokens: [] },
      attachments: [],
      settings: { ratio: "3:4", resolution: "2K" },
    },
    idempotency_key: "browser-image-auto-count",
  });

  assert.equal(submitted.job.snapshot.settings.count_mode, "auto");
  assert.equal(submitted.job.snapshot.settings.count, null);
});

test("normalizes a legacy numeric image count as fixed", async (context) => {
  const { service } = await createTestService(context);

  const submitted = await service.createWorkbenchSubmission({
    snapshot: {
      mode: "image",
      model: "Image 2",
      prompt: { text: "Generate four variations.", tokens: [] },
      attachments: [],
      settings: { ratio: "3:4", resolution: "2K", count: 4 },
    },
    idempotency_key: "browser-image-legacy-fixed-count",
  });

  assert.equal(submitted.job.snapshot.settings.count_mode, "fixed");
  assert.equal(submitted.job.snapshot.settings.count, 4);
});

test("rejects an Auto image count that also forces a number", async (context) => {
  const { service } = await createTestService(context);

  await assert.rejects(
    () => service.createWorkbenchSubmission({
      snapshot: {
        mode: "image",
        model: "Image 2",
        prompt: { text: "Do not truncate a split-image task.", tokens: [] },
        attachments: [],
        settings: { count_mode: "auto", count: 2 },
      },
      idempotency_key: "browser-image-invalid-auto-count",
    }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "snapshot.settings.count",
  );
});

test("normalizes the rendered Image 2 icon text before freezing a workbench submission", async (context) => {
  const { service } = await createTestService(context);
  const submitted = await service.createWorkbenchSubmission({
    snapshot: {
      mode: "image",
      model: "I2Image 2",
      prompt: { text: "Use the selected image model.", tokens: [] },
      attachments: [],
      settings: { ratio: "3:4", resolution: "2K", count: 1 },
    },
    idempotency_key: "browser-image-2-label",
  });

  assert.equal(submitted.job.snapshot.model, "Image 2");
});

test("rejects a workbench model that cannot be mapped to a local capability", async (context) => {
  const { service } = await createTestService(context);

  await assert.rejects(
    () => service.createWorkbenchSubmission({
      snapshot: {
        mode: "image",
        model: "Unknown Browser Model",
        prompt: { text: "Do not dispatch an unknown model.", tokens: [] },
        attachments: [],
        settings: {},
      },
      idempotency_key: "browser-unknown-model",
    }),
    (error) => error.code === "MODEL_CAPABILITY_UNKNOWN" && error.details.field === "snapshot.model",
  );
});

test("rejects a workbench model whose capability belongs to the other media mode", async (context) => {
  const { service } = await createTestService(context);

  await assert.rejects(
    () => service.createWorkbenchSubmission({
      snapshot: {
        mode: "video",
        model: "Image 2",
        prompt: { text: "Do not send an image model as video.", tokens: [] },
        attachments: [],
        settings: {},
      },
      idempotency_key: "browser-model-mode-mismatch",
    }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "snapshot.model",
  );
});

test("rejects an unsupported patch path without changing the draft", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();

  await assert.rejects(
    () => service.patchWorkbench({
      draft_id: initial.draft.id,
      base_revision: 0,
      actor: "codex",
      reason: "Attempt to set an unknown field.",
      patch: { "settings.unknown": true },
    }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  const current = await service.getState();
  assert.equal(current.draft.revision, 0);
  assert.equal(current.draft.settings.unknown, undefined);
});

test("publishes a draft.updated event after a successful domain patch", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  const events = [];
  const unsubscribe = service.subscribe((event) => events.push(event));
  await service.patchWorkbench({ draft_id: initial.draft.id, base_revision: 0, actor: "codex", reason: "Publish an event.", patch: { model: "Seedance 2.5" } });
  unsubscribe();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "draft.updated");
  assert.equal(events[0].data.revision, 1);
  assert.deepEqual(events[0].data.changed_fields, ["model"]);
});

test("rejects unknown models and duration combinations outside the local capability table", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Prepare an incompatible model combination.",
    patch: {
      model: "Kling 3.0",
      "prompt.text": "A local capability test.",
      "settings.duration_seconds": 30,
    },
  });

  await assert.rejects(
    () => service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "invalid-duration" }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "settings.duration_seconds",
  );

  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 1,
    actor: "user",
    reason: "Select a model without known capabilities.",
    patch: { model: "Unknown Fixture Model", "settings.duration_seconds": 10 },
  });
  await assert.rejects(
    () => service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 2, idempotency_key: "unknown-model" }),
    (error) => error.code === "MODEL_CAPABILITY_UNKNOWN" && error.details.field === "model",
  );
});

test("allows Seedance 2.5 at 30 seconds and freezes validation in its task snapshot", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Use the model-specific 30 second option.",
    patch: {
      model: "Seedance 2.5",
      "prompt.text": "A thirty second fixture clip.",
      "settings.duration_seconds": 30,
    },
  });

  const prepared = await service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "seedance-30" });
  assert.equal(prepared.job.snapshot.model, "Seedance 2.5");
  assert.equal(prepared.job.snapshot.settings.duration_seconds, 30);
  assert.deepEqual(prepared.validation, { warnings: [] });
});

test("allows image mode to clear a stale video duration before preparation", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Switch from video to image without carrying a stale duration.",
    patch: { mode: "image", model: "Seedream 4.0", "prompt.text": "A local image task.", "settings.duration_seconds": null },
  });

  const prepared = await service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "image-no-duration" });
  assert.equal(prepared.job.snapshot.mode, "image");
  assert.equal(prepared.job.snapshot.settings.duration_seconds, null);
});

test("rejects a prompt token whose stable reference is absent", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Exercise a broken stable reference.",
    patch: {
      model: "Seedance 2.5",
      "prompt.text": "Animate @图片1 in the rain.",
      "prompt.tokens": [{ reference_id: "missing-reference", display: "图片1" }],
      reference_ids: ["missing-reference"],
      "settings.duration_seconds": 10,
    },
  });

  await assert.rejects(
    () => service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "broken-reference" }),
    (error) => error.code === "REFERENCE_BROKEN" && error.details.reference_id === "missing-reference",
  );
});

test("enforces ordered job transitions and preserves sourced cost data", async (context) => {
  const { service } = await createTestService(context);
  const initial = await service.getState();
  await service.patchWorkbench({ draft_id: initial.draft.id, base_revision: 0, actor: "user", reason: "Create a task.", patch: { model: "Seedance 2.5", "prompt.text": "State machine fixture.", "settings.duration_seconds": 10 } });
  const { job } = await service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "state-machine" });

  await assert.rejects(
    () => service.updateJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "generating", attempt: 1, source: "fixture:out-of-order" }),
    (error) => error.code === "STATUS_CONFLICT" && error.details.current_status === "queued_for_agent",
  );

  await service.updateJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "fixture:upload" });
  await service.updateJob({ job_id: job.id, expected_status: "uploading", next_status: "submitted", attempt: 1, source: "fixture:submit", lovart_thread_id: "fixture-thread" });
  const updated = await service.updateJob({
    job_id: job.id,
    expected_status: "submitted",
    next_status: "awaiting_cost_confirmation",
    attempt: 1,
    source: "fixture:cost",
    source_checked_at: "2026-08-20T00:00:00.000Z",
    estimated_cost: { amount: 135, unit: "credits" },
  });

  assert.equal(updated.job.status, "awaiting_cost_confirmation");
  assert.deepEqual(updated.job.estimated_cost, { amount: 135, unit: "credits", source: "fixture:cost", checked_at: "2026-08-20T00:00:00.000Z" });
  assert.equal(updated.job.lovart_thread_id, "fixture-thread");
});

test("runs the fake Lovart lifecycle and imports its local result idempotently", async (context) => {
  const { dataDirectory, service } = await createTestService(context);
  const fixture = JSON.parse(await readFile(new URL("./fixtures/lovart-success.json", import.meta.url), "utf8"));
  const resultDirectory = path.join(dataDirectory, "results");
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(path.join(resultDirectory, "rainy-street.mp4"), "fixture-video-bytes");
  const initial = await service.getState();
  await service.patchWorkbench({ draft_id: initial.draft.id, base_revision: 0, actor: "user", reason: "Create the fixture task.", patch: { model: "Seedance 2.5", "prompt.text": "Fixture lifecycle.", "settings.duration_seconds": 10 } });
  const { job } = await service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "fixture-lifecycle" });

  for (const transition of fixture.transitions) {
    let confirmation = {};
    if (transition.expected_status === "awaiting_cost_confirmation" && transition.next_status === "generating") {
      const fingerprint = createCostFingerprint({ job_id: job.id, attempt: 1, amount: 135, unit: "credits", checked_at: "2026-08-20T00:00:00.000Z", source: "fixture:lovart_generate" });
      const accepted = await service.recordCostDecision({ job_id: job.id, attempt: 1, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: `fixture-accept:${job.id}` });
      await service.claimCostDecision({ decision_id: accepted.decision.decision_id, job_id: job.id, attempt: 1, cost_fingerprint: fingerprint });
      confirmation = { cost_decision_id: accepted.decision.decision_id, confirmation_evidence: { kind: "confirmation_accepted" } };
    }
    await service.updateJob({ job_id: job.id, attempt: 1, ...transition, ...confirmation });
  }
  const artifacts = fixture.artifacts.map((artifact) => ({ ...artifact, local_path: path.join(dataDirectory, artifact.local_path) }));
  const imported = await service.importResult({ job_id: job.id, artifacts, idempotency_key: "fixture-result-v1" });
  const retry = await service.importResult({ job_id: job.id, artifacts, idempotency_key: "fixture-result-v1" });
  const state = await service.getState({ include: ["jobs", "artifacts"] });

  assert.equal(imported.job.status, "succeeded");
  assert.equal(imported.results[0].ok, true);
  assert.equal(imported.results[0].artifact.source_artifact_id, "fixture-video-001");
  assert.equal(retry.idempotent, true);
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.jobs[0].status, "succeeded");
});
