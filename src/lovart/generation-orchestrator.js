import { createCostFingerprint } from "../domain/cost-confirmation.js";
import { DomainError } from "../domain/errors.js";
import { lovartModelPreference } from "./model-selection.js";

const LIVE_UPLOAD = "imvia:lovart_upload";
const LIVE_SUBMIT = "imvia:lovart_submit";
const LIVE_STATUS = "imvia:lovart_status";
const LIVE_IMPORT = "imvia:lovart_import";
const LIVE_CONFIRM = "imvia:lovart_confirm";
const LIVE_FOLLOW_UP = "imvia:lovart_submit";
const WORKBENCH_ASSET_PREFIX = "imvia-workbench:";

const FAILURE_STATUS_MESSAGES = Object.freeze({
  [LIVE_UPLOAD]: "Lovart 参考素材上传失败。",
  [LIVE_SUBMIT]: "Lovart 任务提交失败。",
  [LIVE_STATUS]: "Lovart 状态同步失败。",
  [LIVE_IMPORT]: "Lovart 结果导入失败。",
  [LIVE_CONFIRM]: "Lovart 费用确认失败。",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultNow() {
  return Date.now();
}

async function notifyProgress(onProgress, update) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress(Object.freeze({ ...update }));
  } catch {
    // A disconnected Codex progress channel must not cancel a Lovart job.
  }
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

function sourceForFailure(error, fallback) {
  if (error?.operation === "upload") return LIVE_UPLOAD;
  if (["submit", "connect", "project_create", "project_validate"].includes(error?.operation)) return LIVE_SUBMIT;
  if (["status", "result"].includes(error?.operation)) return LIVE_STATUS;
  if (error?.operation === "confirm") return LIVE_CONFIRM;
  return fallback;
}

function safeFailure(error) {
  const result = {
    code: typeof error?.code === "string" ? error.code : "UPSTREAM_UNAVAILABLE",
    message: typeof error?.message === "string" && error.message.trim()
      ? error.message.trim().slice(0, 512)
      : "Lovart generation failed.",
  };
  if (typeof error?.operation === "string") result.operation = error.operation;
  if (Number.isInteger(error?.status)) result.status = error.status;
  if (error?.details && typeof error.details === "object" && !Array.isArray(error.details)) result.details = clone(error.details);
  return result;
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
      return (await workbenchService.updateLiveJob({
        job_id: job.id,
        expected_status: job.status,
        next_status: next,
        attempt: job.attempt,
        source,
        status_message: FAILURE_STATUS_MESSAGES[source] || "Lovart 处理失败。",
        error: safeFailure(error),
      })).job;
    } catch {
      return job;
    }
  }

  async function importOrComplete(job, result, idempotencyKey, onProgress) {
    const downloaded = artifactTransfer?.downloadResults
      ? await artifactTransfer.downloadResults({ job_id: job.id, result })
      : { artifacts: [] };
    if (downloaded.artifacts?.length) {
      const imported = await workbenchService.importResult({ job_id: job.id, artifacts: downloaded.artifacts, idempotency_key: `${idempotencyKey}:import` });
      await notifyProgress(onProgress, { phase: "completed", status: imported.job.status, message: imported.job.status === "succeeded" ? "Lovart 结果已导入工作台。" : "Lovart 结果已部分导入工作台。" });
      return { job: imported.job, result: clone(result) };
    }
    const completed = await workbenchService.updateLiveJob({ job_id: job.id, expected_status: job.status, next_status: "succeeded", attempt: job.attempt, source: LIVE_IMPORT, status_message: "Lovart 已完成生成。" });
    await notifyProgress(onProgress, { phase: "completed", status: completed.job.status, message: "Lovart 已完成生成，结果已准备好。" });
    return { job: completed.job, result: clone(result) };
  }

  async function handleResult(job, result, idempotencyKey, onProgress) {
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
        status_message: `Lovart 需要费用确认：${pending.amount} ${pending.unit}。`,
      });
      const cost_fingerprint = createCostFingerprint({ ...updated.job.estimated_cost, job_id: updated.job.id, attempt: updated.job.attempt });
      await notifyProgress(onProgress, { phase: "awaiting_cost_confirmation", status: updated.job.status, message: updated.job.status_message, cost: { amount: pending.amount, unit: pending.unit } });
      return { job: updated.job, result: { ...clone(result), cost_fingerprint } };
    }
    if (result?.final_status !== "done") {
      const failed = await markFailed(job, LIVE_STATUS, new Error(`Lovart generation ended with ${result?.final_status || "unknown"}.`));
      await notifyProgress(onProgress, { phase: "failed", status: failed.job?.status || "failed", message: failed.job?.status_message || "Lovart 处理失败。" });
      return { job: failed.job ?? failed, result: clone(result) };
    }
    const generating = job.status === "submitted"
      ? (await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "submitted", next_status: "generating", attempt: job.attempt, source: LIVE_STATUS, lovart_thread_id: result.thread_id, status_message: "Lovart 已返回结果，正在导入。" })).job
      : job;
    return importOrComplete(generating, result, idempotencyKey, onProgress);
  }

  async function resumeExisting(job, result, idempotencyKey, onProgress) {
    if (["succeeded", "partially_succeeded", "failed", "cancelled", "declined"].includes(job.status)) return { job, result: result ?? null };
    if (job.status === "awaiting_cost_confirmation") return { job, result: result ?? null };
    if (!job.lovart_thread_id || typeof generationService.resume !== "function") return { job, result: result ?? null };
    const resumed = await generationService.resume({ thread_id: job.lovart_thread_id, project_id: job.lovart_project_id }, { onProgress });
    return handleResult(job.status === "submitted" ? job : { ...job, status: "generating" }, resumed, idempotencyKey, onProgress);
  }

  async function uploadAttachments(values = [], onProgress) {
    const attachments = [];
    for (const [index, attachment] of values.entries()) {
      await notifyProgress(onProgress, { phase: "uploading", status: "uploading", progress: { current: index + 1, total: values.length }, message: `正在上传参考素材（${index + 1}/${values.length}）。` });
      if (typeof attachment === "string" && attachment.startsWith(WORKBENCH_ASSET_PREFIX) && artifactTransfer?.prepareWorkspaceAsset) {
        const preparedUpload = await artifactTransfer.prepareWorkspaceAsset({ asset_path: attachment.slice(WORKBENCH_ASSET_PREFIX.length) });
        attachments.push((await generationService.upload(preparedUpload)).url);
      } else if (typeof attachment === "string" && attachment.startsWith("imvia-upload:") && artifactTransfer?.prepareManagedUpload) {
        const preparedUpload = await artifactTransfer.prepareManagedUpload({ asset_name: attachment.slice("imvia-upload:".length) });
        attachments.push((await generationService.upload(preparedUpload)).url);
      } else if (artifactTransfer?.prepareUpload && typeof attachment === "string" && !/^https:\/\//iu.test(attachment)) {
        const preparedUpload = await artifactTransfer.prepareUpload({ local_path: attachment });
        attachments.push((await generationService.upload(preparedUpload)).url);
      } else attachments.push(attachment);
    }
    return attachments;
  }

  async function executeQueued(job, input, projectId, idempotencyKey, onProgress) {
    let currentJob = job;
    let failureSource = LIVE_UPLOAD;
    const report = async (update) => {
      const message = typeof update?.message === "string" && update.message.trim() ? update.message.trim() : null;
      if (update?.status === "submitted" && update.thread_id && currentJob.status === "uploading") {
        try {
          currentJob = (await workbenchService.updateLiveJob({
            job_id: currentJob.id,
            expected_status: "uploading",
            next_status: "submitted",
            attempt: currentJob.attempt,
            source: LIVE_SUBMIT,
            lovart_thread_id: update.thread_id,
            status_message: message || "已提交 Lovart，正在生成。",
            progress: update.progress ?? { phase: update.phase ?? "submitted", provider_status: update.provider_status ?? null },
          })).job;
        } catch {
          // The fallback transition after the Lovart call remains authoritative.
        }
      } else if (message && currentJob.direct_generation && typeof workbenchService.updateLiveJobProgress === "function" && ["uploading", "submitted", "generating", "awaiting_cost_confirmation"].includes(currentJob.status)) {
        try {
          currentJob = (await workbenchService.updateLiveJobProgress({
            job_id: currentJob.id,
            expected_status: currentJob.status,
            attempt: currentJob.attempt,
            source: LIVE_STATUS,
            status_message: message,
            progress: update.progress ?? { phase: update.phase ?? "processing", provider_status: update.provider_status ?? null },
          })).job;
        } catch {
          // The state transition that follows owns the authoritative status.
        }
      }
      await notifyProgress(onProgress, update);
    };
    try {
      currentJob = (await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: job.attempt, source: LIVE_UPLOAD, status_message: "Codex 已收到，正在准备素材并调用 Lovart。", progress: { phase: "accepted", status: "uploading" } })).job;
      await report({ phase: "accepted", status: "uploading", message: currentJob.status_message });
      const attachments = await uploadAttachments(input.attachments ?? [], report);
      await report({ phase: "calling_lovart", status: "uploading", message: "素材已准备，正在调用 Lovart。" });
      failureSource = LIVE_SUBMIT;
      const result = await generationService.generate({
        prompt: input.prompt,
        project_id: projectId,
        ...(input.thread_id ? { thread_id: input.thread_id } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.prefer_models ? { prefer_models: input.prefer_models } : {}),
        ...(input.include_tools?.length ? { include_tools: input.include_tools } : {}),
      }, { onProgress: report });
      const submitted = currentJob.status === "submitted"
        ? { job: currentJob }
        : await workbenchService.updateLiveJob({ job_id: currentJob.id, expected_status: "uploading", next_status: "submitted", attempt: currentJob.attempt, source: LIVE_SUBMIT, lovart_thread_id: result.thread_id, status_message: "已提交 Lovart，正在生成。" });
      currentJob = submitted.job;
      return handleResult(currentJob, result, idempotencyKey, report);
    } catch (error) {
      await markFailed(currentJob, sourceForFailure(error, failureSource), error);
      throw error;
    }
  }

  async function submit(input, { onProgress } = {}) {
    if (!input || typeof input.prompt !== "string" || !input.prompt.trim()) throw new DomainError("VALIDATION_FAILED", "prompt is required.", { field: "prompt" });
    if (!input.activation || typeof input.activation !== "object") throw new DomainError("VALIDATION_FAILED", "explicit Lovart activation is required.", { field: "activation" });
    if (!input.idempotency_key || typeof input.idempotency_key !== "string") throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
    const resolved = await projectContextService.resolve({ explicit_locator: input.project_locator ?? null });
    const snapshot = safeInputSnapshot({ ...input, prompt: input.prompt.trim() });
    const prepared = await workbenchService.createDirectGenerationJob({ snapshot, lovart_project_id: resolved.project_id, activation_source: input.activation, idempotency_key: input.idempotency_key });
    if (prepared.idempotent) return resumeExisting(prepared.job, null, input.idempotency_key, onProgress);
    return executeQueued(prepared.job, { ...input, prompt: input.prompt.trim() }, resolved.project_id, input.idempotency_key, onProgress);
  }

  async function executePrepared(input, { onProgress } = {}) {
    const current = (await readJob(input)).job;
    if (current.submission_kind !== "workbench_generation" || current.activation?.source !== "workbench_action") {
      throw new DomainError("VALIDATION_FAILED", "The requested job is not a workbench submission.", { job_id: current.id });
    }
    if (current.direct_generation) {
      if (current.status === "queued_for_agent") {
        return executeQueued(current, {
          prompt: current.snapshot.prompt.text,
          attachments: current.snapshot.attachments ?? [],
          prefer_models: lovartModelPreference({ mode: current.snapshot.mode, model: current.snapshot.model }),
        }, current.lovart_project_id, current.idempotency_key, onProgress);
      }
      return resumeExisting(current, null, current.idempotency_key, onProgress);
    }
    const resolved = current.lovart_project_id
      ? await projectContextService.resolve({ explicit_locator: current.lovart_project_id })
      : { project_id: (await projectContextService.create({ source: "auto_created" })).project_id, source: "auto_create" };
    const activated = await workbenchService.activateWorkbenchSubmission({ job_id: current.id, lovart_project_id: resolved.project_id });
    return executeQueued(activated.job, {
      prompt: current.snapshot.prompt.text,
      attachments: current.snapshot.attachments ?? [],
      prefer_models: lovartModelPreference({ mode: current.snapshot.mode, model: current.snapshot.model }),
    }, resolved.project_id, current.idempotency_key, onProgress);
  }

  async function followUp(input, { onProgress } = {}) {
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
      await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: job.attempt, source: LIVE_UPLOAD, status_message: "正在准备继续编辑并调用 Lovart。" });
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
      }, { onProgress });
      const submitted = await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "uploading", next_status: "submitted", attempt: job.attempt, source: LIVE_FOLLOW_UP, lovart_thread_id: result.thread_id, status_message: "继续编辑已提交 Lovart，正在生成。" });
      job = submitted.job;
      return handleResult(job, result, input.idempotency_key, onProgress);
    } catch (error) {
      await markFailed(job, LIVE_STATUS, error);
      throw error;
    }
  }

  async function confirm(input, { onProgress } = {}) {
    const current = await readJob(input.job_id);
    const job = current.job;
    if (job.status !== "awaiting_cost_confirmation" || job.attempt !== input.attempt || !job.lovart_thread_id) throw new DomainError("COST_CONFIRMATION_CONFLICT", "The Lovart job is not awaiting this confirmation.", { job_id: job.id, attempt: job.attempt });
    const fingerprint = createCostFingerprint({ ...job.estimated_cost, job_id: job.id, attempt: job.attempt });
    if (fingerprint !== input.cost_fingerprint) throw new DomainError("COST_CONFIRMATION_CONFLICT", "The supplied cost fingerprint is stale.", { job_id: job.id, attempt: job.attempt });
    const decision = job.cost_decisions?.find((item) => item.decision_id === input.decision_id);
    if (!decision || decision.decision !== "accepted" || decision.cost_fingerprint !== fingerprint || decision.confirmation) throw new DomainError("COST_CONFIRMATION_CONFLICT", "The supplied cost decision cannot confirm this job.", { job_id: job.id, attempt: job.attempt });
    if (!decision.consumed_at) await workbenchService.claimCostDecision({ decision_id: input.decision_id, job_id: job.id, attempt: input.attempt, cost_fingerprint: fingerprint });
    const result = await generationService.confirm({ thread_id: job.lovart_thread_id }, { onProgress });
    const generating = (await workbenchService.updateLiveJob({ job_id: job.id, expected_status: "awaiting_cost_confirmation", next_status: "generating", attempt: job.attempt, source: LIVE_CONFIRM, lovart_thread_id: job.lovart_thread_id, cost_decision_id: input.decision_id, confirmation_evidence: { kind: "confirmation_accepted" }, status_message: "费用已确认，Lovart 正在继续生成。" })).job;
    return importOrComplete(generating, result, `${job.id}:confirm`, onProgress);
  }

  return Object.freeze({ submit, executePrepared, followUp, get: readJob, confirm });
}
