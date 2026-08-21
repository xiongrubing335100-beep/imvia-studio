import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { JsonStore } from "../persistence/json-store.js";
import { createCostFingerprint } from "./cost-confirmation.js";
import { DomainError } from "./errors.js";
import { normalizeLovartProjectLocator } from "./lovart-project-context.js";
import { MODEL_CAPABILITIES } from "./model-capabilities.js";
import { assertM5Source, isAllowedM5Source } from "./source-policy.js";
import { assertExpiryAtOrAfterChecked, assertSourceCheckedAt } from "./timestamps.js";

export { DomainError } from "./errors.js";

const ALLOWED_PATCH_FIELDS = new Set([
  "mode",
  "model",
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
  ["uploading", new Set(["submitted", "failed", "cancelled"])],
  ["submitted", new Set(["awaiting_cost_confirmation", "generating", "failed", "cancelled"])],
  ["awaiting_cost_confirmation", new Set(["generating", "declined", "cancelled"])],
  ["generating", new Set(["succeeded", "partially_succeeded", "failed", "cancelled"])],
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    return { state: migrated, changed: !Array.isArray(state.lovart_projects) || !Object.hasOwn(state, "active_lovart_project_id") };
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
  return isAllowedM5Source(source) && (source.startsWith("fixture:") || source.startsWith("mock_lovart:"));
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
  if ("settings.duration_seconds" in patch && patch["settings.duration_seconds"] !== null && (!Number.isInteger(patch["settings.duration_seconds"]) || patch["settings.duration_seconds"] <= 0)) {
    throw new DomainError("VALIDATION_FAILED", "settings.duration_seconds must be a positive integer.", { field: "settings.duration_seconds" });
  }
}

function validateDraftForPreparation(state, draft) {
  if (draft.model) {
    const capability = MODEL_CAPABILITIES.get(draft.model);
    if (!capability) {
      throw new DomainError("MODEL_CAPABILITY_UNKNOWN", "The selected model is absent from the local capability table.", { field: "model", model: draft.model });
    }
    if (capability.mode !== draft.mode) {
      throw new DomainError("VALIDATION_FAILED", "The selected model does not support this creation mode.", { field: "model", model: draft.model, mode: draft.mode });
    }
    if (draft.settings.duration_seconds != null && capability.durations && !capability.durations.includes(draft.settings.duration_seconds)) {
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

export function createWorkbenchService({ dataDirectory }) {
  if (!dataDirectory) throw new Error("dataDirectory is required.");
  const store = new JsonStore({ dataDirectory, createInitialState, migrateState: migrateWorkbenchState });
  const listeners = new Set();

  return {
    async getState(options) {
      return summarize(await store.read(), options);
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

    async prepareGeneration({ draft_id, expected_revision, idempotency_key }) {
      if (!idempotency_key || typeof idempotency_key !== "string") {
        throw new DomainError("VALIDATION_FAILED", "idempotency_key is required.");
      }
      return store.update((state) => {
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
        const validation = validateDraftForPreparation(state, draft);
        const now = isoNow();
        const job = {
          id: randomUUID(),
          project_id: draft.project_id,
          draft_id: draft.id,
          draft_revision: draft.revision,
          snapshot: clone(draft),
          status: "queued_for_agent",
          attempt: 1,
          idempotency_key,
          lovart_thread_id: draft.iteration_context?.lovart_thread_id ?? null,
          lovart_thread_source: draft.iteration_context?.lovart_thread_source ?? null,
          parent_job_id: draft.iteration_context?.source_job_id ?? null,
          iteration_index: draft.iteration_context?.iteration_index ?? 0,
          estimated_cost: null,
          cost_decisions: [],
          error: null,
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
    }) {
      assertM5Source(source);
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
      publish(listeners, { type: "job.updated", occurred_at: isoNow(), data: { job_id: result.job.id, status: result.job.status, attempt: result.job.attempt } });
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
        if (job.cost_decisions.some((item) => item.consumed_at == null)) {
          throw new DomainError("COST_CONFIRMATION_CONFLICT", "An unconsumed cost decision already exists.", { job_id, attempt });
        }
        const now = isoNow();
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
            const duplicate = state.artifacts.find((artifact) => artifact.job_id === job.id && ((input.source_artifact_id && artifact.source_artifact_id === input.source_artifact_id) || artifact.sha256 === sha256));
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
        job.error = succeeded === results.length ? null : { code: "ARTIFACT_IMPORT_FAILED", failed: results.length - succeeded, source: "imvia:import_result" };
        job.updated_at = isoNow();
        state.updated_at = job.updated_at;
        state.idempotency[idempotency_key] = { operation: "import_result", job_id, artifact_ids: artifactIds };
        return { job: clone(job), results, idempotent: false };
      });
      publish(listeners, { type: "job.updated", occurred_at: isoNow(), data: { job_id: result.job.id, status: result.job.status, attempt: result.job.attempt } });
      if (result.results.some((item) => item.ok)) publish(listeners, { type: "artifact.imported", occurred_at: isoNow(), data: { job_id: result.job.id, artifact_ids: result.results.filter((item) => item.ok).map((item) => item.artifact.id) } });
      return result;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
