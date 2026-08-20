import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCostFingerprint } from "../src/domain/cost-confirmation.js";
import { createWorkbenchService } from "../src/domain/workbench-service.js";

async function createSubmittedCostJob(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-cost-confirmation-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const service = createWorkbenchService({ dataDirectory });
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Create an awaiting-cost fixture task.",
    patch: { model: "Seedance 2.5", "prompt.text": "Awaiting cost fixture.", "settings.duration_seconds": 10 },
  });
  const { job } = await service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: `cost-job:${initial.draft.id}` });
  await service.updateJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "fixture:cost_upload" });
  await service.updateJob({ job_id: job.id, expected_status: "uploading", next_status: "submitted", attempt: 1, source: "fixture:cost_submit" });
  return { dataDirectory, service, job };
}

async function createAwaitingCostJob(context) {
  const fixture = await createSubmittedCostJob(context);
  const { service, job } = fixture;
  await service.updateJob({
    job_id: job.id,
    expected_status: "submitted",
    next_status: "awaiting_cost_confirmation",
    attempt: 1,
    source: "fixture:cost",
    source_checked_at: "2026-08-20T00:00:00.000Z",
    estimated_cost: { amount: 135, unit: "credits" },
  });
  return fixture;
}

function fingerprintFor(job) {
  return createCostFingerprint({
    job_id: job.id,
    attempt: 1,
    amount: 135,
    unit: "credits",
    checked_at: "2026-08-20T00:00:00.000Z",
    source: "fixture:cost",
  });
}

test("creates a stable canonical cost fingerprint", () => {
  assert.equal(createCostFingerprint({
    job_id: "job-1",
    attempt: 1,
    amount: 135,
    unit: "credits",
    checked_at: "2026-08-20T00:00:00.000Z",
    source: "fixture:cost",
  }), "949f14fbcf0d339088f25b6bfda113d476b99792b63c2e1087cfae63147158e1");
});

test("rejects malformed and non-canonical cost timestamps before fingerprinting", () => {
  for (const checked_at of [
    "not-a-date",
    "2026-08-20T00:00:00Z",
    "2026-08-20T08:00:00.000+08:00",
    "2026-02-30T00:00:00.000Z",
  ]) {
    assert.throws(
      () => createCostFingerprint({ job_id: "job-1", attempt: 1, amount: 135, unit: "credits", checked_at, source: "fixture:cost" }),
      (error) => error.code === "VALIDATION_FAILED" && error.details.field === "checked_at",
      checked_at,
    );
  }
});

test("records, claims, and consumes one accepted cost decision", async (context) => {
  const { service, job } = await createAwaitingCostJob(context);
  const fingerprint = fingerprintFor(job);
  const recorded = await service.recordCostDecision({ job_id: job.id, attempt: 1, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "decision-1" });
  assert.equal(recorded.job.status, "awaiting_cost_confirmation");
  assert.equal(recorded.decision.consumed_at, null);

  const claimed = await service.claimCostDecision({ decision_id: recorded.decision.decision_id, job_id: job.id, attempt: 1, cost_fingerprint: fingerprint });
  assert.ok(claimed.decision.consumed_at);
  await assert.rejects(() => service.claimCostDecision({ decision_id: recorded.decision.decision_id, job_id: job.id, attempt: 1, cost_fingerprint: fingerprint }), (error) => error.code === "COST_CONFIRMATION_CONFLICT");
});

test("declines atomically and never permits a generating transition without a consumed acceptance", async (context) => {
  const first = await createAwaitingCostJob(context);
  await assert.rejects(
    () => first.service.updateJob({ job_id: first.job.id, expected_status: "awaiting_cost_confirmation", next_status: "generating", attempt: 1, source: "fixture:confirm" }),
    (error) => error.code === "COST_CONFIRMATION_REQUIRED",
  );

  const second = await createAwaitingCostJob(context);
  const declined = await second.service.recordCostDecision({ job_id: second.job.id, attempt: 1, cost_fingerprint: fingerprintFor(second.job), decision: "declined", source: "user:current_session", idempotency_key: "decline-1" });
  assert.equal(declined.job.status, "declined");
});

test("binds a cost-decision idempotency key to the complete normalized request", async (context) => {
  const { service, job } = await createAwaitingCostJob(context);
  const cost_fingerprint = fingerprintFor(job);
  const request = { job_id: job.id, attempt: 1, cost_fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "bound-decision" };
  const first = await service.recordCostDecision(request);
  assert.equal(first.idempotent, false);
  await service.claimCostDecision({ decision_id: first.decision.decision_id, job_id: job.id, attempt: 1, cost_fingerprint });
  await service.updateJob({
    job_id: job.id,
    expected_status: "awaiting_cost_confirmation",
    next_status: "generating",
    attempt: 1,
    source: "fixture:confirm",
    cost_decision_id: first.decision.decision_id,
    confirmation_evidence: { kind: "confirmation_accepted" },
  });
  const replay = await service.recordCostDecision(request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.job.status, "awaiting_cost_confirmation");
  assert.equal(replay.decision.decision_id, first.decision.decision_id);
  assert.equal(replay.decision.consumed_at, null);

  await assert.rejects(
    () => service.recordCostDecision({ ...request, decision: "declined" }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => service.recordCostDecision({ ...request, attempt: 2 }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => service.recordCostDecision({ ...request, cost_fingerprint: "0".repeat(64) }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () => service.recordCostDecision({ ...request, source: "fixture:cost" }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("requires a complete cost only on submitted to awaiting and preserves it immutably", async (context) => {
  const incomplete = await createSubmittedCostJob(context);
  await assert.rejects(
    () => incomplete.service.updateJob({
      job_id: incomplete.job.id,
      expected_status: "submitted",
      next_status: "awaiting_cost_confirmation",
      attempt: 1,
      source: "fixture:cost",
    }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "estimated_cost",
  );
  const stillSubmitted = (await incomplete.service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === incomplete.job.id);
  assert.equal(stillSubmitted.status, "submitted");
  assert.equal(stillSubmitted.estimated_cost, null);

  const { service, job } = await createAwaitingCostJob(context);

  await assert.rejects(
    () => service.updateJob({
      job_id: job.id,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: 1,
      source: "fixture:confirm",
      source_checked_at: "2026-08-20T00:01:00.000Z",
      estimated_cost: { amount: 999, unit: "credits" },
    }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "estimated_cost",
  );

  const persisted = (await service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === job.id);
  assert.equal(persisted.status, "awaiting_cost_confirmation");
  assert.deepEqual(persisted.estimated_cost, {
    amount: 135,
    unit: "credits",
    source: "fixture:cost",
    checked_at: "2026-08-20T00:00:00.000Z",
  });
});

test("requires matching claimed decision and explicit confirmation success evidence", async (context) => {
  const { service, job } = await createAwaitingCostJob(context);
  const cost_fingerprint = fingerprintFor(job);
  const recorded = await service.recordCostDecision({
    job_id: job.id,
    attempt: 1,
    cost_fingerprint,
    decision: "accepted",
    source: "user:current_session",
    idempotency_key: "evidence-gate",
  });
  await service.claimCostDecision({ decision_id: recorded.decision.decision_id, job_id: job.id, attempt: 1, cost_fingerprint });

  await assert.rejects(
    () => service.updateJob({ job_id: job.id, expected_status: "awaiting_cost_confirmation", next_status: "generating", attempt: 1, source: "fixture:confirm" }),
    (error) => error.code === "COST_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    () => service.updateJob({
      job_id: job.id,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: 1,
      source: "fixture:confirm",
      cost_decision_id: "wrong-decision",
      confirmation_evidence: { kind: "confirmation_accepted" },
    }),
    (error) => error.code === "COST_CONFIRMATION_CONFLICT",
  );

  const updated = await service.updateJob({
    job_id: job.id,
    expected_status: "awaiting_cost_confirmation",
    next_status: "generating",
    attempt: 1,
    source: "fixture:confirm",
    cost_decision_id: recorded.decision.decision_id,
    confirmation_evidence: { kind: "confirmation_accepted" },
  });
  assert.equal(updated.job.status, "generating");
  assert.equal(updated.job.cost_decisions[0].confirmation.status, "succeeded");
  assert.equal(updated.job.cost_decisions[0].confirmation.source, "fixture:confirm");
});

test("persists confirmation failure and requires a newly accepted decision for retry", async (context) => {
  const { service, job } = await createAwaitingCostJob(context);
  const cost_fingerprint = fingerprintFor(job);
  const first = await service.recordCostDecision({ job_id: job.id, attempt: 1, cost_fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "first-acceptance" });
  await service.claimCostDecision({ decision_id: first.decision.decision_id, job_id: job.id, attempt: 1, cost_fingerprint });
  await service.updateJob({
    job_id: job.id,
    expected_status: "awaiting_cost_confirmation",
    next_status: "awaiting_cost_confirmation",
    attempt: 1,
    source: "fixture:confirm",
    cost_decision_id: first.decision.decision_id,
    confirmation_evidence: { kind: "confirmation_failed", error: { code: "CONFIRM_FIXTURE_FAILED", message: "Fixture confirmation failed." } },
  });

  await assert.rejects(
    () => service.updateJob({
      job_id: job.id,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: 1,
      source: "fixture:confirm",
      cost_decision_id: first.decision.decision_id,
      confirmation_evidence: { kind: "confirmation_accepted" },
    }),
    (error) => error.code === "COST_CONFIRMATION_CONFLICT",
  );

  const second = await service.recordCostDecision({ job_id: job.id, attempt: 1, cost_fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "second-acceptance" });
  await service.claimCostDecision({ decision_id: second.decision.decision_id, job_id: job.id, attempt: 1, cost_fingerprint });
  const generated = await service.updateJob({
    job_id: job.id,
    expected_status: "awaiting_cost_confirmation",
    next_status: "generating",
    attempt: 1,
    source: "fixture:confirm",
    cost_decision_id: second.decision.decision_id,
    confirmation_evidence: { kind: "confirmation_accepted" },
  });
  assert.equal(generated.job.status, "generating");
  assert.equal(generated.job.cost_decisions[0].confirmation.status, "failed");
  assert.equal(generated.job.cost_decisions[1].confirmation.status, "succeeded");
});

test("rejects a malformed cost checked time without persisting an awaiting-cost job", async (context) => {
  const { service, job } = await createSubmittedCostJob(context);
  const persistedBefore = (await service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === job.id);

  await assert.rejects(
    () => service.updateJob({
      job_id: job.id,
      expected_status: "submitted",
      next_status: "awaiting_cost_confirmation",
      attempt: 1,
      source: "fixture:cost",
      source_checked_at: "tomorrow",
      estimated_cost: { amount: 999, unit: "credits" },
    }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "source_checked_at",
  );

  const persistedAfter = (await service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === job.id);
  assert.deepEqual(persistedAfter, persistedBefore);
});

test("replays a legacy cost-decision entry without a response snapshot", async (context) => {
  const { dataDirectory, service, job } = await createAwaitingCostJob(context);
  const cost_fingerprint = fingerprintFor(job);
  const request = { job_id: job.id, attempt: 1, cost_fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "legacy-decision" };
  const first = await service.recordCostDecision(request);
  const statePath = path.join(dataDirectory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.idempotency[request.idempotency_key].response;
  delete state.idempotency[request.idempotency_key].receipt;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const replay = await service.recordCostDecision(request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.job.id, first.job.id);
  assert.equal(replay.job.status, "awaiting_cost_confirmation");
  assert.equal(replay.decision.decision_id, first.decision.decision_id);
  assert.equal(replay.decision.consumed_at, null);
  await assert.rejects(
    () => service.recordCostDecision({ ...request, decision: "declined" }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});
