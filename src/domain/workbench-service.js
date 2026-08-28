import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { JsonStore } from "../persistence/json-store.js";
import { createCostFingerprint } from "./cost-confirmation.js";
import { DomainError } from "./errors.js";
import { assertContinuationParent, normalizeLovartProjectLocator } from "./lovart-project-context.js";
import { MODEL_CAPABILITIES, assertProviderModelCapability } from "./model-capabilities.js";
import { normalizeWorkbenchModel } from "../lovart/model-selection.js";
import { modelRecordDigest } from "../providers/model-catalog.js";
import { assertLiveSource, assertM5Source, isAllowedM5Source } from "./source-policy.js";
import { assertExpiryAtOrAfterChecked, assertSourceCheckedAt } from "./timestamps.js";

export { DomainError } from "./errors.js";

const ALLOWED_PATCH_FIELDS = new Set([
  "mode",
  "model",
  "provider_id",
  "connection_id",
  "prompt.text",
  "prompt.tokens",
  "reference_ids",
  "settings.generation_mode",
  "settings.ratio",
  "settings.resolution",
  "settings.duration_seconds",
  "settings.count",
  "settings.audio",
  "settings.advanced",
]);

const JOB_TRANSITIONS = new Map([
  ["queued_for_agent", new Set(["uploading", "cancelled"])],
  ["uploading", new Set(["submitted", "awaiting_cost_confirmation", "failed", "cancelled"])],
  ["submitted", new Set(["awaiting_cost_confirmation", "generating", "failed", "cancelled"])],
  ["awaiting_cost_confirmation", new Set(["generating", "declined", "cancelled"])],
  ["generating", new Set(["succeeded", "partially_succeeded", "failed", "cancelled"])],
]);

const JOB_STATUS_MESSAGES = Object.freeze({
  queued_for_agent: "任务已保存，等待会话桥发送到当前 Codex 会话。",
  uploading: "Codex 已收到，正在准备并上传素材到 Lovart。",
  submitted: "已提交 Lovart，正在处理中。",
  awaiting_cost_confirmation: "Lovart 返回了费用确认，等待你的决定。",
  generating: "Lovart 正在生成，状态会持续同步。",
  succeeded: "Lovart 已完成生成。",
  partially_succeeded: "Lovart 已部分完成生成。",
  failed: "Lovart 处理失败。",
  cancelled: "任务已取消。",
  declined: "费用确认已拒绝。",
});

const PROVIDER_LIVE_SOURCES = new Set([
  "imvia:provider_upload",
  "imvia:provider_submit",
  "imvia:provider_status",
  "imvia:provider_import",
  "imvia:provider_confirm",
]);
const SECRET_FIELD_NAME = /^(?:credential(?:_|$)|secret(?:_?key)?$|password$|api[_-]?key$|access[_-]?key$|private[_-]?key$|authorization$|bearer(?:_?token)?$|token$|session[_-]?cookie$)/i;

function sanitizeSnapshot(value, secretFieldIds = new Set(), path = "snapshot") {
  if (Array.isArray(value)) return value.map((item, index) => sanitizeSnapshot(item, secretFieldIds, `${path}.${index}`));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_NAME.test(key) || secretFieldIds.has(key.toLowerCase())) continue;
    output[key] = sanitizeSnapshot(item, secretFieldIds, `${path}.${key}`);
  }
  return output;
}

function serializeSelectedModel(model) {
  return {
    id: model.id,
    display_name: model.display_name,
    capabilities: [...model.capabilities],
    compatibility: model.compatibility,
    source: "api",
    raw_index: model.raw_index,
  };
}

function freezeExternalModelSelection({ providerRegistry, connection, provider_id, model, mode, field = "snapshot.model" }) {
  let selected;
  try {
    selected = assertProviderModelCapability({ providerRegistry, connection, provider_id, model, mode, field });
  } catch (error) {
    throw new DomainError(error.code ?? "VALIDATION_FAILED", error.message, error.details);
  }
  const serialized = serializeSelectedModel(selected);
  return { selected_model: serialized, selected_model_digest: modelRecordDigest(serialized) };
}

function assertExecutionSource(source) {
  if (PROVIDER_LIVE_SOURCES.has(source)) return source;
  return assertLiveSource(source);
}

function isExecutableProviderJob(job) {
  return job.direct_generation === true
    || (job.submission_kind === "workbench_generation" && job.snapshot?.provider_id && job.snapshot.provider_id !== "lovart");
}

function statusMessageFor(status) {
  return JOB_STATUS_MESSAGES[status] || "任务状态已更新。";
}

function normalizeStatusMessage(value, fallbackStatus) {
  if (typeof value !== "string" || !value.trim()) return statusMessageFor(fallbackStatus);
  return value.trim().slice(0, 256);
}

function normalizeProgress(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", "progress must be an object.", { field: "progress" });
  }
  return clone(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  return JSON.stringify(value);
}

function isoNow() {
  return new Date().toISOString();
}

function createDefaultAccountStatus() {
  return {
    availability: "unavailable",
    billing_mode: null,
    credit_balance: null,
    credit_unit: null,
    balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
    source_tool: null,
    checked_at: null,
    expires_at: null,
  };
}

function createInitialState() {
  const now = isoNow();
  const projectId = randomUUID();
  const draftId = randomUUID();
  return {
    schema_version: "2",
    created_at: now,
    updated_at: now,
    current_project_id: projectId,
    projects: [{
      id: projectId,
      name: "未命名项目",
      active_draft_id: draftId,
      lovart_project_id: null,
      archived: false,
      created_at: now,
      updated_at: now,
    }],
    drafts: [{
      id: draftId,
      project_id: projectId,
      revision: 0,
      mode: "video",
      model: null,
      provider_id: "lovart",
      connection_id: null,
      prompt: { text: "", tokens: [] },
      reference_ids: [],
      settings: {
        generation_mode: null,
        ratio: "16:9",
        resolution: null,
        duration_seconds: null,
        count: 1,
        audio: false,
        advanced: {},
      },
      created_at: now,
      updated_at: now,
    }],
    references: [],
    lovart_projects: [],
    active_lovart_project_id: null,
    jobs: [],
    artifacts: [],
    idempotency: {},
    audit_events: [],
    account_status: createDefaultAccountStatus(),
  };
}

function migrateWorkbenchState(state) {
  if (state?.schema_version === "2") {
    const migrated = clone(state);
    migrated.lovart_projects ??= [];
    migrated.active_lovart_project_id ??= null;
    const hadStatusMetadata = (state.jobs ?? []).every((job) => Object.hasOwn(job, "status_message") && Object.hasOwn(job, "progress"));
    let changed = !Array.isArray(state.lovart_projects) || !Object.hasOwn(state, "active_lovart_project_id") || !hadStatusMetadata;
    for (const draft of migrated.drafts ?? []) {
      if (!draft.provider_id) {
        draft.provider_id = "lovart";
        changed = true;
      }
      if (!Object.hasOwn(draft, "connection_id")) {
        draft.connection_id = null;
        changed = true;
      }
    }
    for (const job of migrated.jobs ?? []) {
      job.snapshot ??= {};
      const sanitizedSnapshot = sanitizeSnapshot(job.snapshot);
      if (stableJson(sanitizedSnapshot) !== stableJson(job.snapshot)) {
        job.snapshot = sanitizedSnapshot;
        changed = true;
      }
      if (!job.provider_id) {
        job.provider_id = job.snapshot.provider_id ?? "lovart";
        changed = true;
      }
      if (!job.snapshot.provider_id) {
        job.snapshot.provider_id = job.provider_id;
        changed = true;
      }
      if (!Object.hasOwn(job, "connection_id")) {
        job.connection_id = job.snapshot.connection_id ?? null;
        changed = true;
      }
      if (!Object.hasOwn(job.snapshot, "connection_id")) {
        job.snapshot.connection_id = job.connection_id;
        changed = true;
      }
      if (!Object.hasOwn(job.snapshot, "connection_config_revision")) {
        job.snapshot.connection_config_revision = null;
        changed = true;
      }
      for (const field of ["model_catalog_revision", "model_catalog_digest", "adapter_id", "adapter_version", "selected_model", "selected_model_digest"]) {
        if (!Object.hasOwn(job.snapshot, field)) {
          job.snapshot[field] = null;
          changed = true;
        }
      }
      if (!job.status_message || (job.status === "queued_for_agent" && ["已发送给 Codex，等待处理。", "已进入 Codex 会话桥，等待 Codex 接收。"].includes(job.status_message))) {
        job.status_message = statusMessageFor(job.status);
        changed = true;
      }
      job.progress ??= null;
    }
    return { state: migrated, changed };
  }
  if (state?.schema_version !== "1") {
    throw new DomainError("STATE_MIGRATION_FAILED", "The local workbench state schema is unsupported.", { schema_version: state?.schema_version ?? null });
  }
  const migrated = clone(state);
  const projects = [];
  for (const localProject of migrated.projects ?? []) {
    if (typeof localProject?.lovart_project_id !== "string" || !localProject.lovart_project_id.trim()) continue;
    const normalized = normalizeLovartProjectLocator(localProject.lovart_project_id);
    if (!projects.some((project) => project.project_id === normalized.project_id)) {
      projects.push({
        project_id: normalized.project_id,
        name: typeof localProject.name === "string" && localProject.name.trim() ? localProject.name.trim() : null,
        canvas_url: normalized.canvas_url,
        source: "legacy_migration",
        created_at: localProject.created_at ?? isoNow(),
        last_used_at: localProject.updated_at ?? localProject.created_at ?? isoNow(),
      });
    }
  }
  const currentLocalProject = migrated.projects?.find((project) => project.id === migrated.current_project_id);
  const active = typeof currentLocalProject?.lovart_project_id === "string" && currentLocalProject.lovart_project_id.trim()
    ? normalizeLovartProjectLocator(currentLocalProject.lovart_project_id).project_id
    : projects[0]?.project_id ?? null;
  migrated.schema_version = "2";
  migrated.lovart_projects = projects;
  migrated.active_lovart_project_id = active;
  for (const draft of migrated.drafts ?? []) {
    draft.provider_id ??= "lovart";
    draft.connection_id ??= null;
  }
  for (const job of migrated.jobs ?? []) {
    job.snapshot ??= {};
    job.snapshot = sanitizeSnapshot(job.snapshot);
    job.provider_id ??= job.snapshot.provider_id ?? "lovart";
    job.connection_id ??= job.snapshot.connection_id ?? null;
    job.snapshot.provider_id ??= job.provider_id;
    job.snapshot.connection_id ??= job.connection_id;
    job.snapshot.connection_config_revision ??= null;
    job.status_message ??= statusMessageFor(job.status);
    job.progress ??= null;
  }
  migrated.updated_at = isoNow();
  return { state: migrated, changed: true };
}

function currentProject(state) {
  const project = state.projects.find((item) => item.id === state.current_project_id);
  if (!project) throw new DomainError("STORE_UNAVAILABLE", "The active local project is unavailable.");
  return project;
}

function findDraft(state, draftId) {
  const draft = state.drafts.find((item) => item.id === draftId);
  if (!draft) throw new DomainError("NOT_FOUND", "The requested draft does not exist.", { draft_id: draftId });
  return draft;
}

function findJob(state, jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) throw new DomainError("NOT_FOUND", "The requested job does not exist.", { job_id: jobId });
  return job;
}

function findArtifact(state, artifactId) {
  return state.artifacts.find((item) => item.id === artifactId);
}

function costFingerprintForJob(job) {
  if (!job.estimated_cost) {
    throw new DomainError("COST_CONFIRMATION_CONFLICT", "The job has no current sourced cost.", { job_id: job.id, attempt: job.attempt });
  }
  return createCostFingerprint({
    job_id: job.id,
    attempt: job.attempt,
    amount: job.estimated_cost.amount,
    unit: job.estimated_cost.unit,
    checked_at: job.estimated_cost.checked_at,
    source: job.estimated_cost.source,
    unknown: job.estimated_cost.unknown === true,
    provider_id: job.provider_id ?? job.snapshot?.provider_id ?? null,
  });
}

function assertCurrentCost(job, { attempt, cost_fingerprint }) {
  const actual = costFingerprintForJob(job);
  if (job.status !== "awaiting_cost_confirmation" || job.attempt !== attempt || actual !== cost_fingerprint) {
    throw new DomainError("COST_CONFIRMATION_CONFLICT", "The cost decision does not match the current waiting job.", {
      job_id: job.id,
      current_status: job.status,
      current_attempt: job.attempt,
    });
  }
  return actual;
}

function isFixtureSource(source) {
  return isAllowedM5Source(source) && (source.startsWith("fixture:") || source.startsWith("mock_lovart:") || source === "imvia:mock_agent");
}

function assertFixtureSource(source, { field = "source" } = {}) {
  assertM5Source(source, { field });
  if (!isFixtureSource(source)) {
    throw new DomainError("VALIDATION_FAILED", "Fixture evidence must use a fixture or mock_lovart source.", { field, source });
  }
  return source;
}

function iterationIndexForParent(job) {
  if (!("iteration_index" in job)) return 0;
  if (!Number.isInteger(job.iteration_index) || job.iteration_index < 0) {
    throw new DomainError("VALIDATION_FAILED", "Stored parent iteration_index must be a non-negative integer.", { field: "iteration_index", job_id: job.id });
  }
  return job.iteration_index;
}

function claimedDecisionForConfirmation(job, { cost_decision_id }) {
  const fingerprint = costFingerprintForJob(job);
  const claimed = (job.cost_decisions ?? []).find((item) => item.decision_id === cost_decision_id);
  if (
    !claimed
    || claimed.decision !== "accepted"
    || claimed.consumed_at == null
    || claimed.cost_fingerprint !== fingerprint
    || claimed.confirmation != null
  ) {
    throw new DomainError("COST_CONFIRMATION_CONFLICT", "The claimed cost decision cannot authorize this confirmation result.", {
      job_id: job.id,
      attempt: job.attempt,
      decision_id: cost_decision_id,
    });
  }
  return claimed;
}

function setPath(target, field, value) {
  const segments = field.split(".");
  let parent = target;
  for (const segment of segments.slice(0, -1)) parent = parent[segment];
  parent[segments.at(-1)] = clone(value);
}

function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new DomainError("VALIDATION_FAILED", "patch must be an object.");
  }
  const fields = Object.keys(patch);
  if (!fields.length) throw new DomainError("VALIDATION_FAILED", "patch must include at least one supported field.");
  for (const field of fields) {
    if (!ALLOWED_PATCH_FIELDS.has(field)) {
      throw new DomainError("VALIDATION_FAILED", `Unsupported patch field: ${field}`, { field });
    }
  }
  if ("prompt.text" in patch && typeof patch["prompt.text"] !== "string") {
    throw new DomainError("VALIDATION_FAILED", "prompt.text must be a string.", { field: "prompt.text" });
  }
  if ("provider_id" in patch && (typeof patch.provider_id !== "string" || !patch.provider_id.trim())) {
    throw new DomainError("VALIDATION_FAILED", "provider_id must be a non-empty string.", { field: "provider_id" });
  }
  if ("connection_id" in patch && patch.connection_id !== null && (typeof patch.connection_id !== "string" || !patch.connection_id.trim())) {
    throw new DomainError("VALIDATION_FAILED", "connection_id must be null or a non-empty string.", { field: "connection_id" });
  }
  if ("settings.duration_seconds" in patch && patch["settings.duration_seconds"] !== null && (!Number.isInteger(patch["settings.duration_seconds"]) || patch["settings.duration_seconds"] <= 0)) {
    throw new DomainError("VALIDATION_FAILED", "settings.duration_seconds must be a positive integer.", { field: "settings.duration_seconds" });
  }
}

function validateDraftForPreparation(state, draft, { providerRegistry = null } = {}) {
  const providerId = draft.provider_id ?? "lovart";
  // External selections are validated against the enabled connection's immutable
  // catalog below in freezeProviderSelection. Draft validation cannot safely use
  // provider descriptor models because those are only legacy defaults.
  if (draft.model && providerId === "lovart") {
    try { assertProviderModelCapability({ providerRegistry, provider_id: providerId, model: draft.model, mode: draft.mode }); }
    catch (error) { throw new DomainError(error.code ?? "VALIDATION_FAILED", error.message, error.details); }
    const capability = providerId === "lovart" ? MODEL_CAPABILITIES.get(draft.model) : null;
    if (draft.settings.duration_seconds != null && capability?.durations && !capability.durations.includes(draft.settings.duration_seconds)) {
      throw new DomainError("VALIDATION_FAILED", "The selected model does not support the requested duration.", {
        field: "settings.duration_seconds",
        model: draft.model,
        value: draft.settings.duration_seconds,
        supported: capability.durations,
      });
    }
  }

  const projectReferences = new Map(state.references.filter((reference) => reference.project_id === draft.project_id).map((reference) => [reference.id, reference]));
  const tokens = Array.isArray(draft.prompt.tokens) ? draft.prompt.tokens : [];
  const tokenDisplays = new Set();
  for (const token of tokens) {
    const reference = projectReferences.get(token.reference_id);
    if (!reference || reference.status !== "ready" || !draft.reference_ids.includes(token.reference_id)) {
      throw new DomainError("REFERENCE_BROKEN", "A prompt reference cannot be resolved to a ready local asset.", {
        field: "prompt.tokens",
        reference_id: token.reference_id,
        display: token.display,
      });
    }
    tokenDisplays.add(`@${token.display}`);
  }
  for (const display of draft.prompt.text.match(/@(图片|视频|音频)\d+/g) || []) {
    if (!tokenDisplays.has(display)) {
      throw new DomainError("REFERENCE_BROKEN", "A displayed prompt reference has no stable token.", { field: "prompt.text", display });
    }
  }
  return { warnings: [] };
}

function normalizeWorkbenchCountSettings(mode, value) {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {};
  if (mode !== "image") return settings;
  const countMode = settings.count_mode;
  const count = settings.count;
  if (countMode == null) {
    if (count == null) return { ...settings, count_mode: "auto", count: null };
    if (!Number.isInteger(count) || count <= 0) {
      throw new DomainError("VALIDATION_FAILED", "snapshot.settings.count must be a positive integer for a fixed image count.", { field: "snapshot.settings.count" });
    }
    return { ...settings, count_mode: "fixed", count };
  }
  if (countMode === "auto") {
    if (count != null) {
      throw new DomainError("VALIDATION_FAILED", "An Auto image count cannot also force a numeric count.", { field: "snapshot.settings.count" });
    }
    return { ...settings, count_mode: "auto", count: null };
  }
  if (countMode === "fixed") {
    if (!Number.isInteger(count) || count <= 0) {
      throw new DomainError("VALIDATION_FAILED", "snapshot.settings.count must be a positive integer for a fixed image count.", { field: "snapshot.settings.count" });
    }
    return { ...settings, count_mode: "fixed", count };
  }
  throw new DomainError("VALIDATION_FAILED", "snapshot.settings.count_mode must be auto or fixed.", { field: "snapshot.settings.count_mode" });
}

function publish(listeners, event) {
  for (const listener of listeners) listener(clone(event));
}

function statusConflict(job, message, details = {}) {
  return new DomainError("STATUS_CONFLICT", message, { current_status: job.status, attempt: job.attempt, ...details });
}

function summarize(state, { include = [] } = {}) {
  const project = currentProject(state);
  const draft = findDraft(state, project.active_draft_id);
  const response = {
    schema_version: state.schema_version,
    active_lovart_project_id: state.active_lovart_project_id ?? null,
    lovart_projects: clone(state.lovart_projects ?? []),
    project: clone(project),
    projects: clone(state.projects),
    draft: clone(draft),
    references: clone(state.references.filter((reference) => reference.project_id === project.id)),
  };
  if (include.includes("jobs")) response.jobs = clone(state.jobs.filter((job) => job.project_id === project.id));
  if (include.includes("artifacts")) response.artifacts = clone(state.artifacts);
  return response;
}

export function createWorkbenchService({ dataDirectory, providerRegistry = null, connectionStore = null } = {}) {
  if (!dataDirectory) throw new Error("dataDirectory is required.");
  const store = new JsonStore({ dataDirectory, createInitialState, migrateState: migrateWorkbenchState });
  const listeners = new Set();

  async function freezeProviderSelection(snapshot) {
    const provider_id = typeof snapshot.provider_id === "string" && snapshot.provider_id.trim()
      ? snapshot.provider_id.trim()
      : "lovart";
    const connection_id = snapshot.connection_id ?? null;
    if (provider_id === "lovart") {
      if (connection_id !== null) {
        throw new DomainError("VALIDATION_FAILED", "Lovart jobs do not use a generic provider connection.", { field: "connection_id" });
      }
      return {
        provider_id, provider_label: "Lovart", connection_id: null, connection_config_revision: null,
        model_catalog_revision: null, model_catalog_digest: null, adapter_id: null, adapter_version: null,
        selected_model: null, selected_model_digest: null, secret_field_ids: new Set(),
      };
    }
    if (!providerRegistry || !connectionStore?.get) {
      throw new DomainError("VALIDATION_FAILED", "A provider registry and connection store are required for external providers.", { field: "provider_id", provider_id });
    }
    const descriptor = providerRegistry.get(provider_id);
    if (connection_id === null || typeof connection_id !== "string" || !connection_id.trim()) {
      throw new DomainError("VALIDATION_FAILED", "connection_id is required for an external provider.", { field: "connection_id" });
    }
    const connection = await connectionStore.get(connection_id);
    const usableLegacyConnection = connection?.legacy === true && descriptor.kind === "generic_rest";
    if (!connection || connection.provider_id !== descriptor.id || connection.enabled !== true || (!usableLegacyConnection && connection.status !== "connected")) {
      throw new DomainError("CONNECTION_UNAVAILABLE", "The selected provider connection is unavailable.", { provider_id, connection_id });
    }
    if (typeof snapshot.model !== "string" || !snapshot.model.trim()) {
      throw new DomainError("VALIDATION_FAILED", "An external provider model is required.", { field: "snapshot.model" });
    }
    const frozenModel = usableLegacyConnection
      ? { selected_model: null, selected_model_digest: null }
      : freezeExternalModelSelection({ providerRegistry, connection, provider_id, model: snapshot.model.trim(), mode: snapshot.mode });
    return {
      provider_id,
      provider_label: descriptor.display_name,
      legacy: usableLegacyConnection,
      connection_id: connection.connection_id,
      connection_config_revision: connection.config_revision,
      model_catalog_revision: usableLegacyConnection ? null : connection.model_catalog_revision,
      model_catalog_digest: usableLegacyConnection ? null : connection.model_catalog_digest,
      adapter_id: usableLegacyConnection ? null : connection.adapter_id,
      adapter_version: usableLegacyConnection ? null : connection.adapter_version,
      ...frozenModel,
      secret_field_ids: new Set((connection.provider_descriptor?.credential_fields ?? []).map((field) => field?.id?.toLowerCase()).filter(Boolean)),
    };
  }

  return {
    async getState(options) {
      return summarize(await store.read(), options);
    },

    async renameProject({ project_id, name }) {
      if (typeof project_id !== "string" || !project_id.trim()) {
        throw new DomainError("VALIDATION_FAILED", "project_id is required.", { field: "project_id" });
      }
      if (typeof name !== "string" || !name.trim()) {
        throw new DomainError("VALIDATION_FAILED", "Project name is required.", { field: "name" });
      }
      const normalizedName = name.trim();
      if (normalizedName.length > 120) {
        throw new DomainError("VALIDATION_FAILED", "Project name is too long.", { field: "name", maximum_length: 120 });
      }
      const result = await store.update((state) => {
        const project = state.projects.find((item) => item.id === project_id.trim());
        if (!project) throw new DomainError("NOT_FOUND", "The local project does not exist.", { project_id: project_id.trim() });
        const now = isoNow();
        project.name = normalizedName;
        project.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "workbench_user", reason: "Local project renamed", changed_fields: ["projects.name"] });
        return { project: clone(project) };
      });
      publish(listeners, { type: "project.updated", data: result.project });
      return result;
    },

    async getLovartProjects() {
      const state = await store.read();
      return {
        active_lovart_project_id: state.active_lovart_project_id ?? null,
        projects: clone(state.lovart_projects ?? []),
      };
    },

    async recordLovartProject({ project_id, name = null, canvas_url = null, source = "imvia:project_context" }) {
      const normalized = normalizeLovartProjectLocator(project_id);
      if (canvas_url != null && canvas_url !== normalized.canvas_url) {
        throw new DomainError("INVALID_LOVART_PROJECT_LOCATOR", "canvas_url must match the official Lovart project canvas.", { project_id });
      }
      if (typeof source !== "string" || !source.trim()) throw new DomainError("VALIDATION_FAILED", "source is required.", { field: "source" });
      return store.update((state) => {
        const now = isoNow();
        let project = state.lovart_projects.find((item) => item.project_id === normalized.project_id);
        if (!project) {
          project = {
            project_id: normalized.project_id,
            name: typeof name === "string" && name.trim() ? name.trim() : null,
            canvas_url: normalized.canvas_url,
            source: source.trim(),
            created_at: now,
            last_used_at: null,
          };
          state.lovart_projects.push(project);
        } else {
          if (typeof name === "string" && name.trim()) project.name = name.trim();
          project.canvas_url = normalized.canvas_url;
          project.source = source.trim();
        }
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: source.trim(), reason: "Lovart project recorded", changed_fields: ["lovart_projects"] });
        return { project: clone(project), projects: clone(state.lovart_projects) };
      });
    },

    async setLovartProject({ project_id, name = null, canvas_url = null, source = "imvia:project_context" }) {
      const normalized = normalizeLovartProjectLocator(project_id);
      if (canvas_url != null && canvas_url !== normalized.canvas_url) {
        throw new DomainError("INVALID_LOVART_PROJECT_LOCATOR", "canvas_url must match the official Lovart project canvas.", { project_id });
      }
      if (typeof source !== "string" || !source.trim()) throw new DomainError("VALIDATION_FAILED", "source is required.", { field: "source" });
      return store.update((state) => {
        const now = isoNow();
        let project = state.lovart_projects.find((item) => item.project_id === normalized.project_id);
        if (!project) {
          project = {
            project_id: normalized.project_id,
            name: typeof name === "string" && name.trim() ? name.trim() : null,
            canvas_url: normalized.canvas_url,
            source: source.trim(),
            created_at: now,
            last_used_at: now,
          };
          state.lovart_projects.push(project);
        } else {
          if (typeof name === "string" && name.trim()) project.name = name.trim();
          project.canvas_url = normalized.canvas_url;
          project.source = source.trim();
          project.last_used_at = now;
        }
        state.active_lovart_project_id = normalized.project_id;
        const localProject = currentProject(state);
        localProject.lovart_project_id = normalized.project_id;
        localProject.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: source.trim(), reason: "Lovart project selected", changed_fields: ["active_lovart_project_id", "lovart_projects", "projects.lovart_project_id"] });
        return { active_project: clone(project), projects: clone(state.lovart_projects) };
      });
    },

    async getAccountStatus({ max_age_seconds = 300 } = {}) {
      const state = await store.read();
      const account = clone(state.account_status ?? createDefaultAccountStatus());
      const now = Date.now();
      const checked = account.checked_at == null ? null : Date.parse(account.checked_at);
      const expires = account.expires_at == null ? null : Date.parse(account.expires_at);
      const expired = expires != null && (!Number.isFinite(expires) || expires <= now);
      const tooOld = checked == null || !Number.isFinite(checked) || now - checked > max_age_seconds * 1000;
      return { account_status: account, stale: expired || tooOld };
    },

    async updateAccountStatus(input) {
      const account = {
        availability: input.availability,
        billing_mode: input.billing_mode ?? null,
        credit_balance: input.credit_balance ?? null,
        credit_unit: input.credit_unit ?? null,
        balance_reason: input.balance_reason ?? null,
        source_tool: input.source_tool,
        checked_at: input.checked_at,
        expires_at: input.expires_at ?? null,
      };
      assertM5Source(account.source_tool, { field: "source_tool" });
      if (!["available", "partial", "unavailable"].includes(account.availability)) {
        throw new DomainError("VALIDATION_FAILED", "availability is invalid.", { field: "availability" });
      }
      if (account.billing_mode != null && (typeof account.billing_mode !== "string" || !account.billing_mode)) {
        throw new DomainError("VALIDATION_FAILED", "billing_mode must be null or a non-empty string.", { field: "billing_mode" });
      }
      if (account.credit_balance == null && account.credit_unit != null) {
        throw new DomainError("VALIDATION_FAILED", "credit_unit must be null when balance is unavailable.", { field: "credit_unit" });
      }
      if (account.credit_balance != null && (!Number.isFinite(account.credit_balance) || account.credit_balance < 0 || typeof account.credit_unit !== "string" || !account.credit_unit)) {
        throw new DomainError("VALIDATION_FAILED", "A non-negative balance requires a unit.", { field: "credit_balance" });
      }
      if (account.credit_balance == null && account.balance_reason !== "UPSTREAM_CAPABILITY_UNAVAILABLE") {
        throw new DomainError("VALIDATION_FAILED", "Unavailable balance requires its upstream reason.", { field: "balance_reason" });
      }
      account.checked_at = assertSourceCheckedAt(account.checked_at, { field: "checked_at" });
      account.expires_at = assertExpiryAtOrAfterChecked(account.expires_at, account.checked_at, { field: "expires_at" });
      return store.update((state) => {
        const now = isoNow();
        state.account_status = clone(account);
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: account.source_tool, reason: "Account capability cache updated", changed_fields: ["account_status"] });
        return { account_status: clone(state.account_status) };
      });
    },

    async patchWorkbench({ draft_id, base_revision, actor, reason, patch }) {
      validatePatch(patch);
      if (!Number.isInteger(base_revision) || base_revision < 0) {
        throw new DomainError("VALIDATION_FAILED", "base_revision must be a non-negative integer.");
      }
      if (!actor || !reason) throw new DomainError("VALIDATION_FAILED", "actor and reason are required.");
      const result = await store.update((state) => {
        const draft = findDraft(state, draft_id);
        if (draft.revision !== base_revision) {
          throw new DomainError("REVISION_CONFLICT", "The workbench state changed. Read it again before applying a patch.", {
            current_revision: draft.revision,
          });
        }
        const changedFields = Object.keys(patch);
        for (const [field, value] of Object.entries(patch)) setPath(draft, field, value);
        const now = isoNow();
        draft.revision += 1;
        draft.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor, reason, changed_fields: changedFields });
        return { draft: clone(draft), changed_fields: changedFields };
      });
      const event = { type: "draft.updated", occurred_at: isoNow(), data: { draft_id: result.draft.id, revision: result.draft.revision, changed_fields: result.changed_fields } };
      publish(listeners, event);
      return result;
    },

    async createIteration({ source_job_id, artifact_id, reuse_lovart_thread, instruction }) {
      if (typeof instruction !== "string" || !instruction.trim()) {
        throw new DomainError("VALIDATION_FAILED", "instruction is required.", { field: "instruction" });
      }
      return store.update((state) => {
        const sourceJob = findJob(state, source_job_id);
        if (!["succeeded", "partially_succeeded"].includes(sourceJob.status)) {
          throw statusConflict(sourceJob, "Iterations require a successful or partially successful source job.");
        }
        const artifact = artifact_id == null ? null : findArtifact(state, artifact_id);
        if (artifact_id != null && (!artifact || artifact.job_id !== sourceJob.id)) {
          throw new DomainError("NOT_FOUND", "The selected artifact does not belong to the source job.", { artifact_id, source_job_id });
        }
        const parentIterationIndex = iterationIndexForParent(sourceJob);
        const inheritedThread = reuse_lovart_thread === true ? sourceJob.lovart_thread_id : null;
        const inheritedThreadSource = reuse_lovart_thread === true ? sourceJob.lovart_thread_source : null;
        if (reuse_lovart_thread === true && (!inheritedThread || !isFixtureSource(inheritedThreadSource))) {
          throw new DomainError("VALIDATION_FAILED", "The direct parent has no fixture-sourced reusable thread.", { field: "reuse_lovart_thread" });
        }
        const now = isoNow();
        const draft = clone(sourceJob.snapshot);
        draft.id = randomUUID();
        draft.revision = 0;
        draft.prompt.text = `${sourceJob.snapshot.prompt.text}\n\n迭代要求：${instruction.trim()}`;
        draft.iteration_context = {
          source_job_id,
          artifact_id: artifact?.id ?? null,
          iteration_index: parentIterationIndex + 1,
          reuse_lovart_thread: reuse_lovart_thread === true,
          lovart_thread_id: inheritedThread,
          lovart_thread_source: inheritedThreadSource,
        };
        draft.created_at = now;
        draft.updated_at = now;
        state.drafts.push(draft);
        const project = state.projects.find((item) => item.id === sourceJob.project_id);
        project.active_draft_id = draft.id;
        project.updated_at = now;
        state.current_project_id = sourceJob.project_id;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:create_iteration", reason: "Iteration draft created", changed_fields: ["drafts", "projects.active_draft_id"] });
        return {
          draft: clone(draft),
          parent_job_id: source_job_id,
          iteration_index: draft.iteration_context.iteration_index,
          reusable_thread: { requested: reuse_lovart_thread === true, lovart_thread_id: inheritedThread, source: inheritedThreadSource },
        };
      });
    },

    async createDirectGenerationJob({ snapshot, lovart_project_id, activation_source, idempotency_key }) {
      if (!idempotency_key || typeof idempotency_key !== "string") throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new DomainError("VALIDATION_FAILED", "snapshot must be an object.", { field: "snapshot" });
      const normalized = normalizeLovartProjectLocator(lovart_project_id);
      const activation = typeof activation_source === "string"
        ? { source: assertContinuationParent({ activation_source }).activation_source }
        : clone(activation_source ?? {});
      assertContinuationParent({
        activation_source: activation.source,
        parent_job_id: activation.parent_job_id,
        artifact_id: activation.artifact_id,
      });
      return store.update((state) => {
        const existing = state.idempotency[idempotency_key];
        const comparableActivation = stableJson(activation);
        const safeSnapshot = { ...sanitizeSnapshot(snapshot), provider_id: "lovart", connection_id: null, connection_config_revision: null };
        const comparableSnapshot = stableJson(safeSnapshot);
        if (existing) {
          if (
            existing.operation !== "direct_generation"
            || existing.lovart_project_id !== normalized.project_id
            || existing.activation !== comparableActivation
            || existing.snapshot !== comparableSnapshot
          ) throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different direct-generation request.");
          return { job: clone(findJob(state, existing.job_id)), idempotent: true };
        }
        const now = isoNow();
        const job = {
          id: randomUUID(),
          project_id: currentProject(state).id,
          draft_id: null,
          draft_revision: null,
          snapshot: { ...safeSnapshot, lovart_project_id: normalized.project_id, activation: clone(activation) },
          provider_id: "lovart",
          connection_id: null,
          status: "queued_for_agent",
          attempt: 1,
          idempotency_key,
          direct_generation: true,
          lovart_project_id: normalized.project_id,
          activation: clone(activation),
          lovart_thread_id: null,
          lovart_thread_source: null,
          parent_job_id: activation.parent_job_id ?? null,
          iteration_index: 0,
          estimated_cost: null,
          cost_decisions: [],
          error: null,
          status_message: statusMessageFor("queued_for_agent"),
          progress: null,
          created_at: now,
          updated_at: now,
        };
        state.jobs.push(job);
        state.idempotency[idempotency_key] = {
          operation: "direct_generation",
          job_id: job.id,
          lovart_project_id: normalized.project_id,
          activation: comparableActivation,
          snapshot: comparableSnapshot,
        };
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:lovart_submit", reason: "Direct Lovart generation job created", changed_fields: ["jobs", "idempotency"] });
        return { job: clone(job), idempotent: false };
      });
    },

    async createWorkbenchSubmission({ snapshot, idempotency_key }) {
      if (!idempotency_key || typeof idempotency_key !== "string") throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new DomainError("VALIDATION_FAILED", "snapshot must be an object.", { field: "snapshot" });
      if (!snapshot.prompt || typeof snapshot.prompt !== "object" || typeof snapshot.prompt.text !== "string" || !snapshot.prompt.text.trim()) {
        throw new DomainError("VALIDATION_FAILED", "A non-empty prompt is required before sending a task to Codex.", { field: "snapshot.prompt.text" });
      }
      if (!["image", "video"].includes(snapshot.mode)) throw new DomainError("VALIDATION_FAILED", "Workbench mode must be image or video.", { field: "snapshot.mode" });
      const selection = await freezeProviderSelection(snapshot);
      const normalizedSnapshot = sanitizeSnapshot(snapshot, selection.secret_field_ids);
      normalizedSnapshot.provider_id = selection.provider_id;
      normalizedSnapshot.provider_label = selection.provider_label;
      normalizedSnapshot.connection_id = selection.connection_id;
      normalizedSnapshot.connection_config_revision = selection.connection_config_revision;
      normalizedSnapshot.model_catalog_revision = selection.model_catalog_revision;
      normalizedSnapshot.model_catalog_digest = selection.model_catalog_digest;
      normalizedSnapshot.adapter_id = selection.adapter_id;
      normalizedSnapshot.adapter_version = selection.adapter_version;
      normalizedSnapshot.selected_model = selection.selected_model;
      normalizedSnapshot.selected_model_digest = selection.selected_model_digest;
      normalizedSnapshot.settings = normalizeWorkbenchCountSettings(snapshot.mode, normalizedSnapshot.settings);
      if (snapshot.model != null) {
        if (typeof snapshot.model !== "string" || !snapshot.model.trim()) {
          throw new DomainError("VALIDATION_FAILED", "Workbench model must be a non-empty string.", { field: "snapshot.model" });
        }
        const normalizedModel = selection.provider_id === "lovart" ? normalizeWorkbenchModel(snapshot.model) : snapshot.model.trim();
        try {
          normalizedSnapshot.model = selection.provider_id === "lovart"
            ? assertProviderModelCapability({ providerRegistry, provider_id: selection.provider_id, model: normalizedModel, mode: snapshot.mode, field: "snapshot.model" })
            : selection.legacy === true ? normalizedModel : selection.selected_model.id;
        } catch (error) {
          throw new DomainError(error.code ?? "VALIDATION_FAILED", error.message, error.details);
        }
      }
      if (snapshot.attachments != null && (!Array.isArray(snapshot.attachments) || snapshot.attachments.some((item) => typeof item !== "string" || !item))) {
        throw new DomainError("VALIDATION_FAILED", "snapshot.attachments must contain only non-empty strings.", { field: "snapshot.attachments" });
      }
      const activation = { source: "workbench_action" };
      const result = await store.update((state) => {
        const project = currentProject(state);
        const selectedProjectId = project.lovart_project_id ?? state.active_lovart_project_id ?? null;
        const frozenSnapshot = {
          ...normalizedSnapshot,
          prompt: clone(normalizedSnapshot.prompt),
          attachments: clone(normalizedSnapshot.attachments ?? []),
          provider_id: selection.provider_id,
          provider_label: selection.provider_label,
          connection_id: selection.connection_id,
          connection_config_revision: selection.connection_config_revision,
          model_catalog_revision: selection.model_catalog_revision,
          model_catalog_digest: selection.model_catalog_digest,
          adapter_id: selection.adapter_id,
          adapter_version: selection.adapter_version,
          selected_model: selection.selected_model,
          selected_model_digest: selection.selected_model_digest,
          lovart_project_id: selectedProjectId,
          activation: clone(activation),
        };
        const comparableSnapshot = stableJson(frozenSnapshot);
        const existing = state.idempotency[idempotency_key];
        if (existing) {
          if (existing.operation !== "workbench_submission" || existing.snapshot !== comparableSnapshot) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different workbench submission.");
          }
          return { job: clone(findJob(state, existing.job_id)), idempotent: true };
        }
        const now = isoNow();
        const job = {
          id: randomUUID(),
          project_id: project.id,
          draft_id: null,
          draft_revision: null,
          snapshot: frozenSnapshot,
          provider_id: selection.provider_id,
          provider_label: selection.provider_label,
          connection_id: selection.connection_id,
          submission_kind: "workbench_generation",
          status: "queued_for_agent",
          attempt: 1,
          idempotency_key,
          direct_generation: false,
          lovart_project_id: selectedProjectId,
          activation: clone(activation),
          lovart_thread_id: null,
          lovart_thread_source: null,
          parent_job_id: null,
          iteration_index: 0,
          estimated_cost: null,
          cost_decisions: [],
          error: null,
          status_message: statusMessageFor("queued_for_agent"),
          progress: null,
          created_at: now,
          updated_at: now,
        };
        state.jobs.push(job);
        state.idempotency[idempotency_key] = { operation: "workbench_submission", job_id: job.id, snapshot: comparableSnapshot };
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "workbench_action", reason: "Workbench task sent to Codex", changed_fields: ["jobs", "idempotency"] });
        return { job: clone(job), idempotent: false };
      });
      publish(listeners, {
        type: "job.updated",
        occurred_at: isoNow(),
        data: {
          job_id: result.job.id,
          status: result.job.status,
          attempt: result.job.attempt,
          status_message: result.job.status_message,
          progress: result.job.progress,
        },
      });
      return result;
    },

    async activateWorkbenchSubmission({ job_id, lovart_project_id }) {
      const normalized = normalizeLovartProjectLocator(lovart_project_id);
      const result = await store.update((state) => {
        const job = findJob(state, job_id);
        if (job.submission_kind !== "workbench_generation" || job.activation?.source !== "workbench_action") {
          throw new DomainError("VALIDATION_FAILED", "The requested job is not a workbench submission.", { job_id });
        }
        if (job.direct_generation) {
          if (job.lovart_project_id !== normalized.project_id) throw statusConflict(job, "The workbench submission is already bound to a different Lovart project.", { lovart_project_id: job.lovart_project_id });
          return { job: clone(job), idempotent: true };
        }
        if (job.status !== "queued_for_agent") throw statusConflict(job, "The workbench submission is no longer waiting for Codex.");
        const now = isoNow();
        job.direct_generation = true;
        job.lovart_project_id = normalized.project_id;
        job.status_message = "Codex 已收到任务，正在准备调用 Lovart。";
        job.progress = { phase: "accepted", status: "queued_for_agent" };
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:workbench_handoff", reason: "Codex accepted workbench task for Lovart execution", changed_fields: ["direct_generation", "lovart_project_id"] });
        return { job: clone(job), idempotent: false };
      });
      publish(listeners, {
        type: "job.updated",
        occurred_at: isoNow(),
        data: {
          job_id: result.job.id,
          status: result.job.status,
          attempt: result.job.attempt,
          status_message: result.job.status_message,
          progress: result.job.progress,
        },
      });
      return result;
    },

    async createFollowUpGenerationJob({ parent_job_id, artifact_id, instruction, activation_source, idempotency_key }) {
      if (typeof parent_job_id !== "string" || !parent_job_id.trim()) throw new DomainError("VALIDATION_FAILED", "parent_job_id is required.", { field: "parent_job_id" });
      if (typeof artifact_id !== "string" || !artifact_id.trim()) throw new DomainError("VALIDATION_FAILED", "artifact_id is required.", { field: "artifact_id" });
      if (typeof instruction !== "string" || !instruction.trim()) throw new DomainError("VALIDATION_FAILED", "instruction is required.", { field: "instruction" });
      if (typeof idempotency_key !== "string" || !idempotency_key.trim()) throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
      const activation = clone(activation_source ?? {});
      assertContinuationParent({ activation_source: activation.source, parent_job_id: activation.parent_job_id, artifact_id: activation.artifact_id });
      return store.update((state) => {
        const parent = findJob(state, parent_job_id);
        if (!parent.direct_generation) throw new DomainError("VALIDATION_FAILED", "Follow-up requires a live Lovart parent job.", { parent_job_id });
        if (!["succeeded", "partially_succeeded"].includes(parent.status)) throw statusConflict(parent, "Follow-up requires a successful or partially successful parent job.", { parent_job_id });
        const artifact = findArtifact(state, artifact_id);
        if (!artifact || artifact.job_id !== parent.id) throw new DomainError("NOT_FOUND", "The selected artifact does not belong to the parent job.", { artifact_id, parent_job_id });
        if (!parent.lovart_project_id) throw new DomainError("VALIDATION_FAILED", "The parent job has no Lovart project context.", { parent_job_id });
        const normalizedInstruction = instruction.trim();
        const lineage = {
          parent_job_id: parent.id,
          parent_artifact_id: artifact.id,
          instruction: normalizedInstruction,
          activation,
          project_id: parent.lovart_project_id,
          created_at: isoNow(),
          idempotency_key,
        };
        const comparable = stableJson({
          parent_job_id: lineage.parent_job_id,
          parent_artifact_id: lineage.parent_artifact_id,
          instruction: lineage.instruction,
          activation: lineage.activation,
          project_id: lineage.project_id,
        });
        const existing = state.idempotency[idempotency_key];
        if (existing) {
          if (existing.operation !== "follow_up_generation" || existing.lineage !== comparable) throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different follow-up request.");
          return { job: clone(findJob(state, existing.job_id)), idempotent: true };
        }
        const now = lineage.created_at;
        const job = {
          id: randomUUID(),
          project_id: parent.project_id,
          draft_id: null,
          draft_revision: null,
          snapshot: {
            mode: parent.snapshot?.mode ?? null,
            prompt: { text: parent.snapshot?.prompt?.text ?? "", tokens: clone(parent.snapshot?.prompt?.tokens ?? []) },
            follow_up_instruction: normalizedInstruction,
            parent_artifact_id: artifact.id,
            attachments: [artifact.local_path],
            prefer_models: clone(parent.snapshot?.prefer_models ?? null),
            include_tools: clone(parent.snapshot?.include_tools ?? []),
            lovart_project_id: parent.lovart_project_id,
            activation: clone(activation),
          },
          follow_up: lineage,
          status: "queued_for_agent",
          attempt: 1,
          idempotency_key,
          direct_generation: true,
          lovart_project_id: parent.lovart_project_id,
          activation: clone(activation),
          lovart_thread_id: null,
          lovart_thread_source: null,
          parent_job_id: parent.id,
          parent_artifact_id: artifact.id,
          iteration_index: (iterationIndexForParent(parent) + 1),
          estimated_cost: null,
          cost_decisions: [],
          error: null,
          status_message: statusMessageFor("queued_for_agent"),
          progress: null,
          created_at: now,
          updated_at: now,
        };
        state.jobs.push(job);
        state.idempotency[idempotency_key] = { operation: "follow_up_generation", job_id: job.id, lineage: comparable };
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:lovart_submit", reason: "Lovart follow-up generation job created", changed_fields: ["jobs", "idempotency"] });
        return { job: clone(job), idempotent: false };
      });
    },

    async updateLiveJob({
      job_id,
      expected_status,
      next_status,
      attempt,
      source,
      source_checked_at,
      lovart_thread_id,
      provider_task_id,
      provider_cost,
      estimated_cost,
      cost_decision_id,
      confirmation_evidence,
      error,
      status_message,
      progress,
    }) {
      assertExecutionSource(source);
      if (!Number.isInteger(attempt) || attempt < 1) throw new DomainError("VALIDATION_FAILED", "attempt must be a positive integer.", { field: "attempt" });
      const normalizedStatusMessage = normalizeStatusMessage(status_message, next_status);
      const normalizedProgress = normalizeProgress(progress);
      const isCostTransition = expected_status === "submitted" && next_status === "awaiting_cost_confirmation";
      let canonicalCostCheckedAt = null;
      if (isCostTransition) {
        const unknownCost = estimated_cost?.unknown === true;
        if (!estimated_cost || typeof estimated_cost !== "object" || Array.isArray(estimated_cost) || (unknownCost
          ? estimated_cost.amount != null || estimated_cost.unit != null
          : !Number.isFinite(estimated_cost.amount) || estimated_cost.amount < 0 || typeof estimated_cost.unit !== "string" || !estimated_cost.unit)) {
          throw new DomainError("VALIDATION_FAILED", "A complete sourced cost is required for the awaiting-cost transition.", { field: "estimated_cost" });
        }
        canonicalCostCheckedAt = assertSourceCheckedAt(source_checked_at, { field: "source_checked_at" });
      } else if (estimated_cost != null || source_checked_at != null) {
        throw new DomainError("VALIDATION_FAILED", "estimated_cost and source_checked_at may only be written when entering awaiting_cost_confirmation.", { field: "estimated_cost" });
      }
      const isConfirmationSuccess = expected_status === "awaiting_cost_confirmation" && next_status === "generating";
      if (isConfirmationSuccess && (!cost_decision_id || confirmation_evidence?.kind !== "confirmation_accepted")) {
        throw new DomainError("COST_CONFIRMATION_REQUIRED", "The exact claimed decision and confirmation-success evidence are required.", { job_id, attempt });
      }
      if (!isConfirmationSuccess && (cost_decision_id != null || confirmation_evidence != null)) {
        throw new DomainError("VALIDATION_FAILED", "Confirmation evidence is not valid for this job transition.", { field: "confirmation_evidence" });
      }
      if (provider_task_id != null && (typeof provider_task_id !== "string" || !provider_task_id)) {
        throw new DomainError("VALIDATION_FAILED", "provider_task_id must be a non-empty string.", { field: "provider_task_id" });
      }
      if (provider_cost != null && (!provider_cost || typeof provider_cost !== "object" || Array.isArray(provider_cost) || !["known_free", "pending", "unknown"].includes(provider_cost.status))) {
        throw new DomainError("VALIDATION_FAILED", "provider_cost is invalid.", { field: "provider_cost" });
      }
      const result = await store.update((state) => {
        const job = findJob(state, job_id);
        if (!isExecutableProviderJob(job)) throw new DomainError("VALIDATION_FAILED", "The requested job is not an executable provider job.", { job_id });
        if (job.status !== expected_status || job.attempt !== attempt) throw statusConflict(job, "The live job status or attempt changed.", { expected_status, expected_attempt: attempt });
        if (!JOB_TRANSITIONS.get(job.status)?.has(next_status)) throw statusConflict(job, "The requested live job transition is not allowed.", { next_status });
        const confirmationDecision = isConfirmationSuccess ? claimedDecisionForConfirmation(job, { cost_decision_id }) : null;
        if (isCostTransition) {
          if (job.estimated_cost != null) throw new DomainError("COST_CONFIRMATION_CONFLICT", "The sourced cost is already recorded and cannot be replaced.", { job_id, attempt });
          job.estimated_cost = estimated_cost.unknown === true
            ? { amount: null, unit: null, unknown: true, source, checked_at: canonicalCostCheckedAt }
            : { amount: estimated_cost.amount, unit: estimated_cost.unit, source, checked_at: canonicalCostCheckedAt };
        }
        if (lovart_thread_id != null) {
          if (typeof lovart_thread_id !== "string" || !lovart_thread_id) throw new DomainError("VALIDATION_FAILED", "lovart_thread_id must be a non-empty string.", { field: "lovart_thread_id" });
          if (job.lovart_thread_id && job.lovart_thread_id !== lovart_thread_id) throw statusConflict(job, "The live job is already linked to a different thread.", { lovart_thread_id: job.lovart_thread_id });
          job.lovart_thread_id ??= lovart_thread_id;
          job.lovart_thread_source ??= source;
        }
        if (provider_task_id != null) {
          if (job.provider_task_id && job.provider_task_id !== provider_task_id) throw statusConflict(job, "The provider job is already linked to a different provider task.", { provider_task_id: job.provider_task_id });
          job.provider_task_id ??= provider_task_id;
        }
        if (provider_cost != null) job.provider_cost = clone(provider_cost);
        const now = isoNow();
        if (confirmationDecision) confirmationDecision.confirmation = { status: "succeeded", source, recorded_at: now };
        job.status = next_status;
        job.status_message = normalizedStatusMessage;
        job.progress = normalizedProgress;
        job.error = error == null ? job.error : { ...clone(error), source };
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: source, reason: `Live job status: ${expected_status} -> ${next_status}`, changed_fields: ["status", ...(isCostTransition ? ["estimated_cost"] : []), ...(lovart_thread_id != null ? ["lovart_thread_id"] : []), ...(provider_task_id != null ? ["provider_task_id"] : []), ...(provider_cost != null ? ["provider_cost"] : []), ...(confirmationDecision ? ["cost_decisions"] : [])] });
        return { job: clone(job) };
      });
      publish(listeners, {
        type: "job.updated",
        occurred_at: isoNow(),
        data: {
          job_id: result.job.id,
          status: result.job.status,
          attempt: result.job.attempt,
          status_message: result.job.status_message,
          progress: result.job.progress,
        },
      });
      return result;
    },

    async updateLiveJobProgress({ job_id, expected_status, attempt, source, status_message, progress, retry_state = null }) {
      assertExecutionSource(source);
      if (!Number.isInteger(attempt) || attempt < 1) throw new DomainError("VALIDATION_FAILED", "attempt must be a positive integer.", { field: "attempt" });
      if (typeof expected_status !== "string" || !JOB_TRANSITIONS.has(expected_status)) throw new DomainError("VALIDATION_FAILED", "expected_status is invalid.", { field: "expected_status" });
      const normalizedStatusMessage = normalizeStatusMessage(status_message, expected_status);
      const normalizedProgress = normalizeProgress(progress);
      if (retry_state != null && !["automatic", "manual"].includes(retry_state)) {
        throw new DomainError("VALIDATION_FAILED", "retry_state is invalid.", { field: "retry_state" });
      }
      const result = await store.update((state) => {
        const job = findJob(state, job_id);
        if (!isExecutableProviderJob(job)) throw new DomainError("VALIDATION_FAILED", "The requested job is not an executable provider job.", { job_id });
        if (job.status !== expected_status || job.attempt !== attempt) throw statusConflict(job, "The live job status or attempt changed.", { expected_status, expected_attempt: attempt });
        const now = isoNow();
        job.status_message = normalizedStatusMessage;
        job.progress = normalizedProgress;
        if (retry_state != null) job.retry_state = retry_state;
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: source, reason: "Live job progress updated", changed_fields: ["status_message", "progress", ...(retry_state != null ? ["retry_state"] : [])] });
        return { job: clone(job) };
      });
      publish(listeners, {
        type: "job.progress",
        occurred_at: isoNow(),
        data: {
          job_id: result.job.id,
          status: result.job.status,
          attempt: result.job.attempt,
          status_message: result.job.status_message,
          progress: result.job.progress,
        },
      });
      return result;
    },

    async prepareGeneration({ draft_id, expected_revision, idempotency_key }) {
      if (!idempotency_key || typeof idempotency_key !== "string") {
        throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.");
      }
      return store.update(async (state) => {
        const existing = state.idempotency[idempotency_key];
        if (existing) {
          if (existing.operation !== "prepare_generation" || existing.draft_id !== draft_id) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different request.");
          }
          return { job: clone(state.jobs.find((job) => job.id === existing.job_id)), idempotent: true };
        }
        const draft = findDraft(state, draft_id);
        if (draft.revision !== expected_revision) {
          throw new DomainError("REVISION_CONFLICT", "The workbench state changed. Read it again before preparing a task.", {
            current_revision: draft.revision,
          });
        }
        if (!draft.prompt.text.trim()) {
          throw new DomainError("VALIDATION_FAILED", "A non-empty prompt is required before preparing a task.", { field: "prompt.text" });
        }
        const validation = validateDraftForPreparation(state, draft, { providerRegistry });
        const selection = await freezeProviderSelection(draft);
        const now = isoNow();
        const localProject = state.projects.find((item) => item.id === draft.project_id);
        const selectedProjectId = localProject?.lovart_project_id ?? state.active_lovart_project_id ?? null;
        const activation = { source: "workbench_action" };
        const frozenSnapshot = {
          ...sanitizeSnapshot(draft, selection.secret_field_ids),
          provider_id: selection.provider_id,
          provider_label: selection.provider_label,
          connection_id: selection.connection_id,
          connection_config_revision: selection.connection_config_revision,
          model_catalog_revision: selection.model_catalog_revision,
          model_catalog_digest: selection.model_catalog_digest,
          adapter_id: selection.adapter_id,
          adapter_version: selection.adapter_version,
          selected_model: selection.selected_model,
          selected_model_digest: selection.selected_model_digest,
          lovart_project_id: selectedProjectId,
          activation,
        };
        const job = {
          id: randomUUID(),
          project_id: draft.project_id,
          draft_id: draft.id,
          draft_revision: draft.revision,
          snapshot: frozenSnapshot,
          provider_id: selection.provider_id,
          provider_label: selection.provider_label,
          connection_id: selection.connection_id,
          submission_kind: "workbench_generation",
          status: "queued_for_agent",
          attempt: 1,
          idempotency_key,
          direct_generation: false,
          activation,
          lovart_project_id: selectedProjectId,
          lovart_thread_id: draft.iteration_context?.lovart_thread_id ?? null,
          lovart_thread_source: draft.iteration_context?.lovart_thread_source ?? null,
          parent_job_id: draft.iteration_context?.source_job_id ?? null,
          iteration_index: draft.iteration_context?.iteration_index ?? 0,
          estimated_cost: null,
          cost_decisions: [],
          error: null,
          status_message: statusMessageFor("queued_for_agent"),
          progress: null,
          created_at: now,
          updated_at: now,
        };
        state.jobs.push(job);
        state.idempotency[idempotency_key] = { operation: "prepare_generation", draft_id, job_id: job.id };
        state.updated_at = now;
        return { job: clone(job), validation, idempotent: false };
      });
    },

    async listPendingJobs({ limit = 20 } = {}) {
      const state = await store.read();
      return clone(state.jobs.filter((job) => ["queued_for_agent", "awaiting_cost_confirmation"].includes(job.status)).slice(0, limit));
    },

    async updateJob({
      job_id,
      expected_status,
      next_status,
      attempt,
      source,
      source_checked_at,
      lovart_thread_id,
      estimated_cost,
      cost_decision_id,
      confirmation_evidence,
      error,
      status_message,
      progress,
    }) {
      assertFixtureSource(source);
      const normalizedStatusMessage = normalizeStatusMessage(status_message, next_status);
      const normalizedProgress = normalizeProgress(progress);
      const isCostTransition = expected_status === "submitted" && next_status === "awaiting_cost_confirmation";
      let canonicalCostCheckedAt = null;
      if (isCostTransition) {
        assertFixtureSource(source);
        if (!estimated_cost || typeof estimated_cost !== "object" || Array.isArray(estimated_cost)) {
          throw new DomainError("VALIDATION_FAILED", "A complete sourced cost is required for the awaiting-cost transition.", { field: "estimated_cost" });
        }
        if (!Number.isFinite(estimated_cost.amount) || estimated_cost.amount < 0 || typeof estimated_cost.unit !== "string" || !estimated_cost.unit) {
          throw new DomainError("VALIDATION_FAILED", "estimated_cost requires a non-negative amount and unit.", { field: "estimated_cost" });
        }
        canonicalCostCheckedAt = assertSourceCheckedAt(source_checked_at, { field: "source_checked_at" });
      } else if (estimated_cost != null || source_checked_at != null) {
        throw new DomainError("VALIDATION_FAILED", "estimated_cost and source_checked_at may only be written when entering awaiting_cost_confirmation.", { field: "estimated_cost" });
      }

      const isConfirmationSuccess = expected_status === "awaiting_cost_confirmation" && next_status === "generating";
      const isConfirmationFailure = expected_status === "awaiting_cost_confirmation"
        && next_status === "awaiting_cost_confirmation"
        && confirmation_evidence?.kind === "confirmation_failed";
      const hasConfirmationInput = cost_decision_id != null || confirmation_evidence != null;
      if (isConfirmationSuccess) {
        if (!cost_decision_id || confirmation_evidence?.kind !== "confirmation_accepted") {
          throw new DomainError("COST_CONFIRMATION_REQUIRED", "The exact claimed decision and fixture confirmation-success evidence are required.", { job_id, attempt });
        }
        assertFixtureSource(source);
      } else if (isConfirmationFailure) {
        if (!cost_decision_id) {
          throw new DomainError("COST_CONFIRMATION_REQUIRED", "The failed confirmation must identify its claimed decision.", { job_id, attempt });
        }
        const failure = confirmation_evidence.error;
        if (!failure || typeof failure !== "object" || Array.isArray(failure) || typeof failure.code !== "string" || !failure.code || typeof failure.message !== "string" || !failure.message) {
          throw new DomainError("VALIDATION_FAILED", "Confirmation failure evidence requires a code and message.", { field: "confirmation_evidence" });
        }
        assertFixtureSource(source);
      } else if (hasConfirmationInput) {
        throw new DomainError("VALIDATION_FAILED", "Confirmation evidence is not valid for this job transition.", { field: "confirmation_evidence" });
      }

      if (lovart_thread_id != null) {
        if (typeof lovart_thread_id !== "string" || !lovart_thread_id) {
          throw new DomainError("VALIDATION_FAILED", "lovart_thread_id must be a non-empty string.", { field: "lovart_thread_id" });
        }
        assertFixtureSource(source);
      }

      const result = await store.update((state) => {
        const job = findJob(state, job_id);
        if (job.status !== expected_status) throw statusConflict(job, "The job status changed. Read it again before updating.", { expected_status });
        if (job.attempt !== attempt) throw statusConflict(job, "The job attempt changed. Read it again before updating.", { expected_attempt: attempt });
        if (!isConfirmationFailure && !JOB_TRANSITIONS.get(job.status)?.has(next_status)) {
          throw statusConflict(job, "The requested job transition is not allowed.", { next_status });
        }
        const confirmationDecision = isConfirmationSuccess || isConfirmationFailure
          ? claimedDecisionForConfirmation(job, { cost_decision_id })
          : null;
        if (lovart_thread_id != null) {
          if (job.lovart_thread_id && job.lovart_thread_id !== lovart_thread_id) throw statusConflict(job, "The job is already linked to a different thread.", { lovart_thread_id: job.lovart_thread_id });
          if (!job.lovart_thread_id) {
            job.lovart_thread_id = lovart_thread_id;
            job.lovart_thread_source = source;
          } else if (!job.lovart_thread_source) {
            job.lovart_thread_source = source;
          }
        }
        if (isCostTransition) {
          if (job.estimated_cost != null) {
            throw new DomainError("COST_CONFIRMATION_CONFLICT", "The sourced cost is already recorded and cannot be replaced.", { job_id: job.id, attempt: job.attempt });
          }
          job.estimated_cost = { amount: estimated_cost.amount, unit: estimated_cost.unit, source, checked_at: canonicalCostCheckedAt };
        }
        const now = isoNow();
        if (confirmationDecision) {
          confirmationDecision.confirmation = {
            status: isConfirmationSuccess ? "succeeded" : "failed",
            source,
            recorded_at: now,
            ...(isConfirmationFailure ? { error: clone(confirmation_evidence.error) } : {}),
          };
        }
        job.status = next_status;
        job.status_message = normalizedStatusMessage;
        job.progress = normalizedProgress;
        job.error = error == null ? job.error : { ...clone(error), source };
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({
          id: randomUUID(),
          occurred_at: now,
          actor: source,
          reason: isConfirmationFailure ? "Fixture confirmation failed" : `Job status: ${expected_status} -> ${next_status}`,
          changed_fields: [
            ...(expected_status === next_status ? [] : ["status"]),
            ...(isCostTransition ? ["estimated_cost"] : []),
            ...(lovart_thread_id != null ? ["lovart_thread_id", "lovart_thread_source"] : []),
            ...(confirmationDecision ? ["cost_decisions"] : []),
          ],
        });
        return { job: clone(job) };
      });
      publish(listeners, {
        type: "job.updated",
        occurred_at: isoNow(),
        data: {
          job_id: result.job.id,
          status: result.job.status,
          attempt: result.job.attempt,
          status_message: result.job.status_message,
          progress: result.job.progress,
        },
      });
      return result;
    },

    async recordCostDecision({ job_id, attempt, cost_fingerprint, decision, source, idempotency_key }) {
      if (!idempotency_key) throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
      return store.update((state) => {
        const existing = state.idempotency[idempotency_key];
        if (existing) {
          if (
            existing.operation !== "record_cost_decision"
            || existing.job_id !== job_id
            || existing.attempt !== attempt
            || existing.cost_fingerprint !== cost_fingerprint
            || existing.decision !== decision
            || existing.source !== source
          ) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different request.");
          }
          if (existing.receipt) return { ...clone(existing.receipt), idempotent: true };
          if (existing.response) {
            const receipt = clone(existing.response);
            delete receipt.idempotent;
            existing.receipt = clone(receipt);
            return { ...receipt, idempotent: true };
          }
          const existingJob = findJob(state, job_id);
          const existingDecision = (existingJob.cost_decisions ?? []).find((item) => item.decision_id === existing.decision_id);
          if (!existingDecision) {
            throw new DomainError("COST_CONFIRMATION_CONFLICT", "The stored cost decision is unavailable.", { job_id, attempt, decision_id: existing.decision_id });
          }
          const originalDecision = { ...clone(existingDecision), consumed_at: null, confirmation: null };
          const originalJob = clone(existingJob);
          originalJob.status = originalDecision.decision === "declined" ? "declined" : "awaiting_cost_confirmation";
          originalJob.updated_at = originalDecision.recorded_at;
          originalJob.cost_decisions = [clone(originalDecision)];
          const receipt = { job: originalJob, decision: originalDecision };
          existing.receipt = clone(receipt);
          return { ...receipt, idempotent: true };
        }
        if (!["accepted", "declined"].includes(decision)) {
          throw new DomainError("VALIDATION_FAILED", "decision must be accepted or declined.", { field: "decision" });
        }
        assertM5Source(source, { allowUser: true });
        if (source !== "user:current_session") {
          throw new DomainError("VALIDATION_FAILED", "A cost decision must come from the current user session.", { field: "source" });
        }
        const job = findJob(state, job_id);
        assertCurrentCost(job, { attempt, cost_fingerprint });
        job.cost_decisions ??= [];
        const pendingDecision = job.cost_decisions.find((item) => item.consumed_at == null);
        if (pendingDecision?.confirmation?.status === "provider_pending") {
          throw new DomainError("STATUS_CONFLICT", "A provider confirmation is already in progress for this cost decision.", { job_id, attempt, decision_id: pendingDecision.decision_id });
        }
        if (pendingDecision && !(decision === "declined" && pendingDecision.decision === "accepted")) {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "An unconsumed cost decision already exists.", { job_id, attempt });
        }
        const now = isoNow();
        if (pendingDecision) {
          pendingDecision.consumed_at = now;
          pendingDecision.confirmation = { status: "superseded", source: "user:current_session", recorded_at: now };
        }
        const record = { decision_id: randomUUID(), job_id, attempt, decision, cost_fingerprint, source, recorded_at: now, consumed_at: null, confirmation: null };
        job.cost_decisions.push(record);
        if (decision === "declined") job.status = "declined";
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: source, reason: `Cost decision: ${decision}`, changed_fields: ["cost_decisions", ...(decision === "declined" ? ["status"] : [])] });
        const receipt = { job: clone(job), decision: clone(record) };
        state.idempotency[idempotency_key] = {
          operation: "record_cost_decision",
          job_id,
          attempt,
          cost_fingerprint,
          decision,
          source,
          decision_id: record.decision_id,
          receipt: clone(receipt),
        };
        return { ...receipt, idempotent: false };
      });
    },

    async awaitProviderCostDecision({ job_id, attempt, estimate, resume_status = "uploading" }) {
      const unknown = estimate?.status === "unknown";
      const amount = estimate?.amount;
      const unit = estimate?.unit;
      if (!estimate || typeof estimate !== "object" || Array.isArray(estimate) || (unknown
        ? amount != null || unit != null
        : estimate.status !== "pending" || !Number.isFinite(amount) || amount <= 0 || typeof unit !== "string" || !unit)) {
        throw new DomainError("VALIDATION_FAILED", "A non-zero or unknown provider estimate is required.", { field: "estimate" });
      }
      if (resume_status !== "uploading") throw new DomainError("VALIDATION_FAILED", "Provider cost confirmation may resume only before submission.", { field: "resume_status" });
      const checkedAt = isoNow();
      const result = await store.update((state) => {
        const job = findJob(state, job_id);
        if (job.status !== "uploading" || job.attempt !== attempt) throw statusConflict(job, "The provider job is no longer waiting to submit.", { expected_status: "uploading", expected_attempt: attempt });
        if (job.pre_submit_cost_authorization?.used_at != null) {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "A cost authorization cannot be replayed for another provider submission.", { job_id, attempt });
        }
        const now = isoNow();
        job.estimated_cost = unknown
          ? { amount: null, unit: null, unknown: true, source: "imvia:provider_upload", checked_at: checkedAt }
          : { amount, unit, source: "imvia:provider_upload", checked_at: checkedAt };
        job.provider_cost = unknown ? { status: "unknown", amount: null, unit: null } : { status: "pending", amount, unit };
        job.pre_submit_cost_authorization = null;
        job.status = "awaiting_cost_confirmation";
        job.status_message = "外部提供方费用待确认，尚未提交请求。";
        job.progress = { phase: "awaiting_cost_confirmation" };
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:provider_upload", reason: "Provider cost confirmation required before submission", changed_fields: ["status", "estimated_cost", "provider_cost"] });
        return { job: clone(job) };
      });
      publish(listeners, { type: "job.updated", occurred_at: isoNow(), data: { job_id: result.job.id, status: result.job.status, attempt: result.job.attempt, status_message: result.job.status_message, progress: result.job.progress } });
      return result;
    },

    async authorizeProviderCostAndResume({ job_id, attempt, cost_fingerprint, decision_id, resume_status = "uploading" }) {
      if (resume_status !== "uploading") throw new DomainError("VALIDATION_FAILED", "Provider cost confirmation may resume only before submission.", { field: "resume_status" });
      const result = await store.update((state) => {
        const job = findJob(state, job_id);
        assertCurrentCost(job, { attempt, cost_fingerprint });
        const decision = (job.cost_decisions ?? []).find((item) => item.decision_id === decision_id);
        if (!decision || decision.decision !== "accepted" || decision.consumed_at != null || decision.cost_fingerprint !== cost_fingerprint) {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "The accepted cost decision is stale, missing, or already used.", { job_id, attempt, decision_id });
        }
        const now = isoNow();
        decision.consumed_at = now;
        decision.confirmation = { status: "authorized_for_submit", source: "imvia:provider_confirm", recorded_at: now };
        job.pre_submit_cost_authorization = { decision_id, cost_fingerprint, attempt, resume_status, estimate: clone(job.estimated_cost), authorized_at: now, used_at: null };
        job.status = resume_status;
        job.status_message = "费用确认已接受，正在提交给外部提供方。";
        job.progress = { phase: resume_status };
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:provider_confirm", reason: "Provider cost authorized for one submission", changed_fields: ["status", "cost_decisions", "pre_submit_cost_authorization"] });
        return { job: clone(job), decision: clone(decision) };
      });
      publish(listeners, { type: "job.updated", occurred_at: isoNow(), data: { job_id: result.job.id, status: result.job.status, attempt: result.job.attempt, status_message: result.job.status_message, progress: result.job.progress } });
      return result;
    },

    async consumeProviderCostAuthorization({ job_id, attempt, cost_fingerprint, decision_id }) {
      return store.update((state) => {
        const job = findJob(state, job_id);
        const authorization = job.pre_submit_cost_authorization;
        if (job.status !== "uploading" || job.attempt !== attempt || !authorization || authorization.attempt !== attempt || authorization.resume_status !== "uploading" || authorization.cost_fingerprint !== cost_fingerprint || authorization.decision_id !== decision_id || authorization.used_at != null || costFingerprintForJob(job) !== cost_fingerprint) {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "The provider cost authorization is stale or already used.", { job_id, attempt, decision_id });
        }
        const now = isoNow();
        authorization.used_at = now;
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:provider_submit", reason: "Provider cost authorization consumed", changed_fields: ["pre_submit_cost_authorization"] });
        return { job: clone(job), authorization: clone(authorization) };
      });
    },

    async refreshAwaitingCost({ job_id, attempt, estimated_cost, source, source_checked_at, decision_id = null, cost_fingerprint = null, lease_id = null }) {
      assertM5Source(source);
      const unknownCost = estimated_cost?.unknown === true;
      if (!estimated_cost || typeof estimated_cost !== "object" || Array.isArray(estimated_cost) || (unknownCost
        ? estimated_cost.amount != null || estimated_cost.unit != null
        : !Number.isFinite(estimated_cost.amount) || estimated_cost.amount < 0 || typeof estimated_cost.unit !== "string" || !estimated_cost.unit)) {
        throw new DomainError("VALIDATION_FAILED", "A complete sourced cost is required.", { field: "estimated_cost" });
      }
      const checkedAt = assertSourceCheckedAt(source_checked_at, { field: "source_checked_at" });
      return store.update((state) => {
        const job = findJob(state, job_id);
        if (job.status !== "awaiting_cost_confirmation" || job.attempt !== attempt) {
          throw statusConflict(job, "The provider cost can only be refreshed while the job awaits confirmation.", { expected_status: "awaiting_cost_confirmation", expected_attempt: attempt });
        }
        if (lease_id != null) {
          assertCurrentCost(job, { attempt, cost_fingerprint });
          const decision = (job.cost_decisions ?? []).find((item) => item.decision_id === decision_id);
          if (!decision || decision.decision !== "accepted" || decision.consumed_at != null || decision.cost_fingerprint !== cost_fingerprint || decision.confirmation?.status !== "provider_pending" || decision.confirmation?.lease_id !== lease_id) {
            throw new DomainError("COST_CONFIRMATION_CONFLICT", "The provider confirmation lease is stale or unavailable.", { job_id, attempt, decision_id });
          }
        }
        const now = isoNow();
        for (const decision of job.cost_decisions ?? []) {
          if (decision.consumed_at == null) {
            decision.consumed_at = now;
            decision.confirmation = { status: "superseded", source, ...(lease_id != null ? { lease_id } : {}), recorded_at: now };
          }
        }
        job.estimated_cost = unknownCost
          ? { amount: null, unit: null, unknown: true, source, checked_at: checkedAt }
          : { amount: estimated_cost.amount, unit: estimated_cost.unit, source, checked_at: checkedAt };
        job.provider_cost = unknownCost ? { status: "unknown", amount: null, unit: null } : { status: estimated_cost.amount === 0 ? "known_free" : "pending", amount: estimated_cost.amount, unit: estimated_cost.unit };
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: source, reason: "Provider cost refreshed", changed_fields: ["estimated_cost", "provider_cost", "cost_decisions"] });
        return { job: clone(job) };
      });
    },

    async claimCostDecision({ decision_id, job_id, attempt, cost_fingerprint }) {
      return store.update((state) => {
        const job = findJob(state, job_id);
        assertCurrentCost(job, { attempt, cost_fingerprint });
        const decision = (job.cost_decisions ?? []).find((item) => item.decision_id === decision_id);
        if (!decision || decision.decision !== "accepted" || decision.consumed_at != null || decision.cost_fingerprint !== cost_fingerprint) {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "The cost decision is missing, stale, or already consumed.", { job_id, attempt, decision_id });
        }
        decision.consumed_at = isoNow();
        job.updated_at = decision.consumed_at;
        state.updated_at = decision.consumed_at;
        state.audit_events.push({ id: randomUUID(), occurred_at: decision.consumed_at, actor: "imvia:claim_cost_decision", reason: "Cost decision consumed", changed_fields: ["cost_decisions"] });
        return { job: clone(job), decision: clone(decision) };
      });
    },

    async reserveCostDecisionConfirmation({ decision_id, job_id, attempt, cost_fingerprint }) {
      return store.update((state) => {
        const job = findJob(state, job_id);
        assertCurrentCost(job, { attempt, cost_fingerprint });
        const decision = (job.cost_decisions ?? []).find((item) => item.decision_id === decision_id);
        if (!decision || decision.decision !== "accepted" || decision.consumed_at != null || decision.cost_fingerprint !== cost_fingerprint || decision.confirmation?.status === "provider_pending") {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "The cost decision cannot be reserved for provider confirmation.", { job_id, attempt, decision_id });
        }
        const now = isoNow();
        const lease_id = randomUUID();
        decision.confirmation = { status: "provider_pending", lease_id, source: "imvia:provider_confirm", reserved_at: now };
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:provider_confirm", reason: "Cost decision reserved for provider confirmation", changed_fields: ["cost_decisions"] });
        return { job: clone(job), decision: clone(decision), lease_id };
      });
    },

    async verifyCostDecisionConfirmationLease({ decision_id, job_id, attempt, cost_fingerprint, lease_id }) {
      const state = await store.read();
      const job = findJob(state, job_id);
      assertCurrentCost(job, { attempt, cost_fingerprint });
      const decision = (job.cost_decisions ?? []).find((item) => item.decision_id === decision_id);
      if (!decision || decision.decision !== "accepted" || decision.consumed_at != null || decision.cost_fingerprint !== cost_fingerprint || decision.confirmation?.status !== "provider_pending" || decision.confirmation?.lease_id !== lease_id) {
        throw new DomainError("COST_CONFIRMATION_CONFLICT", "The provider confirmation lease is stale or unavailable.", { job_id, attempt, decision_id });
      }
      return { job: clone(job), decision: clone(decision) };
    },

    async releaseCostDecisionConfirmation({ decision_id, job_id, attempt, cost_fingerprint, lease_id }) {
      return store.update((state) => {
        const job = findJob(state, job_id);
        assertCurrentCost(job, { attempt, cost_fingerprint });
        const decision = (job.cost_decisions ?? []).find((item) => item.decision_id === decision_id);
        if (!decision || decision.decision !== "accepted" || decision.consumed_at != null || decision.cost_fingerprint !== cost_fingerprint || decision.confirmation?.status !== "provider_pending" || decision.confirmation?.lease_id !== lease_id) {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "The provider confirmation lease cannot be released.", { job_id, attempt, decision_id });
        }
        const now = isoNow();
        decision.confirmation = null;
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: "imvia:provider_confirm", reason: "Provider confirmation lease released", changed_fields: ["cost_decisions"] });
        return { job: clone(job), decision: clone(decision) };
      });
    },

    async commitCostDecisionConfirmation({ decision_id, job_id, attempt, cost_fingerprint, lease_id = null, source, status_message, progress }) {
      assertExecutionSource(source);
      const normalizedStatusMessage = normalizeStatusMessage(status_message, "generating");
      const normalizedProgress = normalizeProgress(progress);
      return store.update((state) => {
        const job = findJob(state, job_id);
        assertCurrentCost(job, { attempt, cost_fingerprint });
        const decision = (job.cost_decisions ?? []).find((item) => item.decision_id === decision_id);
        const leaseMatches = lease_id == null
          ? decision?.confirmation?.status !== "provider_pending"
          : decision?.confirmation?.status === "provider_pending" && decision.confirmation?.lease_id === lease_id;
        if (!decision || decision.decision !== "accepted" || decision.consumed_at != null || decision.cost_fingerprint !== cost_fingerprint || !leaseMatches || job.status !== "awaiting_cost_confirmation") {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "The cost decision cannot be committed.", { job_id, attempt, decision_id });
        }
        const now = isoNow();
        decision.consumed_at = now;
        decision.confirmation = { status: "succeeded", source, ...(lease_id == null ? {} : { lease_id }), recorded_at: now };
        job.status = "generating";
        job.status_message = normalizedStatusMessage;
        job.progress = normalizedProgress;
        job.updated_at = now;
        state.updated_at = now;
        state.audit_events.push({ id: randomUUID(), occurred_at: now, actor: source, reason: "Cost decision committed for generation", changed_fields: ["status", "status_message", "progress", "cost_decisions"] });
        return { job: clone(job), decision: clone(decision) };
      });
    },

    async importResult({ job_id, artifacts, idempotency_key }) {
      if (!idempotency_key || typeof idempotency_key !== "string") throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.", { field: "idempotency_key" });
      if (!Array.isArray(artifacts) || !artifacts.length) throw new DomainError("VALIDATION_FAILED", "artifacts must include at least one item.", { field: "artifacts" });
      const managedRoot = path.resolve(dataDirectory);
      const result = await store.update(async (state) => {
        const existing = state.idempotency[idempotency_key];
        if (existing) {
          if (existing.operation !== "import_result" || existing.job_id !== job_id) throw new DomainError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different request.");
          return {
            job: clone(findJob(state, job_id)),
            results: existing.artifact_ids.map((artifactId) => ({ ok: true, duplicate: true, artifact: clone(state.artifacts.find((artifact) => artifact.id === artifactId)) })),
            idempotent: true,
          };
        }
        const job = findJob(state, job_id);
        if (!["generating", "partially_succeeded", "succeeded"].includes(job.status)) throw statusConflict(job, "Results can only be imported for a generating or completed job.");
        const results = [];
        const artifactIds = [];
        for (const input of artifacts) {
          try {
            if (!input || !["image", "video", "audio"].includes(input.kind)) throw new DomainError("FILE_TYPE_UNSUPPORTED", "Artifact kind is unsupported.", { kind: input?.kind });
            if (typeof input.local_path !== "string" || !path.isAbsolute(input.local_path)) throw new DomainError("PATH_NOT_ALLOWED", "Artifact path must be absolute.");
            const artifactPath = path.resolve(input.local_path);
            if (!artifactPath.startsWith(`${managedRoot}${path.sep}`)) throw new DomainError("PATH_NOT_ALLOWED", "Artifact path is outside the IMVIA managed data directory.");
            const info = await lstat(artifactPath);
            if (!info.isFile() || info.isSymbolicLink()) throw new DomainError("PATH_NOT_ALLOWED", "Artifact path must identify a regular managed file.");
            const sha256 = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
            const duplicate = state.artifacts.find((artifact) => artifact.job_id === job.id && (
              input.source_artifact_id
                ? artifact.source_artifact_id === input.source_artifact_id
                : artifact.sha256 === sha256
            ));
            if (duplicate) {
              artifactIds.push(duplicate.id);
              results.push({ ok: true, duplicate: true, artifact: clone(duplicate) });
              continue;
            }
            const now = isoNow();
            const artifact = {
              id: randomUUID(),
              job_id: job.id,
              kind: input.kind,
              local_path: artifactPath,
              source_url: input.source_url ?? null,
              source_artifact_id: input.source_artifact_id ?? null,
              mime_type: input.mime_type ?? null,
              size_bytes: info.size,
              sha256,
              status: "available",
              metadata: clone(input.metadata ?? {}),
              created_at: now,
            };
            state.artifacts.push(artifact);
            artifactIds.push(artifact.id);
            results.push({ ok: true, duplicate: false, artifact: clone(artifact) });
          } catch (caught) {
            const known = caught instanceof DomainError;
            results.push({ ok: false, error: { code: known ? caught.code : "NOT_FOUND", message: known ? caught.message : "The local artifact file is unavailable.", details: known ? caught.details : {} } });
          }
        }
        const succeeded = results.filter((item) => item.ok).length;
        job.status = succeeded === results.length ? "succeeded" : succeeded > 0 ? "partially_succeeded" : "failed";
        job.status_message = statusMessageFor(job.status);
        job.progress = { phase: job.status === "failed" ? "failed" : "completed", status: job.status };
        job.error = succeeded === results.length ? null : { code: "ARTIFACT_IMPORT_FAILED", failed: results.length - succeeded, source: "imvia:import_result" };
        job.updated_at = isoNow();
        state.updated_at = job.updated_at;
        state.idempotency[idempotency_key] = { operation: "import_result", job_id, artifact_ids: artifactIds };
        return { job: clone(job), results, idempotent: false };
      });
      publish(listeners, {
        type: "job.updated",
        occurred_at: isoNow(),
        data: {
          job_id: result.job.id,
          status: result.job.status,
          attempt: result.job.attempt,
          status_message: result.job.status_message,
          progress: result.job.progress,
        },
      });
      if (result.results.some((item) => item.ok)) publish(listeners, { type: "artifact.imported", occurred_at: isoNow(), data: { job_id: result.job.id, artifact_ids: result.results.filter((item) => item.ok).map((item) => item.artifact.id) } });
      return result;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
