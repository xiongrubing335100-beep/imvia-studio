import { snapshotDigest } from "../bridge/task-message.js";
import { DomainError } from "../domain/errors.js";
import { modelRecordDigest } from "./model-catalog.js";
import { requestTemplateUsesSnapshotToken } from "./request-template.js";

const TERMINAL_STATUSES = new Set(["succeeded", "partially_succeeded", "failed", "cancelled", "declined"]);
const PROVIDER_SOURCES = Object.freeze({
  uploading: "imvia:provider_upload",
  submitted: "imvia:provider_submit",
  generating: "imvia:provider_status",
  importing: "imvia:provider_import",
  confirming: "imvia:provider_confirm",
});
const SECRET_FIELD_NAME = /^(?:credential(?:_|$)|secret(?:_?key)?$|password$|api[_-]?key$|access[_-]?key$|private[_-]?key$|authorization$|bearer(?:_?token)?$|token$|session[_-]?cookie$)/i;
const SAFE_PROVIDER_CODES = new Set(["AUTHENTICATION_FAILED", "UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_SCHEMA_UNRECOGNIZED", "REQUEST_TIMEOUT", "VALIDATION_FAILED", "STATUS_CONFLICT", "COST_CONFIRMATION_REQUIRED", "CREDENTIAL_SETUP_FAILED"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function digest(snapshot) {
  return snapshotDigest(snapshot);
}

function fail(code, message, details = {}) {
  throw new DomainError(code, message, details);
}

function redact(value, secretFieldIds = new Set()) {
  if (Array.isArray(value)) return value.map((item) => redact(item, secretFieldIds));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_NAME.test(key) || secretFieldIds.has(key.toLowerCase())) continue;
    output[key] = redact(item, secretFieldIds);
  }
  return output;
}

function safeProviderError(error, provider_id) {
  const code = SAFE_PROVIDER_CODES.has(error?.code) ? error.code : "UPSTREAM_UNAVAILABLE";
  return new DomainError(code, code === "AUTHENTICATION_FAILED" ? "The provider credentials were rejected." : "The selected provider could not complete this request.", {
    provider_id,
    ...(typeof error?.details?.operation === "string" ? { operation: error.details.operation } : {}),
  });
}

function jobResult(state, jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) fail("NOT_FOUND", "The requested workbench job does not exist.", { job_id: jobId });
  return { job, artifacts: state.artifacts.filter((artifact) => artifact.job_id === job.id) };
}

function frozenProvider(job) {
  const provider_id = job.snapshot?.provider_id ?? job.provider_id ?? "lovart";
  const connection_id = job.snapshot?.connection_id ?? job.connection_id ?? null;
  const connection_config_revision = job.snapshot?.connection_config_revision ?? null;
  const model_catalog_revision = job.snapshot?.model_catalog_revision ?? null;
  const model_catalog_digest = job.snapshot?.model_catalog_digest ?? null;
  const adapter_id = job.snapshot?.adapter_id ?? null;
  const adapter_version = job.snapshot?.adapter_version ?? null;
  const selected_model = job.snapshot?.selected_model ?? null;
  const selected_model_digest = job.snapshot?.selected_model_digest ?? null;
  if (typeof provider_id !== "string" || !provider_id) fail("VALIDATION_FAILED", "The job has no immutable provider selection.", { job_id: job.id });
  return { provider_id, connection_id, connection_config_revision, model_catalog_revision, model_catalog_digest, adapter_id, adapter_version, selected_model, selected_model_digest };
}

function publicProgress(event) {
  const stage = event?.stage;
  if (stage !== "uploading" && stage !== "submitted" && stage !== "generating") return null;
  const progress = Number.isFinite(event?.progress) && event.progress >= 0 && event.progress <= 100 ? event.progress : undefined;
  return { stage, ...(progress === undefined ? {} : { progress }) };
}

function statusMessage(provider, stage) {
  const name = provider.display_name || provider.id;
  if (stage === "uploading") return `Codex 正在准备并上传素材到 ${name}。`;
  if (stage === "submitted") return `已提交 ${name}，正在处理中。`;
  if (stage === "generating") return `${name} 正在生成，状态会持续同步。`;
  if (stage === "completed") return `${name} 已完成生成。`;
  return "任务状态已更新。";
}

function providerCost(result) {
  const reported = result?.pending_confirmation ?? result?.cost_confirmation ?? result?.cost ?? null;
  const requires = result?.requires_confirmation === true || result?.pending_confirmation != null || result?.cost_confirmation != null;
  // Absence of a provider cost declaration is deliberately not treated as free.
  // A provider must explicitly state a zero/known-free cost before execution can
  // proceed without a user decision.
  if (reported == null && !requires) {
    return result?.known_free === true || result?.cost_status === "known_free"
      ? { status: "known_free", amount: 0, unit: "provider" }
      : { status: "unknown", amount: null, unit: null };
  }
  if (Number.isFinite(reported?.amount) && reported.amount >= 0 && typeof reported.unit === "string" && reported.unit) {
    return { status: reported.amount > 0 || requires ? "pending" : "known_free", amount: reported.amount, unit: reported.unit };
  }
  return { status: "unknown", amount: null, unit: null };
}

function supportsIdempotentSubmit(target) {
  const submit = target.connection?.endpoint_mappings?.submit ?? {};
  // Generic REST providers must explicitly expose the metadata in their
  // request template.  A capability flag alone is insufficient because it
  // would make retries look idempotent without placing the key on the wire.
  return requestTemplateUsesSnapshotToken(submit, "idempotency_key");
}

function supportsUnknownCostConfirmation(executor) {
  return typeof executor?.confirm === "function" || typeof executor?.refreshCost === "function";
}

function artifactIdentity(item, index) {
  if (typeof item?.source_artifact_id === "string" && item.source_artifact_id) return item.source_artifact_id;
  if (typeof item?.artifact_id === "string" && item.artifact_id) return item.artifact_id;
  if (typeof item?.id === "string" && item.id) return item.id;
  return `provider-artifact-${index + 1}`;
}

function preserveArtifactCardinality(rawArtifacts, transferredArtifacts) {
  if (!Array.isArray(transferredArtifacts) || transferredArtifacts.length !== rawArtifacts.length) {
    fail("UPSTREAM_SCHEMA_UNRECOGNIZED", "The provider artifact transfer changed the result count.");
  }
  const identities = rawArtifacts.map(artifactIdentity);
  if (new Set(identities).size !== identities.length) fail("UPSTREAM_SCHEMA_UNRECOGNIZED", "The provider returned duplicate artifact identities.");
  return transferredArtifacts.map((artifact, index) => {
    const supplied = artifactIdentity(artifact, index);
    if ((artifact?.source_artifact_id || artifact?.artifact_id || artifact?.id) && supplied !== identities[index]) {
      fail("UPSTREAM_SCHEMA_UNRECOGNIZED", "The provider artifact transfer changed artifact identity.");
    }
    return { ...artifact, source_artifact_id: identities[index] };
  });
}

function providerRequestSnapshot(snapshot) {
  const requestSnapshot = clone(snapshot ?? {});
  if (requestSnapshot.prompt && typeof requestSnapshot.prompt === "object" && !Array.isArray(requestSnapshot.prompt)) {
    requestSnapshot.prompt = typeof requestSnapshot.prompt.text === "string" ? requestSnapshot.prompt.text : "";
  }
  return requestSnapshot;
}

function normalizeModernEstimate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("UPSTREAM_SCHEMA_UNRECOGNIZED", "The provider returned an invalid cost estimate.");
  if (value.status === "known_free") return { status: "known_free", amount: 0, unit: typeof value.unit === "string" && value.unit ? value.unit : "provider" };
  if (value.status === "unknown") return { status: "unknown", amount: null, unit: null };
  if (value.status === "pending" && Number.isFinite(value.amount) && value.amount > 0 && typeof value.unit === "string" && value.unit) return { status: "pending", amount: value.amount, unit: value.unit };
  fail("UPSTREAM_SCHEMA_UNRECOGNIZED", "The provider returned an invalid cost estimate.");
}

function assertFrozenModel(job, frozen, connection) {
  if (!Number.isInteger(frozen.model_catalog_revision) || frozen.model_catalog_revision < 1 || typeof frozen.model_catalog_digest !== "string" || !frozen.model_catalog_digest || !frozen.selected_model || typeof frozen.selected_model !== "object" || Array.isArray(frozen.selected_model) || typeof frozen.selected_model_digest !== "string" || !frozen.selected_model_digest) {
    fail("VALIDATION_FAILED", "The external job is missing its immutable model snapshot.", { job_id: job.id });
  }
  if (modelRecordDigest(frozen.selected_model) !== frozen.selected_model_digest
    || frozen.selected_model.id !== job.snapshot?.model
    || frozen.selected_model.compatibility === "unsupported"
    || !Array.isArray(frozen.selected_model.capabilities)
    || !frozen.selected_model.capabilities.includes(job.snapshot?.mode)) {
    fail("VALIDATION_FAILED", "The external job model snapshot is invalid.", { job_id: job.id });
  }
  if (!Number.isInteger(connection.model_catalog_revision) || connection.model_catalog_revision < frozen.model_catalog_revision
    || (connection.model_catalog_revision === frozen.model_catalog_revision && connection.model_catalog_digest !== frozen.model_catalog_digest)) {
    fail("CONNECTION_UNAVAILABLE", "The selected provider catalog no longer matches this job's immutable snapshot.", { job_id: job.id, provider_id: frozen.provider_id, connection_id: frozen.connection_id });
  }
}

function assertModernCostAuthorization(job, estimate) {
  if (estimate.status === "known_free") return null;
  const authorization = job.pre_submit_cost_authorization;
  if (!authorization || authorization.attempt !== job.attempt || authorization.resume_status !== "uploading" || authorization.used_at != null || !authorization.cost_fingerprint || !authorization.decision_id) return null;
  const authorized = authorization.estimate;
  const sameUnknown = estimate.status === "unknown" && authorized?.unknown === true && authorized?.amount == null && authorized?.unit == null;
  const samePending = estimate.status === "pending" && authorized?.unknown !== true && authorized?.amount === estimate.amount && authorized?.unit === estimate.unit;
  return sameUnknown || samePending ? authorization : null;
}

export function createProviderExecutionRouter({ registry, connectionStore, lovartOrchestrator, genericConnectorFactory, workbenchService, artifactTransfer = null, credentialService = null, credentialReader = null, adapterRegistry = null } = {}) {
  if (!registry?.resolve || !connectionStore?.get || !workbenchService?.getState || !workbenchService?.updateLiveJob || !workbenchService?.importResult) {
    throw new TypeError("registry, connectionStore, and workbenchService are required");
  }
  if (!lovartOrchestrator?.executePrepared || !lovartOrchestrator?.get || !lovartOrchestrator?.confirm) throw new TypeError("lovartOrchestrator is required");
  if (typeof genericConnectorFactory !== "function") throw new TypeError("genericConnectorFactory is required");

  async function get({ job_id }) {
    if (typeof job_id !== "string" || !job_id) fail("VALIDATION_FAILED", "job_id is required.", { field: "job_id" });
    const result = jobResult(await workbenchService.getState({ include: ["jobs", "artifacts"] }), job_id);
    const connection = result.job.connection_id ? await connectionStore.get(result.job.connection_id) : null;
    const fields = new Set((connection?.provider_descriptor?.credential_fields ?? []).map((field) => field?.id?.toLowerCase()).filter(Boolean));
    return clone(redact(result, fields));
  }

  async function internalJob(job_id) {
    if (typeof job_id !== "string" || !job_id) fail("VALIDATION_FAILED", "job_id is required.", { field: "job_id" });
    return jobResult(await workbenchService.getState({ include: ["jobs", "artifacts"] }), job_id);
  }

  async function readCredential(connection, descriptor) {
    const declared = Array.isArray(descriptor.credential_fields) ? descriptor.credential_fields : [];
    if (!declared.length) return {};
    const reader = credentialReader ?? (credentialService?.read ? (input) => credentialService.read(input) : null);
    if (typeof reader !== "function") fail("CREDENTIAL_SETUP_FAILED", "The selected provider credentials are unavailable.", { provider_id: descriptor.id });
    try {
      const values = await reader({ credential_ref: connection.credential_ref });
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("unavailable");
      const allowed = new Set(declared.map((field) => field.id));
      const output = {};
      for (const field of declared) {
        const value = values[field.id];
        if (field.required && (typeof value !== "string" || !value.trim())) throw new Error("missing");
        if (typeof value === "string" && value.trim()) output[field.id] = value.trim();
      }
      if (Object.keys(values).some((key) => !allowed.has(key))) throw new Error("undeclared");
      return output;
    } catch {
      fail("CREDENTIAL_SETUP_FAILED", "The selected provider credentials are unavailable.", { provider_id: descriptor.id });
    }
  }

  async function resolveModernExecutor(job, frozen, descriptor, connection) {
    if (!adapterRegistry?.get) fail("UPSTREAM_CAPABILITY_UNAVAILABLE", "The selected provider adapter registry is unavailable.", { provider_id: frozen.provider_id });
    if (!Number.isInteger(frozen.connection_config_revision) || connection.config_revision !== frozen.connection_config_revision) {
      fail("CONNECTION_UNAVAILABLE", "The selected provider connection changed after this job was prepared.", { job_id: job.id, provider_id: frozen.provider_id, connection_id: frozen.connection_id });
    }
    if (typeof frozen.adapter_id !== "string" || !frozen.adapter_id || typeof frozen.adapter_version !== "string" || !frozen.adapter_version
      || connection.adapter_id !== frozen.adapter_id || connection.adapter_version !== frozen.adapter_version) {
      fail("CONNECTION_UNAVAILABLE", "The selected provider adapter changed after this job was prepared.", { job_id: job.id, provider_id: frozen.provider_id, connection_id: frozen.connection_id });
    }
    assertFrozenModel(job, frozen, connection);
    const executor = adapterRegistry.get(frozen.adapter_id, frozen.adapter_version);
    if (!executor?.estimateCost || !executor?.submit || !executor?.poll || !executor?.importResults) {
      fail("UPSTREAM_CAPABILITY_UNAVAILABLE", "The selected provider executor is unavailable.", { provider_id: frozen.provider_id });
    }
    return { ...frozen, descriptor, connection, executor, modern: true };
  }

  async function resolve(job) {
    const frozen = frozenProvider(job);
    const resolved = registry.resolve(frozen.provider_id);
    if (frozen.provider_id === "lovart") return { ...frozen, descriptor: resolved.descriptor, executor: lovartOrchestrator, connection: null };
    if (typeof frozen.connection_id !== "string" || !frozen.connection_id) {
      fail("CONNECTION_UNAVAILABLE", "The selected provider connection is missing.", { job_id: job.id, provider_id: frozen.provider_id });
    }
    const connection = await connectionStore.get(frozen.connection_id);
    if (!connection || connection.provider_id !== frozen.provider_id || connection.enabled !== true
      || (connection.legacy !== true && connection.status !== "connected")) {
      fail("CONNECTION_UNAVAILABLE", "The selected provider connection is unavailable.", { job_id: job.id, provider_id: frozen.provider_id, connection_id: frozen.connection_id });
    }
    if (!Number.isInteger(frozen.connection_config_revision) || connection.config_revision !== frozen.connection_config_revision) {
      fail("CONNECTION_UNAVAILABLE", "The selected provider connection changed after this job was prepared.", { job_id: job.id, provider_id: frozen.provider_id, connection_id: frozen.connection_id });
    }
    if (connection.legacy !== true) return resolveModernExecutor(job, frozen, resolved.descriptor, connection);
    if (resolved.descriptor.kind !== "generic_rest") {
      fail("UPSTREAM_CAPABILITY_UNAVAILABLE", "The selected legacy provider cannot be executed as generic REST.", { provider_id: frozen.provider_id });
    }
    const executor = genericConnectorFactory({ descriptor: resolved.descriptor, connection: clone(connection) });
    if (!executor?.submit || !executor?.poll || !executor?.importResults) {
      fail("UPSTREAM_CAPABILITY_UNAVAILABLE", "The selected provider executor is unavailable.", { provider_id: frozen.provider_id });
    }
    return { ...frozen, descriptor: resolved.descriptor, connection, executor, modern: false };
  }

  async function move(job, next_status, source, message, progress = null, extra = {}) {
    return (await workbenchService.updateLiveJob({
      job_id: job.id,
      expected_status: job.status,
      next_status,
      attempt: job.attempt,
      source,
      status_message: message,
      progress,
      ...extra,
    })).job;
  }

  async function reportProgress(job, descriptor, update, onProgress) {
    const progress = publicProgress(update);
    if (!progress) return job;
    let current = job;
    const target = progress.stage === "uploading" ? "uploading" : progress.stage === "submitted" ? "submitted" : "generating";
    if (current.status === target) {
      current = (await workbenchService.updateLiveJobProgress({
        job_id: current.id,
        expected_status: current.status,
        attempt: current.attempt,
        source: PROVIDER_SOURCES[target],
        status_message: statusMessage(descriptor, progress.stage),
        progress: { phase: progress.stage, ...(progress.progress === undefined ? {} : { percent: progress.progress }) },
      })).job;
    }
    if (typeof onProgress === "function") await onProgress({ phase: progress.stage, status: current.status, ...(progress.progress === undefined ? {} : { progress: progress.progress }) });
    return current;
  }

  async function importArtifacts(job, descriptor, executor, connection, credential, result, task_id, onProgress) {
    const imported = await executor.importResults({ connection, credential, snapshot: clone(job.snapshot), attachments: clone(job.snapshot?.attachments ?? []), task_id, result, onProgress: () => undefined });
    const rawArtifacts = imported?.artifacts;
    if (!Array.isArray(rawArtifacts) || !rawArtifacts.length) fail("UPSTREAM_SCHEMA_UNRECOGNIZED", "The provider returned no importable artifacts.", { provider_id: descriptor.id });
    const transferred = artifactTransfer?.downloadResults
      ? await artifactTransfer.downloadResults({ job_id: job.id, result: { artifacts: rawArtifacts }, provider_id: descriptor.id })
      : { artifacts: rawArtifacts };
    const preserved = preserveArtifactCardinality(rawArtifacts, transferred?.artifacts);
    const completion = await workbenchService.importResult({ job_id: job.id, artifacts: preserved, idempotency_key: `${job.id}:provider:${job.attempt}:import` });
    if (typeof onProgress === "function") await onProgress({ phase: "completed", status: completion.job.status, message: statusMessage(descriptor, "completed") });
    return { job: completion.job, artifacts: completion.results.filter((item) => item.ok).map((item) => item.artifact), results: completion.results };
  }

  async function executeGeneric(job, target, onProgress, { explicitRetry = false } = {}) {
    let current = job;
    const deferredStageProgress = new Map();
    const progress = async (update) => {
      const received = publicProgress(update);
      const targetStatus = received?.stage === "uploading" ? "uploading" : received?.stage === "submitted" ? "submitted" : received?.stage === "generating" ? "generating" : null;
      if (received && targetStatus !== current.status) deferredStageProgress.set(received.stage, received);
      current = await reportProgress(current, target.descriptor, update, onProgress);
    };
    try {
      if (current.status === "queued_for_agent") current = await move(current, "uploading", PROVIDER_SOURCES.uploading, statusMessage(target.descriptor, "uploading"), { phase: "uploading" });
      const credential = await readCredential(target.connection, target.descriptor);
      const request = {
        connection: target.connection,
        credential,
        snapshot: providerRequestSnapshot(current.snapshot),
        attachments: clone(current.snapshot?.attachments ?? []),
        onProgress: progress,
      };
      if (supportsIdempotentSubmit(target)) {
        request.idempotency_key = current.idempotency_key;
        request.snapshot_digest = digest(current.snapshot);
      }
      if (current.status === "uploading") {
        if (current.retry_state === "manual" && !explicitRetry) {
          fail("STATUS_CONFLICT", "This provider submission needs an explicit retry because the provider does not declare idempotent submit support.", { job_id: current.id, provider_id: target.provider_id });
        }
        if (target.modern) {
          const estimate = normalizeModernEstimate(await target.executor.estimateCost(request));
          const authorization = assertModernCostAuthorization(current, estimate);
          if (estimate.status !== "known_free" && !authorization) {
            const waiting = await workbenchService.awaitProviderCostDecision({ job_id: current.id, attempt: current.attempt, estimate, resume_status: "uploading" });
            return { ...(await get({ job_id: waiting.job.id })), results: [] };
          }
          if (authorization) {
            current = (await workbenchService.consumeProviderCostAuthorization({
              job_id: current.id, attempt: current.attempt, cost_fingerprint: authorization.cost_fingerprint, decision_id: authorization.decision_id,
            })).job;
          }
        }
        const submitted = await target.executor.submit(request);
        const submittedProgress = deferredStageProgress.get("submitted");
        current = await move(current, "submitted", PROVIDER_SOURCES.submitted, statusMessage(target.descriptor, "submitted"), {
          phase: "submitted",
          ...(submittedProgress?.progress === undefined ? {} : { percent: submittedProgress.progress }),
        }, submitted?.task_id ? { provider_task_id: submitted.task_id } : {});
        const cost = providerCost(submitted);
        if (!target.modern && cost.status !== "known_free") {
          current = await move(current, "awaiting_cost_confirmation", PROVIDER_SOURCES.generating, `${target.descriptor.display_name || target.descriptor.id} 返回了费用确认。`, { phase: "awaiting_cost_confirmation" }, {
            estimated_cost: cost.status === "unknown" ? { amount: null, unit: null, unknown: true } : { amount: cost.amount, unit: cost.unit },
            source_checked_at: new Date().toISOString(),
            provider_cost: cost,
          });
          return { ...(await get({ job_id: current.id })), results: [] };
        }
        if (submitted?.status === "succeeded") {
          current = await move(current, "generating", PROVIDER_SOURCES.generating, statusMessage(target.descriptor, "generating"), { phase: "generating" }, { provider_cost: cost });
          return importArtifacts(current, target.descriptor, target.executor, target.connection, credential, submitted.result, submitted.task_id, onProgress);
        }
        current = await move(current, "generating", PROVIDER_SOURCES.generating, statusMessage(target.descriptor, "generating"), { phase: "generating" }, { provider_cost: cost });
        const polled = await target.executor.poll({ ...request, task_id: submitted?.task_id, onProgress: progress });
        return importArtifacts(current, target.descriptor, target.executor, target.connection, credential, polled.result, polled.task_id ?? submitted?.task_id, onProgress);
      }
      if (current.status === "submitted" || current.status === "generating") {
        const task_id = current.provider_task_id ?? current.snapshot?.provider_task_id;
        if (!task_id) fail("STATUS_CONFLICT", "The provider job cannot resume without its provider task id.", { job_id: current.id });
        if (current.status === "submitted") current = await move(current, "generating", PROVIDER_SOURCES.generating, statusMessage(target.descriptor, "generating"), { phase: "generating" });
        const polled = await target.executor.poll({ ...request, task_id, onProgress: progress });
        return importArtifacts(current, target.descriptor, target.executor, target.connection, credential, polled.result, polled.task_id ?? task_id, onProgress);
      }
      return { ...(await get({ job_id: current.id })), results: [] };
    } catch (error) {
      const ambiguous = current.status === "uploading" && ["UPSTREAM_UNAVAILABLE", "REQUEST_TIMEOUT"].includes(error?.code);
      const pollUnavailable = ["submitted", "generating"].includes(current.status)
        && Boolean(current.provider_task_id)
        && ["UPSTREAM_UNAVAILABLE", "UPSTREAM_RATE_LIMITED", "REQUEST_TIMEOUT"].includes(error?.code);
      const localGuard = error instanceof DomainError && ["STATUS_CONFLICT", "COST_CONFIRMATION_REQUIRED", "CREDENTIAL_SETUP_FAILED", "VALIDATION_FAILED"].includes(error.code);
      if (ambiguous) {
        try {
          const idempotent = supportsIdempotentSubmit(target);
          await workbenchService.updateLiveJobProgress({
            job_id: current.id,
            expected_status: current.status,
            attempt: current.attempt,
            source: PROVIDER_SOURCES.uploading,
            status_message: idempotent
              ? "提交结果暂未确认，将使用同一幂等键安全重试。"
              : "提交结果暂未确认。此提供方不支持幂等提交，请明确重试或先查询任务状态。",
            progress: { phase: "uploading", retryable: true, manual_retry_required: !idempotent },
            retry_state: idempotent ? "automatic" : "manual",
          });
        } catch { /* retain the original transport result */ }
      } else if (pollUnavailable) {
        try {
          await workbenchService.updateLiveJobProgress({
            job_id: current.id,
            expected_status: current.status,
            attempt: current.attempt,
            source: PROVIDER_SOURCES.generating,
            status_message: "暂时无法查询提供方状态；任务标识已保存，将继续安全轮询。",
            progress: { phase: "generating", retryable: true },
            retry_state: "automatic",
          });
        } catch { /* retain the original transport result */ }
      } else if (!localGuard && ["uploading", "submitted", "generating"].includes(current.status)) {
        try {
          await move(current, "failed", PROVIDER_SOURCES.generating, `${target.descriptor.display_name || target.descriptor.id} 处理失败。`, { phase: "failed" });
        } catch { /* keep the original provider error */ }
      }
      throw safeProviderError(error, target.descriptor.id);
    }
  }

  async function executePrepared({ job_id, snapshot_digest, onProgress, retry = false } = {}) {
    const current = await internalJob(job_id);
    const job = current.job;
    if (snapshot_digest != null && snapshot_digest !== digest(job.snapshot)) {
      fail("IDEMPOTENCY_CONFLICT", "The supplied snapshot digest does not match the immutable job snapshot.", { job_id });
    }
    if (TERMINAL_STATUSES.has(job.status)) return { ...current, results: [] };
    const target = await resolve(job); // Resolve before any provider transport; there is deliberately no fallback.
    if (target.provider_id === "lovart") return lovartOrchestrator.executePrepared({ job_id: job.id }, { onProgress });
    return executeGeneric(job, target, onProgress, { explicitRetry: retry === true });
  }

  async function confirm({ job_id, attempt, cost_fingerprint, decision_id, onProgress } = {}) {
    const current = await internalJob(job_id);
    const target = await resolve(current.job);
    if (target.provider_id === "lovart") {
      return lovartOrchestrator.confirm({ job_id, attempt, cost_fingerprint, decision_id }, { onProgress });
    }
    const job = current.job;
    if (target.modern) {
      if (job.status !== "awaiting_cost_confirmation" || job.attempt !== attempt) {
        fail("COST_CONFIRMATION_CONFLICT", "The selected provider job is not awaiting this confirmation.", { job_id, provider_id: target.provider_id });
      }
      if (typeof workbenchService.authorizeProviderCostAndResume !== "function") {
        fail("COST_CONFIRMATION_CONFLICT", "The workbench cannot authorize this provider cost decision.", { job_id, provider_id: target.provider_id });
      }
      const resumed = await workbenchService.authorizeProviderCostAndResume({ job_id, attempt, cost_fingerprint, decision_id, resume_status: "uploading" });
      return executeGeneric(resumed.job, target, onProgress);
    }
    if (job.status !== "awaiting_cost_confirmation" || job.attempt !== attempt) {
      fail("COST_CONFIRMATION_CONFLICT", "The selected provider job is not awaiting this confirmation.", { job_id, provider_id: target.provider_id });
    }
    if (job.estimated_cost?.unknown === true && !supportsUnknownCostConfirmation(target.executor)) {
      fail("COST_CONFIRMATION_REQUIRED", "The provider cannot confirm or refresh an unknown cost. Decline the job or select a provider that supports confirmation.", { job_id, provider_id: target.provider_id });
    }
    if (job.estimated_cost?.unknown === true) {
      if (typeof workbenchService.reserveCostDecisionConfirmation !== "function" || typeof workbenchService.verifyCostDecisionConfirmationLease !== "function" || typeof workbenchService.releaseCostDecisionConfirmation !== "function") {
        fail("COST_CONFIRMATION_CONFLICT", "The workbench cannot reserve the pending cost decision.", { job_id, provider_id: target.provider_id });
      }
      const reservation = await workbenchService.reserveCostDecisionConfirmation({ decision_id, job_id, attempt, cost_fingerprint });
      const lease_id = reservation.lease_id;
      let refreshed = false;
      try {
        await workbenchService.verifyCostDecisionConfirmationLease({ decision_id, job_id, attempt, cost_fingerprint, lease_id });
        const credential = await readCredential(target.connection, target.descriptor);
        await workbenchService.verifyCostDecisionConfirmationLease({ decision_id, job_id, attempt, cost_fingerprint, lease_id });
      const request = {
        connection: target.connection,
        credential,
        snapshot: clone(job.snapshot),
        attachments: clone(job.snapshot?.attachments ?? []),
        task_id: job.provider_task_id,
        decision_id,
      };
      if (supportsIdempotentSubmit(target)) {
        request.idempotency_key = job.idempotency_key;
        request.snapshot_digest = digest(job.snapshot);
      }
        const usedConfirmOperation = typeof target.executor.confirm === "function";
        const confirmation = usedConfirmOperation
          ? await target.executor.confirm(request)
          : await target.executor.refreshCost(request);
        await workbenchService.verifyCostDecisionConfirmationLease({ decision_id, job_id, attempt, cost_fingerprint, lease_id });
        if (usedConfirmOperation) {
          const committed = await workbenchService.commitCostDecisionConfirmation({
            decision_id,
            job_id,
            attempt,
            cost_fingerprint,
            lease_id,
            source: PROVIDER_SOURCES.confirming,
            status_message: statusMessage(target.descriptor, "generating"),
            progress: { phase: "generating" },
          });
          refreshed = true;
          return executeGeneric(committed.job, target, onProgress);
        }
        const nextCost = providerCost(confirmation);
        await workbenchService.refreshAwaitingCost({
          job_id,
          attempt,
          decision_id,
          cost_fingerprint,
          lease_id,
          estimated_cost: nextCost.status === "unknown"
            ? { amount: null, unit: null, unknown: true }
            : { amount: nextCost.amount, unit: nextCost.unit },
          source: PROVIDER_SOURCES.confirming,
          source_checked_at: new Date().toISOString(),
        });
        refreshed = true;
        // Refreshing changes the immutable fingerprint. The user must approve
        // that newly sourced value in a separate decision; do not auto-confirm.
        return { ...(await get({ job_id })), results: [] };
      } catch (error) {
        if (!refreshed) {
          try { await workbenchService.releaseCostDecisionConfirmation({ decision_id, job_id, attempt, cost_fingerprint, lease_id }); } catch { /* preserve the primary provider/lease error */ }
        }
        if (error instanceof DomainError && ["COST_CONFIRMATION_CONFLICT", "CREDENTIAL_SETUP_FAILED", "VALIDATION_FAILED"].includes(error.code)) throw error;
        throw safeProviderError(error, target.provider_id);
      }
    }
    const committed = await workbenchService.commitCostDecisionConfirmation({
      decision_id,
      job_id,
      attempt,
      cost_fingerprint,
      source: PROVIDER_SOURCES.confirming,
      status_message: statusMessage(target.descriptor, "generating"),
      progress: { phase: "generating" },
    });
    const generating = committed.job;
    return executeGeneric(generating, target, onProgress);
  }

  return Object.freeze({ executePrepared, get, confirm });
}
