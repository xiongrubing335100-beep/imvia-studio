import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCostFingerprint } from "../src/domain/cost-confirmation.js";
import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { createProjectContextService } from "../src/lovart/project-context-service.js";
import { createGenerationOrchestrator } from "../src/lovart/generation-orchestrator.js";

async function createHarness(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-orchestrator-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const workbenchService = createWorkbenchService({ dataDirectory });
  const calls = [];
  const resultFile = path.join(dataDirectory, "results", "fake.png");
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(resultFile, "fake-result", { mode: 0o600 });
  const workspaceAsset = path.join(dataDirectory, "assets", "sample.png");
  await mkdir(path.dirname(workspaceAsset), { recursive: true });
  await writeFile(workspaceAsset, "fake-asset", { mode: 0o600 });
  const generationService = {
    async createProject(input) { calls.push(["createProject", input]); return { project_id: "project-auto", project_name: input.project_name || "自动项目" }; },
    async validateProject(input) { calls.push(["validateProject", input]); return { valid: true, project_name: "外部项目" }; },
    async upload(input) { calls.push(["upload", input]); return { url: `https://cdn.lovart.ai/${path.basename(input.file_path)}` }; },
    async generate(input) {
      calls.push(["generate", input]);
      if (input.prompt.includes("pending")) return { final_status: "pending_confirmation", thread_id: "thread-pending", project_id: input.project_id, pending_confirmation: { amount: 12, unit: "credits" }, items: [] };
      return { final_status: "done", thread_id: "thread-done", project_id: input.project_id, items: [{ artifacts: [{ type: "image", content: "https://cdn.lovart.ai/result.png", artifact_id: "artifact-source-1" }] }] };
    },
    async resume(input) { calls.push(["resume", input]); return { final_status: "done", thread_id: input.thread_id, project_id: input.project_id, items: [{ artifacts: [{ type: "image", content: "https://cdn.lovart.ai/result.png" }] }] }; },
    async confirm(input) { calls.push(["confirm", input]); return { final_status: "done", thread_id: input.thread_id, project_id: "project-auto", items: [{ artifacts: [{ type: "image", content: "https://cdn.lovart.ai/result.png" }] }] }; },
  };
  const projectContextService = createProjectContextService({ workbenchService, generationService });
  const artifactTransfer = {
    async prepareUpload(input) { calls.push(["prepareUpload", input]); return { file_path: input.local_path }; },
    async prepareWorkspaceAsset(input) { calls.push(["prepareWorkspaceAsset", input]); return { file_path: workspaceAsset }; },
    async downloadResults(input) { calls.push(["downloadResults", input]); return { artifacts: [{ kind: "image", local_path: resultFile, source_url: "https://cdn.lovart.ai/result.png", source_artifact_id: "artifact-source-1" }] }; },
  };
  return { calls, dataDirectory, workbenchService, projectContextService, generationService, artifactTransfer, orchestrator: createGenerationOrchestrator({ projectContextService, workbenchService, generationService, artifactTransfer }) };
}

test("creates one project, submits, and imports a direct result", async (context) => {
  const { calls, orchestrator } = await createHarness(context);
  const output = await orchestrator.submit({ prompt: "A red apple", activation: { source: "codex_explicit" }, idempotency_key: "job-1" });
  assert.equal(output.job.status, "succeeded");
  assert.equal(output.job.lovart_project_id, "project-auto");
  assert.equal(calls.filter(([name]) => name === "createProject").length, 1);
  assert.equal(calls.filter(([name]) => name === "generate").length, 1);
  assert.equal(calls.filter(([name]) => name === "confirm").length, 0);
});

test("uploads only managed workbench assets for direct generation", async (context) => {
  const { calls, orchestrator } = await createHarness(context);
  const output = await orchestrator.submit({
    prompt: "Use the registered reference",
    mode: "image",
    attachments: ["imvia-workbench:/assets/sample.png"],
    activation: { source: "workbench_action" },
    idempotency_key: "workbench-asset-1",
  });
  assert.equal(output.job.status, "succeeded");
  assert.deepEqual(calls.find(([name]) => name === "prepareWorkspaceAsset"), ["prepareWorkspaceAsset", { asset_path: "/assets/sample.png" }]);
  assert.equal(calls.filter(([name]) => name === "prepareUpload").length, 0);
  const generated = calls.find(([name]) => name === "generate");
  assert.deepEqual(generated[1].attachments, ["https://cdn.lovart.ai/sample.png"]);
});

test("Codex executes the exact queued workbench submission instead of creating a second job", async (context) => {
  const { calls, workbenchService, orchestrator } = await createHarness(context);
  await workbenchService.setLovartProject({ project_id: "project-workbench", source: "user_selected" });
  const queued = await workbenchService.createWorkbenchSubmission({
    snapshot: {
      mode: "image",
      model: "Seedream 4.0",
      prompt: { text: "  Workbench prompt byte-for-byte\n", tokens: [] },
      attachments: ["imvia-workbench:/assets/person-reference.png"],
      settings: { ratio: "3:4", resolution: "2K", count: 1 },
    },
    idempotency_key: "workbench-handoff-1",
  });

  const output = await orchestrator.executePrepared({ job_id: queued.job.id });
  assert.equal(output.job.id, queued.job.id);
  assert.equal(output.job.status, "succeeded");
  assert.equal(calls.find(([name]) => name === "generate")[1].prompt, "  Workbench prompt byte-for-byte\n");
  assert.equal(calls.find(([name]) => name === "generate")[1].project_id, "project-workbench");
  assert.equal((await workbenchService.getState({ include: ["jobs"] })).jobs.length, 1);
});

test("Auto leaves a split-image prompt unconstrained and imports every returned artifact", async (context) => {
  const { calls, dataDirectory, generationService, artifactTransfer, workbenchService, orchestrator } = await createHarness(context);
  const prompt = "Split the reference into every independently useful image.";
  const splitFiles = await Promise.all(["split-1", "split-2", "split-3"].map(async (id) => {
    const file = path.join(dataDirectory, "results", `${id}.png`);
    await writeFile(file, id, { mode: 0o600 });
    return [id, file];
  }));
  const splitPaths = new Map(splitFiles);
  generationService.generate = async (input) => {
    calls.push(["generate", input]);
    return {
      final_status: "done",
      thread_id: "thread-split",
      project_id: input.project_id,
      items: [{
        artifacts: [
          { type: "image", content: "https://cdn.lovart.ai/split-1.png", artifact_id: "split-1" },
          { type: "image", content: "https://cdn.lovart.ai/split-2.png", artifact_id: "split-2" },
          { type: "image", content: "https://cdn.lovart.ai/split-3.png", artifact_id: "split-3" },
        ],
      }],
    };
  };
  artifactTransfer.downloadResults = async ({ result }) => ({
    artifacts: result.items.flatMap((item) => item.artifacts).map((artifact) => ({
      kind: "image",
      local_path: splitPaths.get(artifact.artifact_id),
      source_url: artifact.content,
      source_artifact_id: artifact.artifact_id,
    })),
  });
  const queued = await workbenchService.createWorkbenchSubmission({
    snapshot: {
      mode: "image",
      model: "Image 2",
      prompt: { text: prompt, tokens: [] },
      attachments: [],
      settings: { count_mode: "auto", count: null },
    },
    idempotency_key: "workbench-auto-split",
  });

  const output = await orchestrator.executePrepared({ job_id: queued.job.id });
  const generated = calls.find(([name]) => name === "generate")[1];
  const state = await workbenchService.getState({ include: ["jobs", "artifacts"] });

  assert.equal(generated.prompt, prompt);
  assert.equal(Object.hasOwn(generated, "count"), false);
  assert.equal(output.job.status, "succeeded");
  assert.deepEqual(
    state.artifacts.filter((artifact) => artifact.job_id === queued.job.id).map((artifact) => artifact.source_artifact_id),
    ["split-1", "split-2", "split-3"],
  );
});

test("maps the Image 2 workbench label to Lovart's uppercase provider preference", async (context) => {
  const { calls, workbenchService, orchestrator } = await createHarness(context);
  await workbenchService.setLovartProject({ project_id: "project-image-2", source: "user_selected" });
  const queued = await workbenchService.createWorkbenchSubmission({
    snapshot: {
      mode: "image",
      model: "Image 2",
      prompt: { text: "Generate with Image 2.", tokens: [] },
      attachments: [],
      settings: { ratio: "3:4", resolution: "2K", count: 1 },
    },
    idempotency_key: "workbench-image-2-provider-model",
  });

  await orchestrator.executePrepared({ job_id: queued.job.id });

  const generated = calls.find(([name]) => name === "generate");
  assert.deepEqual(generated[1].prefer_models, { IMAGE: ["generate_image_gpt_image_2"] });
});

test("records an attachment upload failure at the upload stage with safe provider details", async (context) => {
  const { generationService, workbenchService, orchestrator } = await createHarness(context);
  generationService.upload = async () => {
    const error = new Error("Lovart rejected the reference upload: unsupported media.");
    error.code = "UPSTREAM_UNAVAILABLE";
    error.operation = "upload";
    error.details = { operation: "upload", provider_code: 2402, provider_message: "unsupported media" };
    throw error;
  };
  const queued = await workbenchService.createWorkbenchSubmission({
    snapshot: {
      mode: "image",
      model: "Image 2",
      prompt: { text: "Use this managed reference.", tokens: [] },
      attachments: ["imvia-workbench:/assets/sample.png"],
      settings: { ratio: "3:4", resolution: "2K", count: 1 },
    },
    idempotency_key: "workbench-upload-stage-failure",
  });

  await assert.rejects(() => orchestrator.executePrepared({ job_id: queued.job.id }), (error) => error.operation === "upload");
  const failed = (await workbenchService.getState({ include: ["jobs"] })).jobs.find((job) => job.id === queued.job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.status_message, "Lovart 参考素材上传失败。");
  assert.equal(failed.error.source, "imvia:lovart_upload");
  assert.deepEqual(failed.error.details, { operation: "upload", provider_code: 2402, provider_message: "unsupported media" });
});

test("workbench execution exposes live Codex progress and a final status message", async (context) => {
  const { workbenchService, orchestrator } = await createHarness(context);
  const queued = await workbenchService.createWorkbenchSubmission({
    snapshot: { mode: "video", prompt: { text: "Progressive video", tokens: [] }, attachments: [], settings: {} },
    idempotency_key: "workbench-progress-1",
  });
  const updates = [];
  const output = await orchestrator.executePrepared({ job_id: queued.job.id }, { onProgress: (update) => updates.push(update) });
  assert.equal(output.job.status, "succeeded");
  assert.equal(output.job.status_message, "Lovart 已完成生成。");
  assert.ok(updates.some((update) => update.phase === "accepted"));
  assert.ok(updates.some((update) => update.phase === "calling_lovart"));
  assert.ok(updates.some((update) => update.phase === "completed"));
});

test("explicit project is validated without changing the active project", async (context) => {
  const { calls, projectContextService, workbenchService, orchestrator } = await createHarness(context);
  await projectContextService.select({ locator: "active-project", source: "user_selected" });
  const output = await orchestrator.submit({ prompt: "Use external project", project_locator: "project-explicit", activation: { source: "codex_explicit" }, idempotency_key: "job-explicit" });
  assert.equal(output.job.lovart_project_id, "project-explicit");
  assert.equal((await workbenchService.getLovartProjects()).active_lovart_project_id, "active-project");
  assert.equal(calls.filter(([name]) => name === "validateProject").length >= 2, true);
});

test("pending cost pauses without confirmation", async (context) => {
  const { calls, orchestrator } = await createHarness(context);
  const output = await orchestrator.submit({ prompt: "pending premium video", activation: { source: "codex_explicit" }, idempotency_key: "job-pending" });
  assert.equal(output.job.status, "awaiting_cost_confirmation");
  assert.deepEqual(output.result.pending_confirmation, { amount: 12, unit: "credits" });
  assert.equal(calls.filter(([name]) => name === "confirm").length, 0);
});

test("explicitly accepted cost confirms once and imports the result", async (context) => {
  const { calls, orchestrator, workbenchService } = await createHarness(context);
  const pending = await orchestrator.submit({ prompt: "pending premium video", activation: { source: "codex_explicit" }, idempotency_key: "job-confirm" });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt });
  const decision = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "decision-1" });
  const confirmed = await orchestrator.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: decision.decision.decision_id });
  assert.equal(confirmed.job.status, "succeeded");
  assert.equal(calls.filter(([name]) => name === "confirm").length, 1);
});

test("idempotent retry returns the original job without a second submission", async (context) => {
  const { calls, orchestrator } = await createHarness(context);
  const first = await orchestrator.submit({ prompt: "A red apple", activation: { source: "codex_explicit" }, idempotency_key: "same-key" });
  const second = await orchestrator.submit({ prompt: "A red apple", activation: { source: "codex_explicit" }, idempotency_key: "same-key" });
  assert.equal(second.job.id, first.job.id);
  assert.equal(calls.filter(([name]) => name === "generate").length, 1);
});

test("a stored thread resumes polling without a second submit", async (context) => {
  const { calls, workbenchService, orchestrator } = await createHarness(context);
  const pending = await workbenchService.createDirectGenerationJob({ snapshot: { mode: null, prompt: { text: "resume me", tokens: [] }, attachments: [], prefer_models: null, include_tools: [] }, lovart_project_id: "project-resume", activation_source: { source: "codex_explicit" }, idempotency_key: "resume-key" });
  await workbenchService.updateLiveJob({ job_id: pending.job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "imvia:lovart_upload" });
  await workbenchService.updateLiveJob({ job_id: pending.job.id, expected_status: "uploading", next_status: "submitted", attempt: 1, source: "imvia:lovart_submit", lovart_thread_id: "thread-resume" });
  const resumed = await orchestrator.submit({ prompt: "resume me", project_locator: "project-resume", activation: { source: "codex_explicit" }, idempotency_key: "resume-key" });
  assert.equal(resumed.job.status, "succeeded");
  assert.equal(calls.filter(([name]) => name === "resume").length, 1);
  assert.equal(calls.filter(([name]) => name === "generate").length, 0);
});

test("continues one imported artifact with immutable parent lineage and thread reuse", async (context) => {
  const { calls, orchestrator, workbenchService } = await createHarness(context);
  const parent = await orchestrator.submit({ prompt: "Original prompt byte-for-byte", activation: { source: "codex_explicit" }, idempotency_key: "follow-parent" });
  const artifact = (await orchestrator.get({ job_id: parent.job.id })).artifacts[0];
  const result = await orchestrator.followUp({
    parent_job_id: parent.job.id,
    artifact_id: artifact.id,
    instruction: "Change the lighting to dusk",
    activation: { source: "codex_context_continuation", parent_job_id: parent.job.id, artifact_id: artifact.id },
    idempotency_key: "follow-1",
  });
  assert.equal(result.job.status, "succeeded");
  const followGenerate = calls.find(([name, input]) => name === "generate" && input.prompt.includes("Change the lighting"));
  assert.equal(followGenerate[1].thread_id, parent.job.lovart_thread_id);
  assert.deepEqual(followGenerate[1].attachments, ["https://cdn.lovart.ai/fake.png"]);
  const state = await workbenchService.getState({ include: ["jobs", "artifacts"] });
  const followJob = state.jobs.find((job) => job.id === result.job.id);
  assert.equal(followJob.follow_up.parent_job_id, parent.job.id);
  assert.equal(followJob.follow_up.parent_artifact_id, artifact.id);
  assert.equal(followJob.follow_up.instruction, "Change the lighting to dusk");
  assert.equal(followJob.follow_up.project_id, parent.job.lovart_project_id);
  assert.equal(followJob.snapshot.prompt.text, "Original prompt byte-for-byte");
});

test("follow-up rejects an artifact from a different parent job", async (context) => {
  const { orchestrator } = await createHarness(context);
  const first = await orchestrator.submit({ prompt: "First", activation: { source: "codex_explicit" }, idempotency_key: "cross-first" });
  const second = await orchestrator.submit({ prompt: "Second", activation: { source: "codex_explicit" }, idempotency_key: "cross-second" });
  const artifact = (await orchestrator.get({ job_id: first.job.id })).artifacts[0];
  await assert.rejects(
    () => orchestrator.followUp({ parent_job_id: second.job.id, artifact_id: artifact.id, instruction: "Cross job", activation: { source: "codex_context_continuation", parent_job_id: second.job.id, artifact_id: artifact.id }, idempotency_key: "cross-follow" }),
    (error) => error.code === "NOT_FOUND",
  );
});
