import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCostFingerprint } from "../src/domain/cost-confirmation.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function connect(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-workbench-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "src/index.js")],
    cwd: pluginRoot,
    env: { ...process.env, IMVIA_DATA_DIR: dataDirectory, IMVIA_HTTP_PORT: "0" },
  });
  const client = new Client({ name: "imvia-studio-contract-test", version: "0.1.0" });
  client.testDataDirectory = dataDirectory;
  context.after(async () => client.close());
  await client.connect(transport);
  return client;
}

test("MCP reads, patches, prepares, and lists only its local workbench state", async (context) => {
  const client = await connect(context);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["imvia_authorize_lovart_probe", "imvia_claim_cost_decision", "imvia_confirm_generation", "imvia_connect_lovart", "imvia_create_iteration", "imvia_generate", "imvia_get_account_status", "imvia_get_state", "imvia_health", "imvia_import_result", "imvia_list_pending_jobs", "imvia_lovart_status", "imvia_patch_workbench", "imvia_prepare_generation", "imvia_probe_lovart_capabilities", "imvia_record_cost_decision", "imvia_update_account_status", "imvia_update_job"],
  );

  const initial = await client.callTool({ name: "imvia_get_state", arguments: {} });
  assert.equal(initial.structuredContent.ok, true);
  const draftId = initial.structuredContent.data.draft.id;
  assert.equal(initial.structuredContent.data.draft.revision, 0);

  const patched = await client.callTool({
    name: "imvia_patch_workbench",
    arguments: {
      draft_id: draftId,
      base_revision: 0,
      actor: "codex",
      reason: "Set an approved prompt.",
      patch: { "prompt.text": "A cinematic rainy street." },
    },
  });
  assert.deepEqual(patched.structuredContent, {
    api_version: "1",
    ok: true,
    data: { revision: 1, changed_fields: ["prompt.text"], validation: { warnings: [] } },
  });

  const prepared = await client.callTool({
    name: "imvia_prepare_generation",
    arguments: { draft_id: draftId, expected_revision: 1, idempotency_key: "mcp-session-001" },
  });
  assert.equal(prepared.structuredContent.ok, true);
  assert.equal(prepared.structuredContent.data.status, "queued_for_agent");
  assert.equal(prepared.structuredContent.data.snapshot.prompt.text, "A cinematic rainy street.");

  const pending = await client.callTool({ name: "imvia_list_pending_jobs", arguments: {} });
  assert.deepEqual(pending.structuredContent.data.jobs.map((job) => job.id), [prepared.structuredContent.data.job_id]);
});

test("MCP caches fixture billing mode without inventing a balance", async (context) => {
  const client = await connect(context);
  const checkedAt = new Date();
  const updated = await client.callTool({
    name: "imvia_update_account_status",
    arguments: {
      availability: "partial",
      billing_mode: "fast",
      credit_balance: null,
      credit_unit: null,
      balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
      source_tool: "fixture:lovart_query_billing_mode",
      checked_at: checkedAt.toISOString(),
      expires_at: new Date(checkedAt.getTime() + 300_000).toISOString(),
    },
  });
  assert.equal(updated.structuredContent.ok, true);
  assert.equal(updated.structuredContent.data.billing_mode, "fast");
  assert.equal(updated.structuredContent.data.credit_balance, null);
  assert.equal(updated.structuredContent.data.credit_unit, null);

  const account = await client.callTool({ name: "imvia_get_account_status", arguments: {} });
  assert.equal(account.structuredContent.ok, true);
  assert.equal(account.structuredContent.data.credit_balance, null);
  assert.equal(account.structuredContent.data.credit_unit, null);
});

test("MCP rejects unknown account-status fields", async (context) => {
  const client = await connect(context);
  const checkedAt = new Date();
  const rejected = await client.callTool({
    name: "imvia_update_account_status",
    arguments: {
      availability: "partial",
      billing_mode: "fast",
      credit_balance: null,
      credit_unit: null,
      balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
      source_tool: "fixture:lovart_query_billing_mode",
      checked_at: checkedAt.toISOString(),
      api_key: "unexpected-field",
    },
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Unrecognized key/);
});

test("MCP rejects non-canonical and inverted account timestamps without changing the cache", async (context) => {
  const client = await connect(context);
  for (const checked_at of ["not-a-date", "2026-08-20T00:00:00Z", "2026-08-20T08:00:00.000+08:00"]) {
    const rejected = await client.callTool({
      name: "imvia_update_account_status",
      arguments: {
        availability: "partial",
        billing_mode: "fast",
        credit_balance: null,
        credit_unit: null,
        balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
        source_tool: "fixture:billing",
        checked_at,
      },
    });
    assert.equal(rejected.isError, true, checked_at);
  }

  const inverted = await client.callTool({
    name: "imvia_update_account_status",
    arguments: {
      availability: "partial",
      billing_mode: "fast",
      credit_balance: null,
      credit_unit: null,
      balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
      source_tool: "fixture:billing",
      checked_at: "2026-08-20T00:05:00.000Z",
      expires_at: "2026-08-20T00:00:00.000Z",
    },
  });
  assert.equal(inverted.structuredContent.error.code, "VALIDATION_FAILED");
  assert.equal(inverted.structuredContent.error.details.field, "expires_at");

  const current = await client.callTool({ name: "imvia_get_account_status", arguments: {} });
  assert.equal(current.structuredContent.data.availability, "unavailable");
  assert.equal(current.structuredContent.data.checked_at, null);
});

test("MCP returns a stable business error for a stale patch", async (context) => {
  const client = await connect(context);
  const initial = await client.callTool({ name: "imvia_get_state", arguments: {} });
  const draftId = initial.structuredContent.data.draft.id;
  await client.callTool({
    name: "imvia_patch_workbench",
    arguments: { draft_id: draftId, base_revision: 0, actor: "codex", reason: "First edit.", patch: { model: "Seedance 2.5" } },
  });
  const stale = await client.callTool({
    name: "imvia_patch_workbench",
    arguments: { draft_id: draftId, base_revision: 0, actor: "codex", reason: "Stale edit.", patch: { model: "Kling 3.0" } },
  });

  assert.equal(stale.structuredContent.ok, false);
  assert.deepEqual(stale.structuredContent.error, {
    code: "REVISION_CONFLICT",
    message: "The workbench state changed. Read it again before applying a patch.",
    retryable: true,
    details: { current_revision: 1 },
  });
});

test("MCP returns the standard NOT_FOUND envelope for an iteration with a missing parent", async (context) => {
  const client = await connect(context);
  const result = await client.callTool({
    name: "imvia_create_iteration",
    arguments: {
      source_job_id: "missing-parent-job",
      reuse_lovart_thread: false,
      instruction: "Create a local iteration.",
    },
  });

  assert.deepEqual(result.structuredContent, {
    api_version: "1",
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "The requested job does not exist.",
      retryable: false,
      details: { job_id: "missing-parent-job" },
    },
  });
});

test("MCP records fixture progress and imports only a managed local result", async (context) => {
  const client = await connect(context);
  const initial = await client.callTool({ name: "imvia_get_state", arguments: {} });
  const draftId = initial.structuredContent.data.draft.id;
  await client.callTool({
    name: "imvia_patch_workbench",
    arguments: { draft_id: draftId, base_revision: 0, actor: "user", reason: "Prepare MCP fixture.", patch: { model: "Seedance 2.5", "prompt.text": "MCP fixture lifecycle.", "settings.duration_seconds": 10 } },
  });
  const prepared = await client.callTool({ name: "imvia_prepare_generation", arguments: { draft_id: draftId, expected_revision: 1, idempotency_key: "mcp-fixture" } });
  const jobId = prepared.structuredContent.data.job_id;
  const transitions = [
    ["queued_for_agent", "uploading"],
    ["uploading", "submitted"],
    ["submitted", "generating"],
  ];
  for (const [expected_status, next_status] of transitions) {
    const updated = await client.callTool({ name: "imvia_update_job", arguments: { job_id: jobId, expected_status, next_status, attempt: 1, source: "fixture:mcp" } });
    assert.equal(updated.structuredContent.data.status, next_status);
  }
  const resultDirectory = path.join(client.testDataDirectory, "results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = path.join(resultDirectory, "mcp-result.mp4");
  await writeFile(resultPath, "mcp-fixture-video");
  const imported = await client.callTool({
    name: "imvia_import_result",
    arguments: { job_id: jobId, idempotency_key: "mcp-result-v1", artifacts: [{ kind: "video", local_path: resultPath, mime_type: "video/mp4", source_artifact_id: "mcp-video-001" }] },
  });

  assert.equal(imported.structuredContent.ok, true);
  assert.equal(imported.structuredContent.data.status, "succeeded");
  assert.equal(imported.structuredContent.data.results[0].artifact.source_artifact_id, "mcp-video-001");
});

test("MCP records and claims an accepted cost decision exactly once", async (context) => {
  const client = await connect(context);
  const initial = await client.callTool({ name: "imvia_get_state", arguments: {} });
  const draftId = initial.structuredContent.data.draft.id;
  await client.callTool({
    name: "imvia_patch_workbench",
    arguments: { draft_id: draftId, base_revision: 0, actor: "user", reason: "Prepare MCP cost decision.", patch: { model: "Seedance 2.5", "prompt.text": "MCP cost decision.", "settings.duration_seconds": 10 } },
  });
  const prepared = await client.callTool({ name: "imvia_prepare_generation", arguments: { draft_id: draftId, expected_revision: 1, idempotency_key: "mcp-cost-decision" } });
  const jobId = prepared.structuredContent.data.job_id;
  for (const [expected_status, next_status, source] of [
    ["queued_for_agent", "uploading", "fixture:mcp_cost_upload"],
    ["uploading", "submitted", "fixture:mcp_cost_submit"],
  ]) {
    const updated = await client.callTool({ name: "imvia_update_job", arguments: { job_id: jobId, expected_status, next_status, attempt: 1, source } });
    assert.equal(updated.structuredContent.data.status, next_status);
  }
  await client.callTool({
    name: "imvia_update_job",
    arguments: {
      job_id: jobId,
      expected_status: "submitted",
      next_status: "awaiting_cost_confirmation",
      attempt: 1,
      source: "fixture:cost",
      source_checked_at: "2026-08-20T00:00:00.000Z",
      estimated_cost: { amount: 135, unit: "credits" },
    },
  });
  const cost_fingerprint = createCostFingerprint({ job_id: jobId, attempt: 1, amount: 135, unit: "credits", checked_at: "2026-08-20T00:00:00.000Z", source: "fixture:cost" });
  const recorded = await client.callTool({
    name: "imvia_record_cost_decision",
    arguments: { job_id: jobId, attempt: 1, cost_fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "mcp-cost-accept" },
  });
  assert.equal(recorded.structuredContent.data.idempotent, false);
  assert.equal(recorded.structuredContent.data.receipt.status_at_recording, "awaiting_cost_confirmation");
  const decisionId = recorded.structuredContent.data.receipt.decision.decision_id;
  const claimed = await client.callTool({ name: "imvia_claim_cost_decision", arguments: { decision_id: decisionId, job_id: jobId, attempt: 1, cost_fingerprint } });
  assert.ok(claimed.structuredContent.data.decision.consumed_at);
  const replay = await client.callTool({ name: "imvia_claim_cost_decision", arguments: { decision_id: decisionId, job_id: jobId, attempt: 1, cost_fingerprint } });
  assert.deepEqual(replay.structuredContent.error, {
    code: "COST_CONFIRMATION_CONFLICT",
    message: "The cost decision is missing, stale, or already consumed.",
    retryable: false,
    details: { job_id: jobId, attempt: 1, decision_id: decisionId },
  });

  const wrongEvidence = await client.callTool({
    name: "imvia_update_job",
    arguments: {
      job_id: jobId,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: 1,
      source: "fixture:lovart_confirm",
      cost_decision_id: "wrong-decision",
      confirmation_evidence: { kind: "confirmation_accepted" },
    },
  });
  assert.equal(wrongEvidence.structuredContent.error.code, "COST_CONFIRMATION_CONFLICT");

  const generated = await client.callTool({
    name: "imvia_update_job",
    arguments: {
      job_id: jobId,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: 1,
      source: "fixture:lovart_confirm",
      cost_decision_id: decisionId,
      confirmation_evidence: { kind: "confirmation_accepted" },
    },
  });
  assert.equal(generated.structuredContent.data.status, "generating");

  const decisionReplay = await client.callTool({
    name: "imvia_record_cost_decision",
    arguments: { job_id: jobId, attempt: 1, cost_fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "mcp-cost-accept" },
  });
  assert.equal(decisionReplay.structuredContent.data.idempotent, true);
  assert.equal(decisionReplay.structuredContent.data.receipt.status_at_recording, "awaiting_cost_confirmation");
  assert.equal(decisionReplay.structuredContent.data.receipt.decision.decision_id, decisionId);
  assert.equal(decisionReplay.structuredContent.data.receipt.decision.consumed_at, null);
});

test("MCP rejects invalid cost time and a 135 to 999 overwrite without state mutation", async (context) => {
  const client = await connect(context);
  const initial = await client.callTool({ name: "imvia_get_state", arguments: {} });
  const draftId = initial.structuredContent.data.draft.id;
  await client.callTool({
    name: "imvia_patch_workbench",
    arguments: { draft_id: draftId, base_revision: 0, actor: "user", reason: "Prepare MCP immutable cost.", patch: { model: "Seedance 2.5", "prompt.text": "Immutable cost.", "settings.duration_seconds": 10 } },
  });
  const prepared = await client.callTool({ name: "imvia_prepare_generation", arguments: { draft_id: draftId, expected_revision: 1, idempotency_key: "mcp-immutable-cost" } });
  const jobId = prepared.structuredContent.data.job_id;
  await client.callTool({ name: "imvia_update_job", arguments: { job_id: jobId, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "fixture:upload" } });
  await client.callTool({ name: "imvia_update_job", arguments: { job_id: jobId, expected_status: "uploading", next_status: "submitted", attempt: 1, source: "fixture:submit" } });

  const invalidTime = await client.callTool({
    name: "imvia_update_job",
    arguments: {
      job_id: jobId,
      expected_status: "submitted",
      next_status: "awaiting_cost_confirmation",
      attempt: 1,
      source: "fixture:cost",
      source_checked_at: "2026-08-20T00:00:00Z",
      estimated_cost: { amount: 135, unit: "credits" },
    },
  });
  assert.equal(invalidTime.isError, true);

  const waiting = await client.callTool({
    name: "imvia_update_job",
    arguments: {
      job_id: jobId,
      expected_status: "submitted",
      next_status: "awaiting_cost_confirmation",
      attempt: 1,
      source: "fixture:cost",
      source_checked_at: "2026-08-20T00:00:00.000Z",
      estimated_cost: { amount: 135, unit: "credits" },
    },
  });
  assert.equal(waiting.structuredContent.data.status, "awaiting_cost_confirmation");

  const overwrite = await client.callTool({
    name: "imvia_update_job",
    arguments: {
      job_id: jobId,
      expected_status: "awaiting_cost_confirmation",
      next_status: "generating",
      attempt: 1,
      source: "fixture:lovart_confirm",
      source_checked_at: "2026-08-20T00:01:00.000Z",
      estimated_cost: { amount: 999, unit: "credits" },
    },
  });
  assert.equal(overwrite.structuredContent.error.code, "VALIDATION_FAILED");

  const state = await client.callTool({ name: "imvia_get_state", arguments: { include: ["jobs"] } });
  const persisted = state.structuredContent.data.jobs.find((job) => job.id === jobId);
  assert.equal(persisted.status, "awaiting_cost_confirmation");
  assert.deepEqual(persisted.estimated_cost, { amount: 135, unit: "credits", source: "fixture:cost", checked_at: "2026-08-20T00:00:00.000Z" });
});
