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
    async downloadResults(input) { calls.push(["downloadResults", input]); return { artifacts: [{ kind: "image", local_path: resultFile, source_url: "https://cdn.lovart.ai/result.png", source_artifact_id: "artifact-source-1" }] }; },
  };
  return { calls, workbenchService, projectContextService, generationService, artifactTransfer, orchestrator: createGenerationOrchestrator({ projectContextService, workbenchService, generationService, artifactTransfer }) };
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
