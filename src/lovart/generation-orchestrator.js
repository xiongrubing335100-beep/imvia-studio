import { createCostFingerprint } from "../domain/cost-confirmation.js";
import { DomainError } from "../domain/errors.js";

const LIVE_UPLOAD = "imvia:lovart_upload";
const LIVE_SUBMIT = "imvia:lovart_submit";
const LIVE_STATUS = "imvia:lovart_status";
const LIVE_IMPORT = "imvia:lovart_import";
const LIVE_CONFIRM = "imvia:lovart_confirm";
const LIVE_FOLLOW_UP = "imvia:lovart_submit";
const WORKBENCH_ASSET_PREFIX = "imvia-workbench:";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultNow() {
  return Date.now();
}

function safeInputSnapshot(input) {
  return {
    mode: input.mode ?? null,
    prompt: { text: input.prompt, tokens: [] },
    attachments: Array.isArray(input.attachments) ? [...input.attachments] : [],
    prefer_models: input.prefer_models ?? null,
    include_tools: input.include_tools ?? [],
  };
}

export function createGenerationOrchestrator({
  projectContextService,
  workbenchService,
  generationService,
  artifactTransfer = null,
  now = defaultNow,
} = {}) {
  if (!projectContextService?.resolve || !workbenchService?.createDirectGenerationJob || !workbenchService?.updateLiveJob) throw new TypeError("projectContextService and workbenchService are required");
  if (!generationService?.generate || !generationService?.confirm) throw new TypeError("generationService is required");

  async function readJob(jobIdOrInput) {
    const jobId = typeof jobIdOrInput === "string" ? jobIdOrInput : jobIdOrInput?.job_id;
    if (typeof jobId !== "string" || !jobId) throw new DomainError("VALIDATION_FAILED", "job_id is required.", { field: "job_id" });
    const state = await workbenchService.getState({ include: ["jobs", "artifacts"] });
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw new DomainError("NOT_FOUND", "The requested Lovart generation job does not exist.", { job_id: jobId });
    return { job, artifacts: state.artifacts.filter((artifact) => artifact.job_id === job.id) };
  }

  async function markFailed(job, source, error) {
    const next = job.status === "uploading" ? "failed" : job.status === "submitted" || job.status === "generating" ? "failed" : null;
    if (!next) return { job };
    try {
      return (await workbenchService.updateLiveJob({ job_id: job.id, expected_status: job.status, next_status: next, attempt: job.attempt, source, error: { code: error?.code || "UPSTREAM_UNAVAILABLE", message: error?.message || "Lovart generation failed." } })).job;
    } catch {
      return job;
    }
  }

  async function importOrComplete(job, result, idempotencyKey) {
    const downloaded = artifactTransfer?.downloadResults
      ? await artifactTransfer.downloadResults({ job_id: job.id, result })
      : { artifacts: [] };
    if (downloaded.artifacts?.length) {
      const imported = await workbenchService.importResult({ job_id: job.id, artifacts: downloaded.artifacts, idempotency_key: `${idempotencyKey}:import` });
      return { job: imported.job, result: clone(result) };
    }
    const completed = await workbenchService.updateLiveJob({ job_id: job.id, expected_status: job.status, next_status: "succeeded", attempt: job.attempt, source: LIVE_IMPORT });
    return { job: completed.job, result: clone(result) };
  }

  async function handleResult(job, result, idempotencyKey) {
    if (result?.final_status === "pending_confirmation") {
      const pending = result.pending_confirmation;
      if (!pending || !Number.isFinite(pending.amount) || pending.amount < 0 || typeof pending.unit !== "string" || !pending.unit) {
        throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "Lovart returned an invalid cost confirmation.");
      }
      const checkedAt = new Date(now()).toISOString();
      const updated = await workbenchService.updateLiveJob({
        job_id: job.id,
        expected_status: job.status,
        next_status: "awaiting_cost_confirmation",
        attempt: job.attempt,
        source: LIVE_STATUS,
        source_checked_at: checkedAt,
        estimated_cost: { amount: pending.amount, unit: pending.unit },
      });
      const cost_fingerprint = createCostFingerprint({ ...updated.job.estimated_cost, job_id: updated.job.id, attempt: updated.job.attempt });
      return { job: updated.job, result: { ...clone(result), cost_fingerprint } };
    }
    if (result?.final_status !== "done") {
      const failed = await markFailed(job, LIVE_STATUS, new Error(`Lovart generation ended with ${result?.final_status || "unknown"}.`));
      return { job: failed.job ?? failed, result: clone(result) };
    }
    const generating = job.status === "submitted"
      ? (await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "submitted", next_status: "generating", attempt: job.attempt, source: LIVE_STATUS, lovart_thread_id: result.thread_id })).job
      : job;
    return importOrComplete(generating, result, idempotencyKey);
  }

  async function resumeExisting(job, result, idempotencyKey) {
    if (["succeeded", "partially_succeeded", "failed", "cancelled", "declined"].includes(job.status)) return { job, result: result ?? null };
    if (job.status === "awaiting_cost_confirmation") return { job, result: result ?? null };
    if (!job.lovart_thread_id || typeof generationService.resume !== "function") return { job, result: result ?? null };
    const resumed = await generationService.resume({ thread_id: job.lovart_thread_id, project_id: job.lovart_project_id });
    return handleResult(job.status === "submitted" ? job : { ...job, status: "generating" }, resumed, idempotencyKey);
  }

  async function submit(input) {
    if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) throw new DomainError("VALIDATION_FAILED", "prompt is required.", { field: "prompt" });
    if (!input.activation || typeof input.activation !== "object") throw new DomainError("VALIDATION_FAILED", "explicit Lovart activation is required.", { field: "activation" });
    if (!input.idempotency_key || typeof input.idempotency_key !== "string") throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
    const resolved = await projectContextService.resolve({ explicit_locator: input.project_locator ?? null });
    const snapshot = safeInputSnapshot({ ...input, prompt: input.prompt.trim() });
    const prepared = await workbenchService.createDirectGenerationJob({ snapshot, lovart_project_id: resolved.project_id, activation_source: input.activation, idempotency_key: input.idempotency_key });
    if (prepared.idempotent) return resumeExisting(prepared.job, null, input.idempotency_key);
    let job = prepared.job;
    try {
      await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: job.attempt, source: LIVE_UPLOAD });
      const attachments = [];
      for (const attachment of input.attachments ?? []) {
        if (typeof attachment === "string" && attachment.startsWith(WORKBENCH_ASSET_PREFIX) && artifactTransfer?.prepareWorkspaceAsset) {
          const preparedUpload = await artifactTransfer.prepareWorkspaceAsset({ asset_path: attachment.slice(WORKBENCH_ASSET_PREFIX.length) });
          attachments.push((await generationService.upload(preparedUpload)).url);
        } else if (artifactTransfer?.prepareUpload && typeof attachment === "string" && !/^https:\/\//iu.test(attachment)) {
          const preparedUpload = await artifactTransfer.prepareUpload({ local_path: attachment });
          attachments.push((await generationService.upload(preparedUpload)).url);
        } else attachments.push(attachment);
      }
      const result = await generationService.generate({
        prompt: input.prompt.trim(),
        project_id: resolved.project_id,
        ...(input.thread_id ? { thread_id: input.thread_id } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.prefer_models ? { prefer_models: input.prefer_models } : {}),
        ...(input.include_tools?.length ? { include_tools: input.include_tools } : {}),
      });
      const submitted = await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "uploading", next_status: "submitted", attempt: job.attempt, source: LIVE_SUBMIT, lovart_thread_id: result.thread_id });
      job = submitted.job;
      return handleResult(job, result, input.idempotency_key);
    } catch (error) {
      await markFailed(job, LIVE_STATUS, error);
      throw error;
    }
  }

  async function followUp(input) {
    if (!input || typeof input.parent_job_id !== "string" || !input.parent_job_id.trim()) throw new DomainError("VALIDATION_FAILED", "parent_job_id is required.", { field: "parent_job_id" });
    if (typeof input.artifact_id !== "string" || !input.artifact_id.trim()) throw new DomainError("VALIDATION_FAILED", "artifact_id is required.", { field: "artifact_id" });
    if (typeof input.instruction !== "string" || !input.instruction.trim()) throw new DomainError("VALIDATION_FAILED", "instruction is required.", { field: "instruction" });
    if (!input.activation || typeof input.activation !== "object") throw new DomainError("VALIDATION_FAILED", "explicit Lovart activation is required.", { field: "activation" });
    if (!input.idempotency_key || typeof input.idempotency_key !== "string") throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
    const parent = (await readJob(input.parent_job_id)).job;
    if (!parent.direct_generation || !["succeeded", "partially_succeeded"].includes(parent.status)) {
      throw new DomainError("STATUS_CONFLICT", "Follow-up requires a successful or partially successful Lovart parent job.", { parent_job_id: parent.id, current_status: parent.status });
    }
    const current = await readJob(input.parent_job_id);
    const artifact = current.artifacts.find((item) => item.id === input.artifact_id);
    if (!artifact) throw new DomainError("NOT_FOUND", "The selected artifact does not belong to the parent job.", { artifact_id: input.artifact_id, parent_job_id: parent.id });
    const activation = {
      source: "codex_context_continuation",
      parent_job_id: parent.id,
      artifact_id: artifact.id,
    };
    const prepared = await workbenchService.createFollowUpGenerationJob({
      parent_job_id: parent.id,
      artifact_id: artifact.id,
      instruction: input.instruction,
      activation_source: activation,
      idempotency_key: input.idempotency_key,
    });
    if (prepared.idempotent) return resumeExisting(prepared.job, null, input.idempotency_key);
    let job = prepared.job;
    try {
      await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: job.attempt, source: LIVE_UPLOAD });
      if (!artifact.local_path || !artifact.local_path.startsWith("/")) throw new DomainError("LOCAL_FILE_UNAVAILABLE", "The selected managed artifact is unavailable for follow-up.", { artifact_id: artifact.id });
      if (!artifactTransfer?.prepareUpload || typeof generationService.upload !== "function") throw new DomainError("LOCAL_FILE_UNAVAILABLE", "The managed artifact transfer service is unavailable.", { artifact_id: artifact.id });
      const preparedUpload = await artifactTransfer.prepareUpload({ local_path: artifact.local_path });
      const uploaded = await generationService.upload(preparedUpload);
      const prompt = `${parent.snapshot?.prompt?.text ?? ""}\n\n${input.instruction.trim()}`.trim();
      const canReuseThread = typeof parent.lovart_thread_id === "string"
        && parent.lovart_thread_id
        && typeof parent.lovart_thread_source === "string"
        && parent.lovart_thread_source.startsWith("imvia:lovart_");
      const result = await generationService.generate({
        prompt,
        project_id: parent.lovart_project_id,
        ...(canReuseThread ? { thread_id: parent.lovart_thread_id } : {}),
        attachments: [uploaded.url],
      });
      const submitted = await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "uploading", next_status: "submitted", attempt: job.attempt, source: LIVE_FOLLOW_UP, lovart_thread_id: result.thread_id });
      job = submitted.job;
      return handleResult(job, result, input.idempotency_key);
    } catch (error) {
      await markFailed(job, LIVE_STATUS, error);
      throw error;
    }
  }

  async function confirm(input) {
    const current = await readJob(input.job_id);
    const job = current.job;
    if (job.status !== "awaiting_cost_confirmation" || job.attempt !== input.attempt || !job.lovart_thread_id) throw new DomainError("COST_CONFIRMATION_CONFLICT", "The Lovart job is not awaiting this confirmation.", { job_id: job.id, attempt: job.attempt });
    const fingerprint = createCostFingerprint({ ...job.estimated_cost, job_id: job.id, attempt: job.attempt });
    if (fingerprint !== input.cost_fingerprint) throw new DomainError("COST_CONFIRMATION_CONFLICT", "The supplied cost fingerprint is stale.", { job_id: job.id, attempt: job.attempt });
    const decision = job.cost_decisions?.find((item) => item.decision_id === input.decision_id);
    if (!decision || decision.decision !== "accepted" || decision.cost_fingerprint !== fingerprint || decision.confirmation) throw new DomainError("COST_CONFIRMATION_CONFLICT", "The supplied cost decision cannot confirm this job.", { job_id: job.id, attempt: job.attempt });
    if (!decision.consumed_at) await workbenchService.claimCostDecision({ decision_id: input.decision_id, job_id: job.id, attempt: input.attempt, cost_fingerprint: fingerprint });
    const result = await generationService.confirm({ thread_id: job.lovart_thread_id });
    const generating = (await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "awaiting_cost_confirmation", next_status: "generating", attempt: job.attempt, source: LIVE_CONFIRM, lovart_thread_id: job.lovart_thread_id, cost_decision_id: input.decision_id, confirmation_evidence: { kind: "confirmation_accepted" } })).job;
    return importOrComplete(generating, result, `${job.id}:confirm`);
  }

  return Object.freeze({ submit, followUp, get: readJob, confirm });
}
