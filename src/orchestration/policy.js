export const ACTIONS = Object.freeze({
  BEGIN_UPLOAD: "begin_upload",
  SUBMIT_GENERATION: "submit_generation",
  WAIT_FOR_COST: "wait_for_cost_confirmation",
  REQUEST_COST_CONFIRMATION: "request_cost_confirmation",
  CLAIM_COST_DECISION: "claim_cost_decision",
  DECLINE_COST: "decline_cost",
  MARK_GENERATING: "mark_generating",
  POLL_STATUS: "poll_status",
  FETCH_RESULT: "fetch_result",
  FAIL_JOB: "fail_job",
  REJECT_DECISION: "reject_decision",
  REPLAN: "replan",
  STOP: "stop",
});

export class OrchestrationPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function orderedReferenceIds(snapshot) {
  const ordered = [];
  const seen = new Set();
  for (const token of snapshot?.prompt?.tokens ?? []) {
    if (typeof token.reference_id === "string" && !seen.has(token.reference_id)) {
      seen.add(token.reference_id);
      ordered.push(token.reference_id);
    }
  }
  for (const referenceId of snapshot?.reference_ids ?? []) {
    if (typeof referenceId === "string" && !seen.has(referenceId)) {
      seen.add(referenceId);
      ordered.push(referenceId);
    }
  }
  return ordered;
}

function result(type, details = {}) {
  return Object.freeze({ type, ...details });
}

function decisionMatches(job, decision) {
  return decision.job_id === job.id && decision.attempt === job.attempt && decision.cost_fingerprint === job.cost_fingerprint;
}

export function nextOrchestrationAction({ job, event = { type: "none" }, decision = { kind: "none" } }) {
  if (!job || typeof job.status !== "string") throw new OrchestrationPolicyError("ORCHESTRATION_INPUT_INVALID", "A job with status is required.");
  switch (job.status) {
    case "queued_for_agent":
      if (event.type === "none") return result(ACTIONS.BEGIN_UPLOAD);
      break;
    case "uploading":
      if (event.type === "uploads_succeeded") return result(ACTIONS.SUBMIT_GENERATION);
      if (event.type === "upload_failed") return result(ACTIONS.FAIL_JOB);
      break;
    case "submitted":
      if (event.type === "generation_started") return result(ACTIONS.MARK_GENERATING);
      if (event.type === "cost_confirmation") return result(ACTIONS.WAIT_FOR_COST);
      if (event.type === "submit_failed") return result(ACTIONS.FAIL_JOB);
      break;
    case "awaiting_cost_confirmation":
      if (event.type !== "none") break;
      if (["none", "ambiguous"].includes(decision.kind)) return result(ACTIONS.REQUEST_COST_CONFIRMATION);
      if (!["accepted", "declined"].includes(decision.kind) || !decisionMatches(job, decision)) return result(ACTIONS.REJECT_DECISION);
      return result(decision.kind === "accepted" ? ACTIONS.CLAIM_COST_DECISION : ACTIONS.DECLINE_COST);
    case "generating":
      if (["status_pending", "local_timeout"].includes(event.type)) return result(ACTIONS.POLL_STATUS);
      if (["status_succeeded", "status_partially_succeeded"].includes(event.type)) return result(ACTIONS.FETCH_RESULT);
      if (event.type === "status_failed") return result(ACTIONS.FAIL_JOB);
      break;
    case "declined":
    case "succeeded":
    case "partially_succeeded":
    case "failed":
    case "cancelled":
      return result(ACTIONS.STOP);
    default:
      throw new OrchestrationPolicyError("ORCHESTRATION_STATUS_UNKNOWN", `Unknown job status: ${job.status}`, { status: job.status });
  }
  throw new OrchestrationPolicyError("ORCHESTRATION_EVENT_UNKNOWN", `Event ${event.type} is invalid for ${job.status}.`, { status: job.status, event: event.type });
}
