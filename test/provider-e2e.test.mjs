import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createBridgeSessionService } from "../src/bridge/bridge-session-service.js";
import { snapshotDigest } from "../src/bridge/task-message.js";
import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { startHttpServer } from "../src/http/server.js";
import { createServer as createMcpServer } from "../src/index.js";
import { createConnectionStore } from "../src/providers/connection-store.js";
import { createProviderExecutionRouter } from "../src/providers/provider-execution-router.js";
import { createProviderRegistry } from "../src/providers/provider-registry.js";

const SECRET = "e2e-private-api-key";
const descriptor = {
  id: "fixture-e2e",
  display_name: "Fixture E2E",
  kind: "generic_rest",
  capabilities: ["image", "video"],
  models: [{ id: "fixture-e2e-model", capabilities: ["image", "video"] }],
  credential_fields: [{ id: "api_key", label: "API key", secret: true, required: true }],
};
const externalDescriptor = {
  id: "external-api", display_name: "External API", kind: "discovered", capabilities: ["image", "video"], models: [],
  credential_fields: [{ id: "api_key", label: "API key", secret: true, required: true }],
};
const lovartAdapter = Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, async () => ({})]));

async function openSse(url) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/v1/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let closed = false;
  const read = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
  })();
  return {
    async close() { if (closed) return; closed = true; controller.abort(); await read; },
    text: () => text,
  };
}

function parseSseEvents(text) {
  return text.trim().split(/\n\n+/u).filter(Boolean).map((frame) => {
    const event = frame.match(/^event: (.+)$/mu)?.[1] ?? null;
    const data = frame.match(/^data: (.+)$/mu)?.[1] ?? "{}";
    return { event, data: JSON.parse(data) };
  });
}

async function harness(context, { modern = false } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-provider-e2e-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const registry = createProviderRegistry({
    builtIns: [{ id: "lovart", display_name: "Lovart", kind: "adapter", adapter_id: "lovart-adapter", capabilities: ["image", "video"], models: [], credential_fields: [], adapter: lovartAdapter }, descriptor, externalDescriptor],
  });
  let connectionSequence = 0;
  const connectionStore = createConnectionStore({ dataDirectory, registry, id: () => `fixture-e2e-connection-${++connectionSequence}` });
  const legacyConnection = await connectionStore.create({
    name: "Fixture E2E connection",
    provider_id: descriptor.id,
    base_url: "https://fixture.invalid",
    endpoint_mappings: {},
    capabilities: ["image", "video"],
    models: ["fixture-e2e-model"],
    enabled: true,
  });
  const connection = modern
    ? await (async () => {
      const draft = await connectionStore.createDraft({ name: "Modern E2E", base_url: "https://fixture.invalid/v1" });
      return connectionStore.completeDiscovery(draft.connection_id, {
        protocol: "openai-compatible", adapter_id: "openai-images", adapter_version: "1", provider_label: "Modern E2E", models_endpoint: "https://fixture.invalid/v1/models",
        catalog: { digest: "modern-e2e-catalog", discovered_at: "2026-08-25T00:00:00.000Z", models: [
          { id: "gpt-image-1", display_name: "GPT Image", capabilities: ["image"], compatibility: "confirmed", source: "api", raw_index: 0 },
          { id: "gpt-image-mini", display_name: "GPT Image Mini", capabilities: ["image"], compatibility: "confirmed", source: "api", raw_index: 1 },
        ], counts: { total: 2, confirmed: 2, unconfirmed: 0, unsupported: 0 } },
      });
    })()
    : legacyConnection;
  const workbenchService = createWorkbenchService({ dataDirectory, providerRegistry: registry, connectionStore });
  const bridgeService = createBridgeSessionService({ dataDirectory });
  const artifactDirectory = path.join(dataDirectory, "fixture-results");
  await mkdir(artifactDirectory, { recursive: true });
  const artifacts = [
    { id: "provider-image-1", kind: "image", mime_type: "image/png", local_path: path.join(artifactDirectory, "one.png") },
    { id: "provider-image-2", kind: "image", mime_type: "image/png", local_path: path.join(artifactDirectory, "two.png") },
    { id: "provider-video-1", kind: "video", mime_type: "video/mp4", local_path: path.join(artifactDirectory, "three.mp4") },
  ];
  await Promise.all(artifacts.map((artifact, index) => writeFile(artifact.local_path, `fixture-${index}`, { mode: 0o600 })));
  const calls = [];
  const connector = {
    async validateConnection() { return { status: "connected", code: "CONNECTED" }; },
    async submit(input) {
      calls.push({ operation: "submit", input });
      await input.onProgress?.({ stage: "submitted", progress: 5 });
      return { task_id: "fixture-provider-task", status: "submitted", known_free: true };
    },
    async poll(input) {
      calls.push({ operation: "poll", input });
      await input.onProgress?.({ stage: "generating", progress: 65 });
      return { task_id: "fixture-provider-task", result: artifacts };
    },
    async cancel() { return { cancelled: true }; },
    async importResults(input) { calls.push({ operation: "import", input }); return { artifacts: input.result }; },
  };
  const adapter = {
    async estimateCost(input) { calls.push({ operation: "estimate", input }); return { status: "known_free" }; },
    async submit(input) { calls.push({ operation: "submit", input }); await input.onProgress?.({ stage: "submitted", progress: 5 }); return { status: "submitted", task_id: "modern-e2e-task", known_free: true }; },
    async poll(input) { calls.push({ operation: "poll", input }); await input.onProgress?.({ stage: "generating", progress: 65 }); return { task_id: "modern-e2e-task", result: artifacts }; },
    async importResults(input) { calls.push({ operation: "import", input }); return { artifacts: input.result }; },
  };
  let lovartCalls = 0;
  const lovartOrchestrator = {
    async executePrepared() { lovartCalls += 1; throw new Error("Lovart must not be selected by this fixture"); },
    async get() { return { job: null, artifacts: [] }; },
    async confirm() { lovartCalls += 1; return { job: null, artifacts: [] }; },
    async submit() { return { job: null, artifacts: [] }; },
    async followUp() { return { job: null, artifacts: [] }; },
  };
  const credentialService = { async read({ credential_ref }) { assert.equal(credential_ref, connection.credential_ref); return { api_key: SECRET }; } };
  const router = createProviderExecutionRouter({
    registry,
    connectionStore,
    lovartOrchestrator,
    genericConnectorFactory: () => connector,
    workbenchService,
    artifactTransfer: { async downloadResults({ result }) { return { artifacts: result.artifacts }; } },
    credentialService,
    adapterRegistry: { get(id, version) { assert.equal(id, "openai-images"); assert.equal(version, "1"); return adapter; } },
  });
  const http = await startHttpServer({ dataDirectory, service: workbenchService, bridgeService, providerRegistry: registry, connectionStore, providerCredentialService: credentialService, providerExecutionRouter: router, orchestrator: lovartOrchestrator });
  context.after(() => http.close());
  const mcp = createMcpServer({
    service: workbenchService,
    bridgeService,
    providerRegistry: registry,
    connectionStore,
    providerCredentialService: credentialService,
    providerConnectionService: {},
    providerExecutionRouter: router,
    orchestrator: lovartOrchestrator,
    probeService: { async authorize() {}, async probe() {} },
    credentialService: { async status() { return { status: "not_connected" }; } },
    generationService: { async connect() { return { status: "not_connected" }; }, async generate() {}, async confirm() {} },
    dataDirectory,
  });
  const client = new Client({ name: "imvia-provider-e2e", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => { await client.close(); await mcp.close(); });
  return { bridgeService, client, connection, calls, http, lovartCalls: () => lovartCalls, workbenchService, provider_id: modern ? "external-api" : descriptor.id, model: modern ? "gpt-image-1" : "fixture-e2e-model" };
}

test("executes one bridged generic-provider workbench job once and imports two images plus one video without leaking credentials", async (context) => {
  const { bridgeService, client, connection, calls, http, workbenchService } = await harness(context);
  const session = await bridgeService.openSession();
  await bridgeService.registerBridge({ session_id: session.session_id, open_token: session.open_token, bridge_id: "provider-e2e-bridge" });
  const sse = await openSse(http.url);
  context.after(() => sse.close());

  const submittedResponse = await fetch(`${http.url}/api/v1/workbench/submissions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-imvia-workbench-session": session.session_id,
      "x-imvia-workbench-token": session.open_token,
    },
    body: JSON.stringify({
      idempotency_key: "provider-e2e-submission",
      snapshot: {
        provider_id: descriptor.id,
        connection_id: connection.connection_id,
        mode: "image",
        model: "fixture-e2e-model",
        prompt: { text: "Produce three fixture artifacts", tokens: [] },
        attachments: [],
        settings: {},
      },
    }),
  });
  const submitted = await submittedResponse.json();
  assert.equal(submittedResponse.status, 202);
  assert.equal(submitted.data.delivery_state, "pending_bridge");
  const claimed = await bridgeService.claimNext({ session_id: session.session_id, bridge_id: "provider-e2e-bridge" });
  assert.equal(claimed.dispatch.job_id, submitted.data.job_id);
  const beforeExecution = await workbenchService.getState({ include: ["jobs"] });
  assert.equal(snapshotDigest(beforeExecution.jobs.find((job) => job.id === claimed.dispatch.job_id).snapshot), claimed.dispatch.snapshot_digest);
  await bridgeService.markHostAccepted({ dispatch_id: claimed.dispatch.dispatch_id, session_id: session.session_id, bridge_id: "provider-e2e-bridge", claim_token: claimed.dispatch.claim_token });

  const mcpProgress = [];
  const executed = await client.callTool(
    { name: "imvia_execute_workbench_submission", arguments: { job_id: claimed.dispatch.job_id, snapshot_digest: claimed.dispatch.snapshot_digest } },
    undefined,
    { onprogress: (update) => mcpProgress.push(update) },
  );
  assert.equal(executed.structuredContent.ok, true);
  assert.equal(executed.structuredContent.data.job.status, "succeeded");
  assert.deepEqual(executed.structuredContent.data.artifacts.map((artifact) => artifact.kind).sort(), ["image", "image", "video"]);
  assert.deepEqual(calls.map((call) => call.operation), ["submit", "poll", "import"]);
  assert.equal(calls[0].input.credential.api_key, SECRET);

  const repeated = await client.callTool({ name: "imvia_execute_workbench_submission", arguments: { job_id: claimed.dispatch.job_id, snapshot_digest: claimed.dispatch.snapshot_digest } });
  assert.equal(repeated.structuredContent.ok, true);
  assert.deepEqual(calls.map((call) => call.operation), ["submit", "poll", "import"]);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await sse.close();
  const state = await workbenchService.getState({ include: ["jobs", "artifacts"] });
  const mcpState = await client.callTool({ name: "imvia_get_state", arguments: { include: ["jobs", "artifacts"] } });
  const sseEvents = parseSseEvents(sse.text());
  assert.deepEqual(mcpProgress.map((update) => update.progress), [5, 65, 100]);
  assert.ok(mcpProgress.some((update) => update.message.includes("已完成生成")));
  assert.ok(sseEvents.some((event) => ["job.updated", "job.progress"].includes(event.event) && event.data.progress?.phase === "submitted" && event.data.progress?.percent === 5));
  assert.ok(sseEvents.some((event) => ["job.updated", "job.progress"].includes(event.event) && event.data.progress?.phase === "generating" && event.data.progress?.percent === 65));
  assert.ok(sseEvents.some((event) => event.event === "job.updated" && event.data.progress?.phase === "completed" && event.data.status === "succeeded"));
  const serialized = [JSON.stringify(submitted), sse.text(), JSON.stringify(sseEvents), JSON.stringify(mcpProgress), JSON.stringify(state), JSON.stringify(executed.structuredContent), JSON.stringify(repeated.structuredContent), JSON.stringify(mcpState.structuredContent)].join("\n");
  for (const forbidden of [SECRET, "api_key", "credential_values", "credential_ref", "access_key", "secret_key"]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.match(sse.text(), /event: job\.updated/u);
  const completedJob = state.jobs.find((job) => job.id === claimed.dispatch.job_id);
  assert.equal(completedJob.snapshot.provider_label, "Fixture E2E");
  assert.deepEqual(completedJob.progress, { phase: "completed", status: "succeeded" });
  assert.equal(state.artifacts.filter((artifact) => artifact.job_id === claimed.dispatch.job_id).length, 3);
});

test("executes a modern discovered model through HTTP, bridge, MCP, and its exact adapter without Lovart fallback", async (context) => {
  const { bridgeService, client, connection, calls, http, lovartCalls, model, provider_id, workbenchService } = await harness(context, { modern: true });
  const session = await bridgeService.openSession();
  await bridgeService.registerBridge({ session_id: session.session_id, open_token: session.open_token, bridge_id: "modern-e2e-bridge" });
  const submittedResponse = await fetch(`${http.url}/api/v1/workbench/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-imvia-workbench-session": session.session_id, "x-imvia-workbench-token": session.open_token },
    body: JSON.stringify({ idempotency_key: "modern-e2e-submission", snapshot: { provider_id, connection_id: connection.connection_id, mode: "image", model, prompt: { text: "Produce modern fixture artifacts", tokens: [] }, attachments: [], settings: {} } }),
  });
  const submitted = await submittedResponse.json();
  assert.equal(submittedResponse.status, 202);
  const claimed = await bridgeService.claimNext({ session_id: session.session_id, bridge_id: "modern-e2e-bridge" });
  await bridgeService.markHostAccepted({ dispatch_id: claimed.dispatch.dispatch_id, session_id: session.session_id, bridge_id: "modern-e2e-bridge", claim_token: claimed.dispatch.claim_token });
  const executed = await client.callTool({ name: "imvia_execute_workbench_submission", arguments: { job_id: claimed.dispatch.job_id, snapshot_digest: claimed.dispatch.snapshot_digest } });
  assert.equal(executed.structuredContent.ok, true);
  assert.equal(executed.structuredContent.data.job.status, "succeeded");
  assert.deepEqual(calls.map((call) => call.operation), ["estimate", "submit", "poll", "import"]);
  assert.equal(lovartCalls(), 0);
  const repeated = await client.callTool({ name: "imvia_execute_workbench_submission", arguments: { job_id: claimed.dispatch.job_id, snapshot_digest: claimed.dispatch.snapshot_digest } });
  assert.equal(repeated.structuredContent.ok, true);
  assert.deepEqual(calls.map((call) => call.operation), ["estimate", "submit", "poll", "import"]);
  const state = await workbenchService.getState({ include: ["jobs", "artifacts"] });
  const publicState = await client.callTool({ name: "imvia_get_state", arguments: { include: ["jobs", "artifacts"] } });
  const serialized = [JSON.stringify(submitted), JSON.stringify(executed.structuredContent), JSON.stringify(repeated.structuredContent), JSON.stringify(state), JSON.stringify(publicState.structuredContent)].join("\n");
  for (const forbidden of [SECRET, "api_key", "credential_ref", "authorization", "secret_key"]) assert.equal(serialized.includes(forbidden), false, forbidden);
  const job = state.jobs.find((item) => item.id === claimed.dispatch.job_id);
  assert.equal(job.snapshot.model, "gpt-image-1");
  assert.equal(job.snapshot.selected_model.id, "gpt-image-1");
});
