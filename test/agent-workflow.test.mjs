import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { ACTIONS } from "../src/orchestration/policy.js";
import { createFakeLovartAdapter } from "./support/fake-lovart-adapter.mjs";
import { createMockAgentRunner } from "./support/mock-agent-runner.mjs";

const fixturesDirectory = new URL("./fixtures/", import.meta.url);

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixturesDirectory), "utf8"));
}

async function createHarness(context, fixture) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-agent-workflow-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const service = createWorkbenchService({ dataDirectory });
  const lovart = createFakeLovartAdapter(fixture);
  const runner = createMockAgentRunner({ service, lovart, dataDirectory });
  return { dataDirectory, service, lovart, runner };
}

async function prepareSimpleJob(service, prompt, idempotencyKey = "simple-workflow-job") {
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Prepare a simple fixture task.",
    patch: {
      model: "Seedance 2.5",
      "prompt.text": prompt,
      "settings.duration_seconds": 10,
    },
  });
  return (await service.prepareGeneration({
    draft_id: initial.draft.id,
    expected_revision: 1,
    idempotency_key: idempotencyKey,
  })).job;
}

async function prepareReferencedJob(harness, prompt) {
  const initial = await harness.service.getState();
  const statePath = path.join(harness.dataDirectory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.references.push(
    { id: "image-1", project_id: state.current_project_id, kind: "image", status: "ready", local_path: path.join(harness.dataDirectory, "references/image.png") },
    { id: "video-1", project_id: state.current_project_id, kind: "video", status: "ready", local_path: path.join(harness.dataDirectory, "references/video.mp4") },
    { id: "audio-1", project_id: state.current_project_id, kind: "audio", status: "ready", local_path: path.join(harness.dataDirectory, "references/audio.mp3") },
  );
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await harness.service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Prepare exact-order fixture references.",
    patch: {
      model: "Seedance 2.5",
      "prompt.text": prompt,
      "prompt.tokens": [{ reference_id: "video-1", display: "视频1" }, { reference_id: "image-1", display: "图片1" }],
      reference_ids: ["image-1", "audio-1", "video-1"],
      "settings.duration_seconds": 10,
    },
  });
  return (await harness.service.prepareGeneration({
    draft_id: initial.draft.id,
    expected_revision: 1,
    idempotency_key: "exact-reference-order",
  })).job;
}

async function createSucceededParentHarness(context) {
  const fixture = {
    name: "succeeded-parent",
    script: [
      { tool: "lovart_generate", response: { kind: "generation_started", thread_id: "fixture-thread-parent" } },
      { tool: "lovart_status", response: { kind: "status_succeeded" } },
      { tool: "lovart_result", response: { artifacts: [{ kind: "video", local_path: "results/parent.mp4", mime_type: "video/mp4", source_artifact_id: "fixture-parent-video" }] } },
    ],
  };
  const harness = await createHarness(context, fixture);
  await mkdir(path.join(harness.dataDirectory, "results"), { recursive: true });
  await writeFile(path.join(harness.dataDirectory, "results/parent.mp4"), "fixture-parent-video-bytes");
  const prepared = await prepareSimpleJob(harness.service, "Parent workflow fixture.", "workflow-parent");
  await harness.runner.start(prepared.id);
  const finished = await harness.runner.poll(prepared.id);
  assert.deepEqual(harness.lovart.ledger, [
    {
      index: 0,
      tool: "lovart_generate",
      arguments: {
        job_id: prepared.id,
        attempt: 1,
        prompt: "Parent workflow fixture.",
        model: "Seedance 2.5",
        settings: prepared.snapshot.settings,
        uploads: [],
        reference_ids: [],
        lovart_thread_id: null,
      },
    },
    { index: 1, tool: "lovart_status", arguments: { job_id: prepared.id, attempt: 1, lovart_thread_id: "fixture-thread-parent" } },
    { index: 2, tool: "lovart_result", arguments: { job_id: prepared.id, attempt: 1, lovart_thread_id: "fixture-thread-parent" } },
  ]);
  harness.lovart.assertComplete();
  const state = await harness.service.getState({ include: ["jobs", "artifacts"] });
  return {
    ...harness,
    job: state.jobs.find((job) => job.id === finished.results[0].artifact.job_id),
    artifact: state.artifacts[0],
  };
}

function confirmCount(harness) {
  return harness.lovart.ledger.filter((entry) => entry.tool === "lovart_confirm").length;
}

test("sends the immutable prompt byte-for-byte and imports direct success once", async (context) => {
  const fixture = await loadFixture("orchestration-direct-success.json");
  const harness = await createHarness(context, fixture);
  await mkdir(path.join(harness.dataDirectory, "results"), { recursive: true });
  await writeFile(path.join(harness.dataDirectory, "results/direct.mp4"), "fixture-direct-video-bytes");
  const job = await prepareReferencedJob(harness, "雨夜街道\nKeep @视频1 and @图片1 unchanged.");
  const started = await harness.runner.start(job.id);
  assert.equal(started.status, "generating");
  const finished = await harness.runner.poll(job.id);
  assert.equal(finished.status, "succeeded");
  assert.equal((await harness.service.getState({ include: ["artifacts"] })).artifacts.length, 1);
  assert.deepEqual(harness.lovart.ledger, [
    {
      index: 0,
      tool: "lovart_upload",
      arguments: {
        job_id: job.id,
        attempt: 1,
        reference_id: "video-1",
        kind: "video",
        local_path: path.join(harness.dataDirectory, "references/video.mp4"),
      },
    },
    {
      index: 1,
      tool: "lovart_upload",
      arguments: {
        job_id: job.id,
        attempt: 1,
        reference_id: "image-1",
        kind: "image",
        local_path: path.join(harness.dataDirectory, "references/image.png"),
      },
    },
    {
      index: 2,
      tool: "lovart_upload",
      arguments: {
        job_id: job.id,
        attempt: 1,
        reference_id: "audio-1",
        kind: "audio",
        local_path: path.join(harness.dataDirectory, "references/audio.mp3"),
      },
    },
    {
      index: 3,
      tool: "lovart_generate",
      arguments: {
        job_id: job.id,
        attempt: 1,
        prompt: "雨夜街道\nKeep @视频1 and @图片1 unchanged.",
        model: "Seedance 2.5",
        settings: job.snapshot.settings,
        uploads: ["fixture-upload-video-1", "fixture-upload-image-1", "fixture-upload-audio-1"],
        reference_ids: ["video-1", "image-1", "audio-1"],
        lovart_thread_id: null,
      },
    },
    { index: 4, tool: "lovart_status", arguments: { job_id: job.id, attempt: 1, lovart_thread_id: "fixture-thread-direct" } },
    { index: 5, tool: "lovart_result", arguments: { job_id: job.id, attempt: 1, lovart_thread_id: "fixture-thread-direct" } },
  ]);
  assert.deepEqual(Buffer.from(harness.lovart.ledger[3].arguments.prompt, "utf8"), Buffer.from(job.snapshot.prompt.text, "utf8"));
  harness.lovart.assertComplete();
});

test("pauses for sourced cost and confirms exactly one matching acceptance", async (context) => {
  const fixture = await loadFixture("orchestration-cost-success.json");
  const harness = await createHarness(context, fixture);
  await mkdir(path.join(harness.dataDirectory, "results"), { recursive: true });
  await writeFile(path.join(harness.dataDirectory, "results/cost.mp4"), "fixture-cost-video-bytes");
  const job = await prepareSimpleJob(harness.service, "Cost fixture.");
  const paused = await harness.runner.start(job.id);
  assert.equal(paused.status, "awaiting_cost_confirmation");
  assert.equal(confirmCount(harness), 0);

  const ambiguous = await harness.runner.answerCost({
    job_id: job.id,
    decision: { kind: "ambiguous" },
    idempotency_key: "ambiguous",
  });
  assert.equal(ambiguous.action, ACTIONS.REQUEST_COST_CONFIRMATION);
  assert.equal(confirmCount(harness), 0);

  const accepted = await harness.runner.answerCost({
    job_id: job.id,
    decision: { kind: "accepted", job_id: job.id, attempt: 1, cost_fingerprint: paused.cost_fingerprint },
    idempotency_key: "accept-cost",
  });
  assert.equal(accepted.status, "generating");
  assert.equal(confirmCount(harness), 1);
  const confirmedJob = (await harness.service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === job.id);
  const finished = await harness.runner.poll(job.id);
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(harness.lovart.ledger, [
    {
      index: 0,
      tool: "lovart_generate",
      arguments: {
        job_id: job.id,
        attempt: 1,
        prompt: "Cost fixture.",
        model: "Seedance 2.5",
        settings: job.snapshot.settings,
        uploads: [],
        reference_ids: [],
        lovart_thread_id: null,
      },
    },
    {
      index: 1,
      tool: "lovart_confirm",
      arguments: {
        job_id: job.id,
        attempt: 1,
        decision_id: confirmedJob.cost_decisions[0].decision_id,
        cost_fingerprint: paused.cost_fingerprint,
      },
    },
    { index: 2, tool: "lovart_status", arguments: { job_id: job.id, attempt: 1, lovart_thread_id: "fixture-thread-cost" } },
    { index: 3, tool: "lovart_result", arguments: { job_id: job.id, attempt: 1, lovart_thread_id: "fixture-thread-cost" } },
  ]);
  harness.lovart.assertComplete();
});

test("declines a matching cost without confirming", async (context) => {
  const costFixture = await loadFixture("orchestration-cost-success.json");
  const fixture = { ...costFixture, name: "cost-decline", script: costFixture.script.slice(0, 1) };
  const harness = await createHarness(context, fixture);
  const job = await prepareSimpleJob(harness.service, "Decline cost fixture.");
  const paused = await harness.runner.start(job.id);
  const declined = await harness.runner.answerCost({
    job_id: job.id,
    decision: { kind: "declined", job_id: job.id, attempt: 1, cost_fingerprint: paused.cost_fingerprint },
    idempotency_key: "decline-cost",
  });
  assert.equal(declined.status, "declined");
  assert.equal(confirmCount(harness), 0);
  assert.deepEqual(harness.lovart.ledger, [{
    index: 0,
    tool: "lovart_generate",
    arguments: {
      job_id: job.id,
      attempt: 1,
      prompt: "Decline cost fixture.",
      model: "Seedance 2.5",
      settings: job.snapshot.settings,
      uploads: [],
      reference_ids: [],
      lovart_thread_id: null,
    },
  }]);
  harness.lovart.assertComplete();
});

test("rejects stale job, stale attempt, and wrong fingerprint decisions without confirming", async (context) => {
  const cases = [
    { name: "stale-job", mutate: (decision) => ({ ...decision, job_id: "stale-job-id" }) },
    { name: "stale-attempt", mutate: (decision) => ({ ...decision, attempt: 2 }) },
    { name: "wrong-fingerprint", mutate: (decision) => ({ ...decision, cost_fingerprint: "0".repeat(64) }) },
  ];
  for (const fixtureCase of cases) {
    await context.test(fixtureCase.name, async (subcontext) => {
      const costFixture = await loadFixture("orchestration-cost-success.json");
      const fixture = { ...costFixture, name: `cost-${fixtureCase.name}`, script: costFixture.script.slice(0, 1) };
      const harness = await createHarness(subcontext, fixture);
      const job = await prepareSimpleJob(harness.service, `Cost rejection ${fixtureCase.name}.`);
      const paused = await harness.runner.start(job.id);
      const current = { kind: "accepted", job_id: job.id, attempt: 1, cost_fingerprint: paused.cost_fingerprint };
      const rejected = await harness.runner.answerCost({ job_id: job.id, decision: fixtureCase.mutate(current), idempotency_key: fixtureCase.name });
      assert.equal(rejected.action, ACTIONS.REJECT_DECISION);
      assert.equal(rejected.status, "awaiting_cost_confirmation");
      assert.equal(confirmCount(harness), 0);
      assert.deepEqual(harness.lovart.ledger, [{
        index: 0,
        tool: "lovart_generate",
        arguments: {
          job_id: job.id,
          attempt: 1,
          prompt: `Cost rejection ${fixtureCase.name}.`,
          model: "Seedance 2.5",
          settings: job.snapshot.settings,
          uploads: [],
          reference_ids: [],
          lovart_thread_id: null,
        },
      }]);
      harness.lovart.assertComplete();
    });
  }
});

test("upload failure stops before generate", async (context) => {
  const failures = await loadFixture("orchestration-failures.json");
  const harness = await createHarness(context, failures.upload_failure);
  const job = await prepareReferencedJob(harness, "Use @视频1 and @图片1.");
  const result = await harness.runner.start(job.id);
  assert.equal(result.action, ACTIONS.FAIL_JOB);
  assert.equal(result.status, "failed");
  assert.deepEqual(harness.lovart.ledger, [{
    index: 0,
    tool: "lovart_upload",
    arguments: {
      job_id: job.id,
      attempt: 1,
      reference_id: "video-1",
      kind: "video",
      local_path: path.join(harness.dataDirectory, "references/video.mp4"),
    },
  }]);
  harness.lovart.assertComplete();
});

test("thrown submit failure is policy-failed once without thread, cost, retry, or fallback", async (context) => {
  const failures = await loadFixture("orchestration-failures.json");
  const harness = await createHarness(context, failures.submit_failure);
  const prepared = await prepareSimpleJob(harness.service, "Submit failure fixture.");
  const failed = await harness.runner.start(prepared.id);
  assert.equal(failed.action, ACTIONS.FAIL_JOB);
  assert.equal(failed.status, "failed");
  const job = (await harness.service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === prepared.id);
  assert.deepEqual(job.error, { code: "SUBMIT_FIXTURE_FAILED", message: "Fixture submit failed.", source: "fixture:lovart_generate" });
  assert.equal(job.lovart_thread_id, null);
  assert.equal(job.estimated_cost, null);
  const expectedLedger = [{
    index: 0,
    tool: "lovart_generate",
    arguments: {
      job_id: prepared.id,
      attempt: 1,
      prompt: "Submit failure fixture.",
      model: "Seedance 2.5",
      settings: prepared.snapshot.settings,
      uploads: [],
      reference_ids: [],
      lovart_thread_id: null,
    },
  }];
  assert.deepEqual(harness.lovart.ledger, expectedLedger);
  harness.lovart.assertComplete();
  assert.deepEqual(await harness.runner.poll(job.id), { action: ACTIONS.STOP, status: "failed" });
  await assert.rejects(() => harness.runner.start(job.id), /is not pending/);
  assert.deepEqual(harness.lovart.ledger, expectedLedger);
});

test("failed confirmation consumes its decision and only a new explicit acceptance may confirm", async (context) => {
  const failures = await loadFixture("orchestration-failures.json");
  const harness = await createHarness(context, failures.confirmation_failure);
  const prepared = await prepareSimpleJob(harness.service, "Confirmation failure fixture.");
  const paused = await harness.runner.start(prepared.id);
  const decision = { kind: "accepted", job_id: prepared.id, attempt: 1, cost_fingerprint: paused.cost_fingerprint };

  await assert.rejects(
    () => harness.runner.answerCost({ job_id: prepared.id, decision, idempotency_key: "failed-confirm" }),
    (error) => error.code === "CONFIRM_FIXTURE_FAILED",
  );
  let job = (await harness.service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === prepared.id);
  assert.equal(job.status, "awaiting_cost_confirmation");
  assert.equal(job.cost_decisions.length, 1);
  assert.ok(job.cost_decisions[0].consumed_at);
  assert.deepEqual(job.cost_decisions[0].confirmation, {
    status: "failed",
    source: "fixture:lovart_confirm",
    recorded_at: job.cost_decisions[0].confirmation.recorded_at,
    error: { code: "CONFIRM_FIXTURE_FAILED", message: "Fixture confirmation failed." },
  });
  const firstDecisionId = job.cost_decisions[0].decision_id;
  assert.equal(confirmCount(harness), 1);

  await assert.rejects(
    () => harness.service.updateJob({
      job_id: prepared.id,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: 1,
      source: "fixture:lovart_confirm",
      cost_decision_id: firstDecisionId,
      confirmation_evidence: { kind: "confirmation_accepted" },
    }),
    (error) => error.code === "COST_CONFIRMATION_CONFLICT",
  );
  assert.equal(confirmCount(harness), 1);

  await assert.rejects(
    () => harness.runner.answerCost({ job_id: prepared.id, decision, idempotency_key: "failed-confirm" }),
    (error) => error.code === "COST_CONFIRMATION_CONFLICT",
  );
  assert.equal(confirmCount(harness), 1);

  const retried = await harness.runner.answerCost({ job_id: prepared.id, decision, idempotency_key: "new-explicit-acceptance" });
  assert.equal(retried.status, "generating");
  assert.equal(confirmCount(harness), 2);
  job = (await harness.service.getState({ include: ["jobs"] })).jobs.find((item) => item.id === prepared.id);
  assert.equal(job.cost_decisions.length, 2);
  assert.notEqual(job.cost_decisions[1].decision_id, firstDecisionId);
  assert.ok(job.cost_decisions[1].consumed_at);
  assert.equal(job.cost_decisions[1].confirmation.status, "succeeded");
  assert.deepEqual(harness.lovart.ledger, [
    {
      index: 0,
      tool: "lovart_generate",
      arguments: {
        job_id: prepared.id,
        attempt: 1,
        prompt: "Confirmation failure fixture.",
        model: "Seedance 2.5",
        settings: prepared.snapshot.settings,
        uploads: [],
        reference_ids: [],
        lovart_thread_id: null,
      },
    },
    {
      index: 1,
      tool: "lovart_confirm",
      arguments: {
        job_id: prepared.id,
        attempt: 1,
        decision_id: firstDecisionId,
        cost_fingerprint: paused.cost_fingerprint,
      },
    },
    {
      index: 2,
      tool: "lovart_confirm",
      arguments: {
        job_id: prepared.id,
        attempt: 1,
        decision_id: job.cost_decisions[1].decision_id,
        cost_fingerprint: paused.cost_fingerprint,
      },
    },
  ]);
  harness.lovart.assertComplete();
});

test("explicit failure terminates while local timeout stays generating", async (context) => {
  const failures = await loadFixture("orchestration-failures.json");
  const failedHarness = await createHarness(context, failures.generation_failure);
  const failedJob = await prepareSimpleJob(failedHarness.service, "Failure fixture.");
  await failedHarness.runner.start(failedJob.id);
  assert.equal((await failedHarness.runner.poll(failedJob.id)).status, "failed");
  const persistedFailure = (await failedHarness.service.getState({ include: ["jobs"] })).jobs.find((job) => job.id === failedJob.id);
  assert.equal(persistedFailure.error.source, "fixture:lovart_status");
  assert.equal(persistedFailure.error.code, "GENERATION_FAILED");
  assert.deepEqual(failedHarness.lovart.ledger, [
    {
      index: 0,
      tool: "lovart_generate",
      arguments: {
        job_id: failedJob.id,
        attempt: 1,
        prompt: "Failure fixture.",
        model: "Seedance 2.5",
        settings: failedJob.snapshot.settings,
        uploads: [],
        reference_ids: [],
        lovart_thread_id: null,
      },
    },
    { index: 1, tool: "lovart_status", arguments: { job_id: failedJob.id, attempt: 1, lovart_thread_id: "fixture-thread-failed" } },
  ]);
  failedHarness.lovart.assertComplete();

  const timeoutHarness = await createHarness(context, failures.local_timeout);
  const timeoutJob = await prepareSimpleJob(timeoutHarness.service, "Timeout fixture.");
  await timeoutHarness.runner.start(timeoutJob.id);
  assert.equal((await timeoutHarness.runner.poll(timeoutJob.id)).status, "generating");
  assert.deepEqual(timeoutHarness.lovart.ledger, [
    {
      index: 0,
      tool: "lovart_generate",
      arguments: {
        job_id: timeoutJob.id,
        attempt: 1,
        prompt: "Timeout fixture.",
        model: "Seedance 2.5",
        settings: timeoutJob.snapshot.settings,
        uploads: [],
        reference_ids: [],
        lovart_thread_id: null,
      },
    },
    { index: 1, tool: "lovart_status", arguments: { job_id: timeoutJob.id, attempt: 1, lovart_thread_id: "fixture-thread-timeout" } },
  ]);
  timeoutHarness.lovart.assertComplete();
});

test("partial result imports one valid artifact and duplicate writeback is idempotent", async (context) => {
  const failures = await loadFixture("orchestration-failures.json");
  const harness = await createHarness(context, failures.partial_result);
  await mkdir(path.join(harness.dataDirectory, "results"), { recursive: true });
  await writeFile(path.join(harness.dataDirectory, "results/partial-ok.mp4"), "fixture-partial-video");
  const job = await prepareSimpleJob(harness.service, "Partial fixture.");
  await harness.runner.start(job.id);
  const partial = await harness.runner.poll(job.id);
  assert.equal(partial.status, "partially_succeeded");
  const successful = partial.results.filter((item) => item.ok).map((item) => ({
    kind: item.artifact.kind,
    local_path: item.artifact.local_path,
    mime_type: item.artifact.mime_type,
    source_artifact_id: item.artifact.source_artifact_id,
  }));
  const duplicate = await harness.service.importResult({ job_id: job.id, artifacts: successful, idempotency_key: `fixture-result:${job.id}:${job.attempt}` });
  assert.equal(duplicate.idempotent, true);
  assert.equal((await harness.service.getState({ include: ["artifacts"] })).artifacts.length, 1);
  assert.deepEqual(harness.lovart.ledger, [
    {
      index: 0,
      tool: "lovart_generate",
      arguments: {
        job_id: job.id,
        attempt: 1,
        prompt: "Partial fixture.",
        model: "Seedance 2.5",
        settings: job.snapshot.settings,
        uploads: [],
        reference_ids: [],
        lovart_thread_id: null,
      },
    },
    { index: 1, tool: "lovart_status", arguments: { job_id: job.id, attempt: 1, lovart_thread_id: "fixture-thread-partial" } },
    { index: 2, tool: "lovart_result", arguments: { job_id: job.id, attempt: 1, lovart_thread_id: "fixture-thread-partial" } },
  ]);
  harness.lovart.assertComplete();
});

test("billing mode keeps upstream-unavailable balance null", async (context) => {
  const failures = await loadFixture("orchestration-failures.json");
  const harness = await createHarness(context, failures.billing);
  await harness.runner.syncBilling();
  const { account_status } = await harness.service.getAccountStatus({ max_age_seconds: 86400 });
  assert.equal(account_status.billing_mode, "fast");
  assert.equal(account_status.credit_balance, null);
  assert.equal(account_status.credit_unit, null);
  assert.equal(account_status.balance_reason, "UPSTREAM_CAPABILITY_UNAVAILABLE");
  assert.deepEqual(harness.lovart.ledger, [{ index: 0, tool: "lovart_query_billing_mode", arguments: {} }]);
  harness.lovart.assertComplete();
});

test("status conflict replans without replaying a fake call", async (context) => {
  const fixture = await loadFixture("orchestration-direct-success.json");
  const harness = await createHarness(context, fixture);
  const job = await prepareSimpleJob(harness.service, "Conflict fixture.");
  const originalUpdate = harness.service.updateJob.bind(harness.service);
  let injected = false;
  const conflictingService = {
    ...harness.service,
    updateJob: async (input) => {
      if (!injected && input.expected_status === "queued_for_agent") {
        injected = true;
        await originalUpdate({ job_id: input.job_id, expected_status: "queued_for_agent", next_status: "cancelled", attempt: input.attempt, source: "fixture:conflict" });
      }
      return originalUpdate(input);
    },
  };
  const runner = createMockAgentRunner({ service: conflictingService, lovart: harness.lovart, dataDirectory: harness.dataDirectory });
  const result = await runner.start(job.id);
  assert.equal(result.action, ACTIONS.REPLAN);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(harness.lovart.ledger, []);
  assert.equal(harness.lovart.remaining(), fixture.script.length);
});

test("iteration reuses only its direct parent thread", async (context) => {
  const parent = await createSucceededParentHarness(context);
  const created = await parent.service.createIteration({
    source_job_id: parent.job.id,
    artifact_id: parent.artifact.id,
    reuse_lovart_thread: true,
    instruction: "Slower motion.",
  });
  const child = (await parent.service.prepareGeneration({ draft_id: created.draft.id, expected_revision: 0, idempotency_key: "workflow-child" })).job;
  const childLovart = createFakeLovartAdapter({
    name: "child-thread",
    script: [{ tool: "lovart_generate", response: { kind: "generation_started", thread_id: parent.job.lovart_thread_id } }],
  });
  const childRunner = createMockAgentRunner({ service: parent.service, lovart: childLovart, dataDirectory: parent.dataDirectory });
  await childRunner.start(child.id);
  assert.equal(child.parent_job_id, parent.job.id);
  assert.equal(child.iteration_index, parent.job.iteration_index + 1);
  assert.deepEqual(childLovart.ledger, [{
    index: 0,
    tool: "lovart_generate",
    arguments: {
      job_id: child.id,
      attempt: 1,
      prompt: "Parent workflow fixture.\n\n迭代要求：Slower motion.",
      model: "Seedance 2.5",
      settings: child.snapshot.settings,
      uploads: [],
      reference_ids: [],
      lovart_thread_id: "fixture-thread-parent",
    },
  }]);
  childLovart.assertComplete();
});

test("unknown fixture response stops without a fallback", async (context) => {
  const harness = await createHarness(context, {
    name: "unknown",
    script: [{ tool: "lovart_generate", response: { kind: "unknown_fixture_state" } }],
  });
  const job = await prepareSimpleJob(harness.service, "Unknown response fixture.");
  await assert.rejects(() => harness.runner.start(job.id), (error) => error.code === "ORCHESTRATION_EVENT_UNKNOWN");
  assert.deepEqual(harness.lovart.ledger, [{
    index: 0,
    tool: "lovart_generate",
    arguments: {
      job_id: job.id,
      attempt: 1,
      prompt: "Unknown response fixture.",
      model: "Seedance 2.5",
      settings: job.snapshot.settings,
      uploads: [],
      reference_ids: [],
      lovart_thread_id: null,
    },
  }]);
  harness.lovart.assertComplete();
});

test("poll routes an unknown non-generating status through policy", async (context) => {
  const harness = await createHarness(context, { name: "unused-poll", script: [] });
  const prepared = await prepareSimpleJob(harness.service, "Unknown poll status fixture.");
  const statePath = path.join(harness.dataDirectory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.jobs.find((job) => job.id === prepared.id).status = "unknown_fixture_status";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    () => harness.runner.poll(prepared.id),
    (error) => error.code === "ORCHESTRATION_STATUS_UNKNOWN",
  );
  assert.deepEqual(harness.lovart.ledger, []);
  harness.lovart.assertComplete();
});
