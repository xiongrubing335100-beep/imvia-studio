import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCostFingerprint } from "../src/domain/cost-confirmation.js";
import { createServer } from "../src/index.js";
import { createAdapterRegistry } from "../src/providers/adapter-registry.js";
import { createConnectionStore } from "../src/providers/connection-store.js";
import { createProviderRegistry } from "../src/providers/provider-registry.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function connect(context, { connections = [] } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-workbench-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  if (connections.length) {
    await writeFile(path.join(dataDirectory, "provider-connections-v1.json"), JSON.stringify({ schema_version: "provider-connections-v2", connections }));
  }
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
    ["imvia_authorize_lovart_probe", "imvia_claim_cost_decision", "imvia_claim_next_workbench_dispatch", "imvia_confirm_generation", "imvia_confirm_provider_cost", "imvia_connect_lovart", "imvia_create_iteration", "imvia_create_lovart_project", "imvia_disconnect_lovart", "imvia_execute_workbench_submission", "imvia_follow_up_generation", "imvia_generate", "imvia_get_account_status", "imvia_get_bridge_status", "imvia_get_generation", "imvia_get_state", "imvia_health", "imvia_heartbeat_conversation_bridge", "imvia_import_result", "imvia_list_lovart_projects", "imvia_list_pending_jobs", "imvia_list_provider_connections", "imvia_list_providers", "imvia_lovart_status", "imvia_mark_dispatch_host_accepted", "imvia_open_workbench", "imvia_patch_workbench", "imvia_prepare_generation", "imvia_probe_lovart_capabilities", "imvia_record_cost_decision", "imvia_register_conversation_bridge", "imvia_release_dispatch_claim", "imvia_select_lovart_project", "imvia_test_provider_connection", "imvia_update_account_status", "imvia_update_job", "imvia_wait_for_workbench_submission"],
  );
  const openWorkbenchTool = tools.tools.find((tool) => tool.name === "imvia_open_workbench");
  assert.match(openWorkbenchTool.description, /Use only when.*IMVIA Studio/iu);
  assert.match(openWorkbenchTool.description, /Do not use.*Imvia Layer/iu);
  const executeTool = tools.tools.find((tool) => tool.name === "imvia_execute_workbench_submission");
  assert.deepEqual(Object.keys(executeTool.inputSchema.properties), ["job_id", "snapshot_digest"]);
  assert.deepEqual(executeTool.inputSchema.required, ["job_id", "snapshot_digest"]);

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

test("MCP provider management lists only redacted metadata and rejects unknown connection tests", async (context) => {
  const client = await connect(context, {
    connections: [{
      connection_id: "modern-fixture", name: "Modern Fixture", provider_id: "external-api", legacy: false,
      base_url: "https://api.example.test/v1", credential_ref: "private-profile", endpoint_mappings: { submit: { authorization: "Bearer private" } }, settings: { private_token: "private" },
      status: "connected", enabled: true, protocol: "openai-compatible", adapter_id: "openai-images", adapter_version: "1", config_revision: 2,
      model_catalog: { digest: "catalog-digest", discovered_at: "2026-08-25T00:00:00.000Z", models: [{ id: "vendor-image", display_name: "Vendor Image", capabilities: ["image"], compatibility: "unconfirmed", source: "api", raw_index: 0 }] },
    }],
  });
  const providers = await client.callTool({ name: "imvia_list_providers", arguments: { mode: "image" } });
  assert.equal(providers.structuredContent.ok, true);
  assert.equal(JSON.stringify(providers.structuredContent).includes("access_key"), false);
  assert.equal(JSON.stringify(providers.structuredContent).includes("secret_key"), false);
  const connections = await client.callTool({ name: "imvia_list_provider_connections", arguments: {} });
  assert.equal(connections.structuredContent.data.connections.length, 1);
  assert.equal(connections.structuredContent.data.connections[0].status, "connected");
  assert.equal(connections.structuredContent.data.connections[0].protocol, "openai-compatible");
  assert.deepEqual(connections.structuredContent.data.connections[0].adapter, { id: "openai-images", version: "1" });
  assert.deepEqual(connections.structuredContent.data.connections[0].catalog.models.map(({ id, name }) => [id, name]), [["vendor-image", "Vendor Image"]]);
  assert.equal(JSON.stringify(connections.structuredContent).includes("endpoint_mappings"), false);
  assert.equal(JSON.stringify(connections.structuredContent).includes("settings"), false);
  assert.equal(JSON.stringify(connections.structuredContent).includes("credential_ref"), false);
  assert.equal(JSON.stringify(connections.structuredContent).includes("private"), false);
  const missing = await client.callTool({ name: "imvia_test_provider_connection", arguments: { connection_id: "missing" } });
  assert.equal(missing.structuredContent.ok, false);
  assert.equal(missing.structuredContent.error.code, "NOT_FOUND");
});

test("MCP tests a modern connection through its pinned adapter and keeps legacy validation generic", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-provider-test-"));
  const external = { id: "external-api", display_name: "External API", kind: "discovered", adapter_id: null, capabilities: ["image"], models: [], credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }] };
  const legacyDescriptor = { id: "legacy-rest", display_name: "Legacy REST", kind: "generic_rest", capabilities: ["image"], models: [], credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }] };
  const providerRegistry = createProviderRegistry({ builtIns: [external, legacyDescriptor] });
  let nextConnection = 0;
  const connectionStore = createConnectionStore({ dataDirectory, registry: providerRegistry, id: () => `provider-test-${++nextConnection}` });
  const adapterCalls = [];
  const adapterRegistry = createAdapterRegistry({ adapters: [{
    id: "fixture-modern", version: "1",
    async discover() { return {}; },
    classifyModel: () => ({ capabilities: ["image"], compatibility: "confirmed" }),
    estimateCost: () => ({ status: "unknown" }),
    async validateConnection(input) { adapterCalls.push(input.connection.connection_id); return { accepted: true }; },
    async submit() { return {}; }, async poll() { return {}; }, async cancel() { return {}; }, async importResults() { return {}; },
  }] });
  const modernDraft = await connectionStore.createDraft({ name: "Modern", base_url: "api.example.test" });
  const modern = await connectionStore.completeDiscovery(modernDraft.connection_id, {
    protocol: "fixture", adapter_id: "fixture-modern", adapter_version: "1", provider_label: "Fixture", models_endpoint: "https://api.example.test/models",
    catalog: { digest: "fixture", discovered_at: "2026-08-25T00:00:00.000Z", models: [{ id: "fixture-image", display_name: "Fixture Image", capabilities: ["image"], compatibility: "confirmed" }], counts: { total: 1, confirmed: 1, unconfirmed: 0, unsupported: 0 } },
  });
  const legacy = await connectionStore.create({ provider_id: "legacy-rest", name: "Legacy", base_url: "https://legacy.example.test", endpoint_mappings: {} });
  const server = createServer({
    service: {}, probeService: { async authorize() {}, async probe() {} }, dataDirectory, providerRegistry, connectionStore, adapterRegistry,
    providerCredentialService: { async configure() {}, async read() { return { api_key: "private" }; }, async clear() {} },
  });
  const client = new Client({ name: "imvia-provider-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });

  const modernTest = await client.callTool({ name: "imvia_test_provider_connection", arguments: { connection_id: modern.connection_id } });
  assert.equal(modernTest.structuredContent.ok, true);
  assert.equal(modernTest.structuredContent.data.status, "connected");
  assert.deepEqual(adapterCalls, [modern.connection_id]);

  const legacyTest = await client.callTool({ name: "imvia_test_provider_connection", arguments: { connection_id: legacy.connection_id } });
  assert.equal(legacyTest.structuredContent.ok, false);
  assert.equal(legacyTest.structuredContent.error.code, "VALIDATION_FAILED");
  assert.deepEqual(adapterCalls, [modern.connection_id]);
});

test("MCP waits for a new workbench button submission and returns its exact summary to Codex", async (context) => {
  const client = await connect(context);
  const opened = await client.callTool({ name: "imvia_open_workbench", arguments: {} });
  const cursor = opened.structuredContent.data.submission_cursor;

  const origin = new URL(opened.structuredContent.data.workbench_url).origin;
  const rejected = await fetch(`${origin}/api/v1/workbench/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: "mcp-no-session", snapshot: { mode: "image", prompt: { text: "must not persist", tokens: [] }, attachments: [], settings: {} } }),
  });
  assert.equal(rejected.status, 400);
  const afterRejected = await client.callTool({ name: "imvia_get_state", arguments: { include: ["jobs"] } });
  assert.deepEqual(afterRejected.structuredContent.data.jobs, []);
  const response = await fetch(`${origin}/api/v1/workbench/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-imvia-workbench-session": opened.structuredContent.data.workbench_session_id, "x-imvia-workbench-token": opened.structuredContent.data.open_token },
    body: JSON.stringify({
      idempotency_key: "mcp-handoff-1",
      snapshot: {
        mode: "image",
        model: "Seedream 4.0",
        prompt: { text: "Exact workbench summary", tokens: [] },
        attachments: [],
        settings: { ratio: "3:4", resolution: "2K", count: 1 },
      },
    }),
  });
  assert.equal(response.status, 202);

  const received = await client.callTool({
    name: "imvia_wait_for_workbench_submission",
    arguments: { after_job_id: cursor, timeout_ms: 1_000 },
  });
  assert.equal(received.structuredContent.data.submitted, true);
  assert.equal(received.structuredContent.data.snapshot.prompt.text, "Exact workbench summary");
  assert.equal(received.structuredContent.data.activation.source, "workbench_action");
});

test("a newly opened workbench URL carries the current job baseline", async (context) => {
  const client = await connect(context);
  const initial = await client.callTool({ name: "imvia_get_state", arguments: {} });
  const draftId = initial.structuredContent.data.draft.id;
  await client.callTool({
    name: "imvia_patch_workbench",
    arguments: {
      draft_id: draftId,
      base_revision: 0,
      actor: "codex",
      reason: "Create a baseline job.",
      patch: { "prompt.text": "Previous session task" },
    },
  });
  const prepared = await client.callTool({
    name: "imvia_prepare_generation",
    arguments: { draft_id: draftId, expected_revision: 1, idempotency_key: "baseline-job" },
  });

  const opened = await client.callTool({ name: "imvia_open_workbench", arguments: {} });
  const url = new URL(opened.structuredContent.data.workbench_url);

  assert.equal(url.searchParams.get("submission_cursor"), prepared.structuredContent.data.job_id);
});

test("MCP emits a visible receipt progress notification for a workbench submission", async (context) => {
  const client = await connect(context);
  const opened = await client.callTool({ name: "imvia_open_workbench", arguments: {} });
  const cursor = opened.structuredContent.data.submission_cursor;
  await fetch(`${new URL(opened.structuredContent.data.workbench_url).origin}/api/v1/workbench/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-imvia-workbench-session": opened.structuredContent.data.workbench_session_id, "x-imvia-workbench-token": opened.structuredContent.data.open_token },
    body: JSON.stringify({
      idempotency_key: "mcp-progress-handoff-1",
      snapshot: { mode: "video", prompt: { text: "Progress receipt", tokens: [] }, attachments: [], settings: {} },
    }),
  });

  const progress = [];
  const received = await client.callTool(
    { name: "imvia_wait_for_workbench_submission", arguments: { after_job_id: cursor, timeout_ms: 1_000 } },
    undefined,
    { onprogress: (update) => progress.push(update) },
  );
  assert.equal(received.structuredContent.data.submitted, true);
  assert.ok(progress.some((update) => /已收到工作台任务/u.test(update.message)));
});

test("MCP Apps bridge delivers a session-bound workbench dispatch", async (context) => {
  const client = await connect(context);
  const opened = await client.callTool({ name: "imvia_open_workbench", arguments: {} });
  const data = opened.structuredContent.data;
  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "ui://imvia-studio/conversation-bridge-v1.html"));
  const bridgeResource = await client.readResource({ uri: "ui://imvia-studio/conversation-bridge-v1.html" });
  const bridgeHtml = bridgeResource.contents?.[0]?.text || "";
  assert.match(bridgeHtml, /ui\/message/u);
  assert.match(bridgeHtml, /imvia_claim_next_workbench_dispatch/u);
  assert.match(bridgeHtml, /ontoolresult/u);
  assert.match(bridgeHtml, /ui\/notifications\/tool-result/u);
  assert.match(bridgeHtml, /getHostCapabilities/u);
  assert.match(bridgeHtml, /ui\/message/u);
  assert.doesNotMatch(bridgeHtml, /if \(!apps[^\n]+!sessionId\)/u);
  const bridgeId = "integration-bridge-1";
  const registered = await client.callTool({
    name: "imvia_register_conversation_bridge",
    arguments: { session_id: data.workbench_session_id, open_token: data.open_token, bridge_id: bridgeId },
  });
  assert.equal(registered.structuredContent.data.bridge_state, "ready");

  const response = await fetch(`${new URL(data.workbench_url).origin}/api/v1/workbench/submissions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-imvia-workbench-session": data.workbench_session_id,
      "x-imvia-workbench-token": data.open_token,
    },
    body: JSON.stringify({
      idempotency_key: "mcp-bridge-delivery-1",
      snapshot: { mode: "image", model: "Image 2", prompt: { text: "Bridge delivery integration", tokens: [] }, attachments: [], settings: { ratio: "3:4" } },
    }),
  });
  const submitted = await response.json();
  assert.equal(response.status, 202);
  assert.equal(submitted.data.delivery_state, "pending_bridge");

  const claimed = await client.callTool({ name: "imvia_claim_next_workbench_dispatch", arguments: { session_id: data.workbench_session_id, bridge_id: bridgeId } });
  const dispatch = claimed.structuredContent.data.dispatch;
  assert.equal(dispatch.job_id, submitted.data.job_id);
  assert.equal(dispatch.schema_version, "imvia.workbench-task.v1");
  assert.equal(dispatch.activation.source, "workbench_action");
  await client.callTool({ name: "imvia_mark_dispatch_host_accepted", arguments: { dispatch_id: dispatch.dispatch_id, session_id: data.workbench_session_id, bridge_id: bridgeId, claim_token: dispatch.claim_token } });
  const delivery = await fetch(`${new URL(data.workbench_url).origin}/api/v1/jobs/${encodeURIComponent(submitted.data.job_id)}/delivery`).then((result) => result.json());
  assert.equal(delivery.data.delivery_state, "host_accepted");
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
