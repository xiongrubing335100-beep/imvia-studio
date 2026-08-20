import path from "node:path";
import { createCostFingerprint } from "../../src/domain/cost-confirmation.js";
import { ACTIONS, nextOrchestrationAction, orderedReferenceIds } from "../../src/orchestration/policy.js";

async function readJob(service, jobId) {
  const state = await service.getState({ include: ["jobs"] });
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error(`Unknown IMVIA job: ${jobId}`);
  return job;
}

function currentCostFingerprint(job) {
  if (!job.estimated_cost) throw new Error(`Job ${job.id} has no sourced cost.`);
  return createCostFingerprint({
    job_id: job.id,
    attempt: job.attempt,
    amount: job.estimated_cost.amount,
    unit: job.estimated_cost.unit,
    checked_at: job.estimated_cost.checked_at,
    source: job.estimated_cost.source,
  });
}

function requireAction(action, expected) {
  if (action.type !== expected) throw new Error(`Unexpected policy action: ${action.type}`);
  return action;
}

export function createMockAgentRunner({ service, lovart, dataDirectory }) {
  if (!service || !lovart || !dataDirectory) throw new TypeError("service, lovart, and dataDirectory are required.");

  async function withReplan(jobId, operation) {
    try {
      return await operation();
    } catch (error) {
      if (!["STATUS_CONFLICT", "REVISION_CONFLICT"].includes(error.code)) throw error;
      const current = await readJob(service, jobId);
      return { action: ACTIONS.REPLAN, status: current.status, error: { code: error.code, details: error.details } };
    }
  }

  async function start(jobId) {
    const pending = await service.listPendingJobs();
    let job = pending.find((item) => item.id === jobId);
    if (!job) throw new Error(`Job ${jobId} is not pending.`);
    const begin = nextOrchestrationAction({ job });
    if (begin.type !== ACTIONS.BEGIN_UPLOAD) return { action: begin.type, status: job.status };
    job = (await service.updateJob({
      job_id: job.id,
      expected_status: "queued_for_agent",
      next_status: "uploading",
      attempt: job.attempt,
      source: "imvia:mock_agent",
    })).job;

    const state = await service.getState();
    const referenceIds = orderedReferenceIds(job.snapshot);
    const uploads = [];
    try {
      for (const referenceId of referenceIds) {
        const reference = state.references.find((item) => item.id === referenceId);
        if (!reference) throw Object.assign(new Error(`Missing reference ${referenceId}`), { code: "REFERENCE_BROKEN" });
        uploads.push(await lovart.lovart_upload({
          job_id: job.id,
          attempt: job.attempt,
          reference_id: referenceId,
          kind: reference.kind,
          local_path: reference.local_path,
        }));
      }
    } catch (error) {
      const action = requireAction(nextOrchestrationAction({ job, event: { type: "upload_failed" } }), ACTIONS.FAIL_JOB);
      const failed = await service.updateJob({
        job_id: job.id,
        expected_status: "uploading",
        next_status: "failed",
        attempt: job.attempt,
        source: "fixture:lovart_upload",
        error: { code: error.code ?? "UPLOAD_FAILED", message: error.message },
      });
      return { action: action.type, status: failed.job.status };
    }

    requireAction(nextOrchestrationAction({ job, event: { type: "uploads_succeeded" } }), ACTIONS.SUBMIT_GENERATION);
    job = (await service.updateJob({
      job_id: job.id,
      expected_status: "uploading",
      next_status: "submitted",
      attempt: job.attempt,
      source: "fixture:lovart_upload",
    })).job;

    let response;
    try {
      response = await lovart.lovart_generate({
        job_id: job.id,
        attempt: job.attempt,
        prompt: job.snapshot.prompt.text,
        model: job.snapshot.model,
        settings: job.snapshot.settings,
        uploads: uploads.map((item) => item.upload_id),
        reference_ids: referenceIds,
        lovart_thread_id: job.lovart_thread_id,
      });
    } catch (error) {
      const action = requireAction(nextOrchestrationAction({ job, event: { type: "submit_failed" } }), ACTIONS.FAIL_JOB);
      const failed = await service.updateJob({
        job_id: job.id,
        expected_status: "submitted",
        next_status: "failed",
        attempt: job.attempt,
        source: "fixture:lovart_generate",
        error: { code: error.code ?? "SUBMIT_FAILED", message: error.message },
      });
      return { action: action.type, status: failed.job.status };
    }

    const event = response.kind === "generation_started"
      ? { type: "generation_started" }
      : response.kind === "cost_confirmation"
        ? { type: "cost_confirmation" }
        : { type: response.kind };
    const action = nextOrchestrationAction({ job, event });
    if (action.type === ACTIONS.MARK_GENERATING) {
      const updated = await service.updateJob({
        job_id: job.id,
        expected_status: "submitted",
        next_status: "generating",
        attempt: job.attempt,
        source: "fixture:lovart_generate",
        lovart_thread_id: response.thread_id,
      });
      return { action: action.type, status: updated.job.status };
    }
    if (action.type === ACTIONS.WAIT_FOR_COST) {
      const updated = await service.updateJob({
        job_id: job.id,
        expected_status: "submitted",
        next_status: "awaiting_cost_confirmation",
        attempt: job.attempt,
        source: response.source,
        source_checked_at: response.checked_at,
        lovart_thread_id: response.thread_id,
        estimated_cost: { amount: response.amount, unit: response.unit },
      });
      return { action: action.type, status: updated.job.status, cost_fingerprint: currentCostFingerprint(updated.job) };
    }
    throw new Error(`Unexpected policy action: ${action.type}`);
  }

  async function answerCost({ job_id, decision, idempotency_key }) {
    const job = await readJob(service, job_id);
    const action = nextOrchestrationAction({ job: { ...job, cost_fingerprint: currentCostFingerprint(job) }, decision });
    if (action.type === ACTIONS.REQUEST_COST_CONFIRMATION || action.type === ACTIONS.REJECT_DECISION) {
      return { action: action.type, status: job.status };
    }
    const recorded = await service.recordCostDecision({
      job_id,
      attempt: job.attempt,
      cost_fingerprint: decision.cost_fingerprint,
      decision: decision.kind === "accepted" ? "accepted" : "declined",
      source: "user:current_session",
      idempotency_key,
    });
    if (action.type === ACTIONS.DECLINE_COST) return { action: action.type, status: recorded.job.status };
    requireAction(action, ACTIONS.CLAIM_COST_DECISION);
    const claimed = await service.claimCostDecision({
      decision_id: recorded.decision.decision_id,
      job_id,
      attempt: job.attempt,
      cost_fingerprint: decision.cost_fingerprint,
    });
    let confirmed;
    try {
      confirmed = await lovart.lovart_confirm({
        job_id,
        attempt: job.attempt,
        decision_id: claimed.decision.decision_id,
        cost_fingerprint: decision.cost_fingerprint,
      });
    } catch (error) {
      await service.updateJob({
        job_id,
        expected_status: "awaiting_cost_confirmation",
        next_status: "awaiting_cost_confirmation",
        attempt: job.attempt,
        source: "fixture:lovart_confirm",
        cost_decision_id: claimed.decision.decision_id,
        confirmation_evidence: {
          kind: "confirmation_failed",
          error: { code: error.code ?? "CONFIRMATION_FAILED", message: error.message },
        },
      });
      throw error;
    }
    if (confirmed.kind !== "confirmation_accepted") {
      const error = Object.assign(new Error("Fixture confirmation did not succeed."), { code: "CONFIRMATION_EVIDENCE_INVALID" });
      await service.updateJob({
        job_id,
        expected_status: "awaiting_cost_confirmation",
        next_status: "awaiting_cost_confirmation",
        attempt: job.attempt,
        source: "fixture:lovart_confirm",
        cost_decision_id: claimed.decision.decision_id,
        confirmation_evidence: { kind: "confirmation_failed", error: { code: error.code, message: error.message } },
      });
      throw error;
    }
    const updated = await service.updateJob({
      job_id,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: job.attempt,
      source: "fixture:lovart_confirm",
      cost_decision_id: claimed.decision.decision_id,
      confirmation_evidence: { kind: "confirmation_accepted" },
    });
    return { action: ACTIONS.MARK_GENERATING, status: updated.job.status };
  }

  async function poll(jobId) {
    const job = await readJob(service, jobId);
    if (job.status !== "generating") {
      const action = requireAction(nextOrchestrationAction({ job }), ACTIONS.STOP);
      return { action: action.type, status: job.status };
    }
    const response = await lovart.lovart_status({
      job_id: job.id,
      attempt: job.attempt,
      lovart_thread_id: job.lovart_thread_id,
    });
    const action = nextOrchestrationAction({ job, event: { type: response.kind } });
    if (action.type === ACTIONS.POLL_STATUS) return { action: action.type, status: job.status, reason: response.reason ?? null };
    if (action.type === ACTIONS.FAIL_JOB) {
      const failed = await service.updateJob({
        job_id: job.id,
        expected_status: "generating",
        next_status: "failed",
        attempt: job.attempt,
        source: "fixture:lovart_status",
        error: response.error,
      });
      return { action: action.type, status: failed.job.status };
    }
    requireAction(action, ACTIONS.FETCH_RESULT);
    const result = await lovart.lovart_result({
      job_id: job.id,
      attempt: job.attempt,
      lovart_thread_id: job.lovart_thread_id,
    });
    const artifacts = result.artifacts.map((artifact) => ({
      ...artifact,
      local_path: path.resolve(dataDirectory, artifact.local_path),
    }));
    const imported = await service.importResult({
      job_id: job.id,
      artifacts,
      idempotency_key: `fixture-result:${job.id}:${job.attempt}`,
    });
    return { action: action.type, status: imported.job.status, results: imported.results };
  }

  async function syncBilling() {
    const response = await lovart.lovart_query_billing_mode({});
    return service.updateAccountStatus({
      availability: "partial",
      billing_mode: response.billing_mode,
      credit_balance: null,
      credit_unit: null,
      balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
      source_tool: "fixture:lovart_query_billing_mode",
      checked_at: response.checked_at,
      expires_at: response.expires_at,
    });
  }

  return Object.freeze({
    syncBilling,
    start: (jobId) => withReplan(jobId, () => start(jobId)),
    answerCost: (input) => withReplan(input.job_id, () => answerCost(input)),
    poll: (jobId) => withReplan(jobId, () => poll(jobId)),
  });
}
