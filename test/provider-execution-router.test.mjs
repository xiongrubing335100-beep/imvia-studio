import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { createConnectionStore } from "../src/providers/connection-store.js";
import { createProviderExecutionRouter } from "../src/providers/provider-execution-router.js";
import { createProviderRegistry } from "../src/providers/provider-registry.js";
import { createGenericRestConnector } from "../src/providers/generic-rest-connector.js";
import { createCostFingerprint } from "../src/domain/cost-confirmation.js";
import { modelRecordDigest } from "../src/providers/model-catalog.js";

const methods = ["validateConnection", "submit", "poll", "cancel", "importResults"];
const adapter = Object.fromEntries(methods.map((name) => [name, async () => ({})]));
const lovart = { id: "lovart", display_name: "Lovart", kind: "adapter", capabilities: ["image", "video"], models: [{ id: "Image 2", capabilities: ["image"] }], adapter_id: "lovart-adapter", credential_fields: [] };
const fixtureSecret = "private-router-secret";
const generic = { id: "fixture-api", display_name: "Fixture API", kind: "generic_rest", capabilities: ["image"], models: [{ id: "fixture-image", capabilities: ["image"] }], credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }, { id: "vendor_signing_material", label: "Vendor signing material", secret: true, required: false }] };
const external = { id: "external-api", display_name: "External API", kind: "discovered", capabilities: ["image", "video"], models: [], credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }] };

function modernCatalog(modelId = "gpt-image-1") {
  return {
    digest: `catalog-${modelId}`,
    discovered_at: "2026-08-25T00:00:00.000Z",
    models: [{ id: modelId, display_name: "GPT Image", capabilities: ["image"], compatibility: "confirmed", source: "api", raw_index: 0 }],
    counts: { total: 1, confirmed: 1, unconfirmed: 0, unsupported: 0 },
  };
}

async function modernFixture(context, { estimate = { status: "known_free" }, adapterVersion = "1" } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-modern-router-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const registry = createProviderRegistry({ builtIns: [{ ...lovart, adapter }, external, generic] });
  const connectionStore = createConnectionStore({ dataDirectory, registry });
  const draft = await connectionStore.createDraft({ name: "Modern fixture", base_url: "https://modern.example.test/v1" });
  const connection = await connectionStore.completeDiscovery(draft.connection_id, {
    protocol: "openai-compatible", adapter_id: "openai-images", adapter_version: adapterVersion,
    provider_label: "Modern fixture", models_endpoint: "https://modern.example.test/v1/models", catalog: modernCatalog(),
  });
  const workbenchService = createWorkbenchService({ dataDirectory, providerRegistry: registry, connectionStore });
  const resultFile = path.join(dataDirectory, "results", "modern.png");
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(resultFile, "modern", { mode: 0o600 });
  const calls = [];
  const modernAdapter = {
    async estimateCost(input) { calls.push(["adapter.estimate", input]); return estimate; },
    async submit(input) { calls.push(["adapter.submit", input]); return { status: "succeeded", result: { data: [{ id: "modern-image", b64_json: "aW1hZ2U=" }] }, known_free: true }; },
    async poll(input) { calls.push(["adapter.poll", input]); return input.result; },
    async importResults(input) { calls.push(["adapter.import", input]); return { artifacts: [{ id: "modern-image", kind: "image", local_path: resultFile }] }; },
  };
  let lovartCalls = 0;
  const lovartOrchestrator = {
    async executePrepared() { lovartCalls += 1; throw new Error("Lovart must never receive an external job"); },
    async get() { return { job: null, artifacts: [] }; },
    async confirm() { lovartCalls += 1; throw new Error("Lovart must never confirm an external job"); },
  };
  const router = createProviderExecutionRouter({
    registry, connectionStore, lovartOrchestrator, genericConnectorFactory: () => createGenericRestConnector(),
    workbenchService, artifactTransfer: { async downloadResults({ result }) { return { artifacts: result.artifacts }; } },
    credentialService: { async read() { return { api_key: fixtureSecret }; } },
    adapterRegistry: { get(id, version) { assert.equal(id, "openai-images"); assert.equal(version, adapterVersion); return modernAdapter; } },
  });
  const queued = await workbenchService.createWorkbenchSubmission({
    snapshot: { provider_id: "external-api", connection_id: connection.connection_id, mode: "image", model: "gpt-image-1", prompt: { text: "Modern route", tokens: [] }, attachments: [], settings: {} },
    idempotency_key: "modern-route-job",
  });
  return { calls, connection, connectionStore, dataDirectory, lovartCalls: () => lovartCalls, modernAdapter, queued, router, workbenchService };
}

async function fixture(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-provider-router-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const registry = createProviderRegistry({ builtIns: [{ ...lovart, adapter }, generic] });
  const connectionStore = createConnectionStore({ dataDirectory, registry });
  const connection = await connectionStore.create({ name: "Fixture", provider_id: "fixture-api", base_url: "https://fixture.example.test", endpoint_mappings: {}, capabilities: ["image"], models: ["fixture-image"], enabled: true });
  const workbenchService = createWorkbenchService({ dataDirectory, providerRegistry: registry, connectionStore });
  const calls = [];
  const credentialReads = [];
  const resultFile = path.join(dataDirectory, "results", "fixture.png");
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(resultFile, "fixture", { mode: 0o600 });
  const lovartOrchestrator = {
    async executePrepared(input) { calls.push(["lovart.execute", input]); return { job: { id: input.job_id, status: "succeeded" }, artifacts: [], result: { provider: "lovart" } }; },
    async get(input) { calls.push(["lovart.get", input]); return { job: { id: input.job_id }, artifacts: [] }; },
    async confirm(input) { calls.push(["lovart.confirm", input]); return { job: { id: input.job_id, status: "succeeded" } }; },
  };
  const connector = {
    async validateConnection() { throw new Error("not used"); },
    async submit(input) { calls.push(["generic.submit", input]); return { task_id: "task-1", status: "submitted", cost: { amount: 0, unit: "provider" } }; },
    async poll(input) { calls.push(["generic.poll", input]); input.onProgress?.({ stage: "generating", progress: 50 }); return { task_id: "task-1", status: "succeeded", result: [{ id: "result-1", kind: "image", local_path: resultFile }] }; },
    async cancel() { return { cancelled: true }; },
    async importResults(input) { calls.push(["generic.import", input]); return { artifacts: input.result }; },
  };
  const artifactTransfer = { async downloadResults({ result }) { return { artifacts: result.artifacts ?? result }; } };
  const credentialService = { async read(input) { credentialReads.push(input); return { api_key: fixtureSecret }; } };
  const router = createProviderExecutionRouter({ registry, connectionStore, lovartOrchestrator, genericConnectorFactory: () => connector, workbenchService, artifactTransfer, credentialService });
  return { dataDirectory, resultFile, calls, credentialReads, connection, connectionStore, workbenchService, router, connector };
}

async function queuedGeneric(workbenchService, connection, key = "generic-job") {
  return workbenchService.createWorkbenchSubmission({
    snapshot: { provider_id: "fixture-api", connection_id: connection.connection_id, mode: "image", model: "fixture-image", prompt: { text: "Generate fixture", tokens: [] }, attachments: [], settings: {} },
    idempotency_key: key,
  });
}

test("routes a frozen generic job only to the generic connector and imports every artifact", async (context) => {
  const { calls, credentialReads, connection, workbenchService, router } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection);
  const output = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(output.job.status, "succeeded");
  assert.equal(calls.some(([name]) => name === "lovart.execute"), false);
  assert.deepEqual(calls.map(([name]) => name), ["generic.submit", "generic.poll", "generic.import"]);
  assert.deepEqual(credentialReads, [{ credential_ref: connection.credential_ref }]);
  assert.equal(calls.find(([name]) => name === "generic.submit")[1].credential.api_key, fixtureSecret);
  assert.equal(JSON.stringify(await router.get({ job_id: queued.job.id })).includes(fixtureSecret), false);
  assert.equal((await router.get({ job_id: queued.job.id })).artifacts.length, 1);
});

test("routes a modern connection through its exact discovered adapter without invoking Lovart", async (context) => {
  const { calls, lovartCalls, queued, router } = await modernFixture(context);
  const output = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(output.job.status, "succeeded");
  assert.deepEqual(calls.map(([operation]) => operation), ["adapter.estimate", "adapter.submit", "adapter.import"]);
  assert.equal(lovartCalls(), 0);
  assert.equal(modelRecordDigest(output.job.snapshot.selected_model), output.job.snapshot.selected_model_digest);
});

test("requires an exact unknown-cost acceptance before one modern provider submission", async (context) => {
  const { calls, lovartCalls, queued, router, workbenchService } = await modernFixture(context, { estimate: { status: "unknown" } });
  const waiting = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(waiting.job.status, "awaiting_cost_confirmation");
  assert.deepEqual(calls.map(([operation]) => operation), ["adapter.estimate"]);
  assert.equal(lovartCalls(), 0);
  const fingerprint = createCostFingerprint({ ...waiting.job.estimated_cost, job_id: waiting.job.id, attempt: waiting.job.attempt, provider_id: "external-api" });
  const accepted = await workbenchService.recordCostDecision({ job_id: waiting.job.id, attempt: waiting.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "modern-unknown-accepted" });
  const completed = await router.confirm({ job_id: waiting.job.id, attempt: waiting.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id });
  assert.equal(completed.job.status, "succeeded");
  assert.equal(calls.filter(([operation]) => operation === "adapter.submit").length, 1);
  await assert.rejects(router.confirm({ job_id: waiting.job.id, attempt: waiting.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id }), (error) => error.code === "COST_CONFIRMATION_CONFLICT");
  assert.equal(calls.filter(([operation]) => operation === "adapter.submit").length, 1);
  assert.equal(lovartCalls(), 0);
});

test("rejects a changed modern adapter or invalid frozen model before any external transport", async (context) => {
  const { calls, connection, connectionStore, lovartCalls, queued, router } = await modernFixture(context);
  await connectionStore.markCredentialsChanged(connection.connection_id);
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "CONNECTION_UNAVAILABLE");
  assert.deepEqual(calls, []);
  assert.equal(lovartCalls(), 0);

  const second = await modernFixture(context);
  const updated = await second.connectionStore.completeDiscovery(second.connection.connection_id, {
    protocol: "openai-compatible", adapter_id: "openai-images", adapter_version: "2",
    provider_label: "Modern fixture", models_endpoint: "https://modern.example.test/v1/models", catalog: modernCatalog(),
  });
  assert.notEqual(updated.adapter_version, second.queued.job.snapshot.adapter_version);
  await assert.rejects(second.router.executePrepared({ job_id: second.queued.job.id }), (error) => error.code === "CONNECTION_UNAVAILABLE");
  assert.deepEqual(second.calls, []);
  assert.equal(second.lovartCalls(), 0);
});

test("rejects a stale modern connection status before credentials or adapter transport", async (context) => {
  const { calls, connection, dataDirectory, lovartCalls, queued, router } = await modernFixture(context);
  const statePath = path.join(dataDirectory, "provider-connections-v1.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const stored = state.connections.find((item) => item.connection_id === connection.connection_id);
  stored.status = "failed";
  stored.enabled = true;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "CONNECTION_UNAVAILABLE");
  assert.deepEqual(calls, []);
  assert.equal(lovartCalls(), 0);
});

test("does not call Lovart after an external adapter authentication failure", async (context) => {
  const { calls, lovartCalls, modernAdapter, queued, router } = await modernFixture(context);
  modernAdapter.submit = async () => { calls.push(["adapter.submit"]); throw Object.assign(new Error("bad credential"), { code: "AUTHENTICATION_FAILED" }); };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "AUTHENTICATION_FAILED");
  assert.deepEqual(calls.map(([operation]) => operation), ["adapter.estimate", "adapter.submit"]);
  assert.equal(lovartCalls(), 0);
});

test("the production generic connector receives the real workbench prompt and completes a known-free synchronous call", async (context) => {
  const { dataDirectory, connection, connectionStore, workbenchService } = await fixture(context);
  await connectionStore.update(connection.connection_id, {
    endpoint_mappings: {
      submit: {
        method: "POST",
        path: "/generate",
        headers: { Authorization: "Bearer {{credential.api_key}}" },
        body: { prompt: "{{snapshot.prompt}}", model: "{{snapshot.model}}" },
        result_path: "data.results",
        known_free_path: "data.known_free",
      },
    },
  });
  const configured = await connectionStore.get(connection.connection_id);
  const queued = await queuedGeneric(workbenchService, configured, "real-generic-connector-job");
  const resultFile = path.join(dataDirectory, "results", "real-generic.png");
  await writeFile(resultFile, "real-generic", { mode: 0o600 });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: { known_free: true, results: [{ id: "real-generic-result", kind: "image", local_path: resultFile }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lovartOrchestrator = {
    async executePrepared() { throw new Error("Lovart must not be used"); },
    async get() { return { job: null, artifacts: [] }; },
    async confirm() { return { job: null, artifacts: [] }; },
  };
  const router = createProviderExecutionRouter({
    registry: createProviderRegistry({ builtIns: [{ ...lovart, adapter }, generic] }),
    connectionStore,
    lovartOrchestrator,
    genericConnectorFactory: () => createGenericRestConnector({ fetchImpl }),
    workbenchService,
    artifactTransfer: { async downloadResults({ result }) { return { artifacts: result.artifacts }; } },
    credentialService: { async read() { return { api_key: fixtureSecret }; } },
  });
  const output = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(output.job.status, "succeeded");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { prompt: "Generate fixture", model: "fixture-image" });
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${fixtureSecret}`);
});

test("redacts fixed-name and descriptor-declared credential values from persisted snapshots and router reads", async (context) => {
  const { dataDirectory, connection, workbenchService, router } = await fixture(context);
  const queued = await workbenchService.createWorkbenchSubmission({
    snapshot: {
      provider_id: "fixture-api", connection_id: connection.connection_id, mode: "image", model: "fixture-image",
      prompt: { text: "secret handling", tokens: [] }, attachments: [],
      settings: { access_key: "fixed-access-secret", token: "fixed-token", vendor_signing_material: "descriptor-only-secret", normal: "safe" },
    },
    idempotency_key: "redaction-job",
  });
  const raw = await readFile(path.join(dataDirectory, "state.json"), "utf8");
  assert.equal(raw.includes("fixed-access-secret"), false);
  assert.equal(raw.includes("fixed-token"), false);
  assert.equal(raw.includes("descriptor-only-secret"), false);
  const output = await router.get({ job_id: queued.job.id });
  assert.equal(JSON.stringify(output).includes("descriptor-only-secret"), false);
  assert.equal(output.job.snapshot.settings.normal, "safe");
});

test("routes a legacy Lovart snapshot only to the Lovart orchestrator", async (context) => {
  const { calls, workbenchService, router } = await fixture(context);
  const queued = await workbenchService.createWorkbenchSubmission({ snapshot: { mode: "image", model: "Image 2", prompt: { text: "Lovart only", tokens: [] }, attachments: [], settings: {} }, idempotency_key: "lovart-job" });
  await router.executePrepared({ job_id: queued.job.id });
  assert.deepEqual(calls.map(([name]) => name), ["lovart.execute"]);
});

test("rejects disabled or revision-changed connections before any provider transport", async (context) => {
  const { calls, connection, connectionStore, workbenchService, router } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "disabled-job");
  await connectionStore.update(connection.connection_id, { enabled: false });
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "CONNECTION_UNAVAILABLE");
  assert.equal(calls.length, 0);
});

test("rejects a connection revision change before any provider transport", async (context) => {
  const { calls, connection, connectionStore, workbenchService, router } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "revision-job");
  await connectionStore.update(connection.connection_id, { settings: { request_timeout_ms: 1_000 } });
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "CONNECTION_UNAVAILABLE");
  assert.equal(calls.length, 0);
});

test("rejects an unknown frozen provider before any provider transport", async (context) => {
  const { dataDirectory, calls, connection, workbenchService, router } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-provider-job");
  const stateFile = path.join(dataDirectory, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const job = state.jobs.find((item) => item.id === queued.job.id);
  job.provider_id = "removed-provider";
  job.snapshot.provider_id = "removed-provider";
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "NOT_FOUND");
  assert.equal(calls.length, 0);
});

test("does not fall back to Lovart when the selected generic provider fails", async (context) => {
  const { calls, connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "no-fallback-job");
  connector.submit = async () => { calls.push(["generic.submit"]); throw Object.assign(new Error("fixture provider failed"), { code: "UPSTREAM_UNAVAILABLE" }); };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(calls.map(([name]) => name), ["generic.submit"]);
});

test("keeps an ambiguous provider submission retryable and reuses the immutable idempotency metadata", async (context) => {
  const { calls, connection, connectionStore, workbenchService, router, connector } = await fixture(context);
  await connectionStore.update(connection.connection_id, { endpoint_mappings: { submit: { body: { idempotency_key: "{{snapshot.idempotency_key}}", snapshot_digest: "{{snapshot.snapshot_digest}}" } } } });
  const idempotentConnection = await connectionStore.get(connection.connection_id);
  const queued = await queuedGeneric(workbenchService, idempotentConnection, "retryable-job");
  connector.submit = async (input) => { calls.push(["generic.submit", input]); throw Object.assign(new Error(`timeout ${fixtureSecret}`), { code: "REQUEST_TIMEOUT" }); };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "REQUEST_TIMEOUT" && !error.message.includes(fixtureSecret));
  const stored = await router.get({ job_id: queued.job.id });
  assert.equal(stored.job.status, "uploading");
  assert.equal(calls[0][1].idempotency_key, queued.job.idempotency_key);
  assert.equal(typeof calls[0][1].snapshot_digest, "string");
  assert.equal(stored.job.retry_state, "automatic");
});

test("reuses the same declared idempotency key for an automatic generic retry", async (context) => {
  const { calls, connection, connectionStore, workbenchService, router, connector } = await fixture(context);
  await connectionStore.update(connection.connection_id, { endpoint_mappings: { submit: { headers: { "Idempotency-Key": "{{snapshot.idempotency_key}}" } } } });
  const frozen = await connectionStore.get(connection.connection_id);
  const queued = await queuedGeneric(workbenchService, frozen, "automatic-retry-wire-key");
  let submits = 0;
  connector.submit = async (input) => {
    calls.push(["generic.submit", input]);
    submits += 1;
    if (submits === 1) throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" });
    return { task_id: "automatic-task", status: "submitted", cost: { amount: 0, unit: "provider" } };
  };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "REQUEST_TIMEOUT");
  await router.executePrepared({ job_id: queued.job.id });
  assert.equal(calls.filter(([name]) => name === "generic.submit").length, 2);
  assert.equal(calls[0][1].idempotency_key, calls[1][1].idempotency_key);
  assert.equal(calls[0][1].snapshot_digest, calls[1][1].snapshot_digest);
});

test("does not automatically resubmit an ambiguous non-idempotent provider request", async (context) => {
  const { calls, connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "manual-retry-job");
  connector.submit = async (input) => { calls.push(["generic.submit", input]); throw Object.assign(new Error("timed out"), { code: "REQUEST_TIMEOUT" }); };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "REQUEST_TIMEOUT");
  assert.equal((await router.get({ job_id: queued.job.id })).job.retry_state, "manual");
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "STATUS_CONFLICT");
  assert.equal(calls.length, 1);
  connector.submit = async (input) => { calls.push(["generic.submit", input]); return { task_id: "manual-task", status: "submitted", cost: { amount: 0, unit: "provider" } }; };
  await router.executePrepared({ job_id: queued.job.id, retry: true });
  assert.equal(calls.filter(([name]) => name === "generic.submit").length, 2);
  assert.equal(Object.hasOwn(calls[1][1], "idempotency_key"), false);
});

test("does not enable automatic retry from an idempotency token in a response mapping", async (context) => {
  const { calls, connection, connectionStore, workbenchService, router, connector } = await fixture(context);
  await connectionStore.update(connection.connection_id, { endpoint_mappings: { submit: { method: "POST", path: "/generate", body: { prompt: "{{snapshot.prompt}}" }, result_path: "{{snapshot.idempotency_key}}" } } });
  const frozen = await connectionStore.get(connection.connection_id);
  const queued = await queuedGeneric(workbenchService, frozen, "response-mapping-retry-job");
  connector.submit = async (input) => { calls.push(["generic.submit", input]); throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" }); };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "REQUEST_TIMEOUT");
  const waiting = await router.get({ job_id: queued.job.id });
  assert.equal(waiting.job.retry_state, "manual");
  assert.equal(Object.hasOwn(calls[0][1], "idempotency_key"), false);
});

test("does not enable automatic retry from an idempotency token-shaped JSON body key", async (context) => {
  const { calls, connection, connectionStore, workbenchService, router, connector } = await fixture(context);
  await connectionStore.update(connection.connection_id, { endpoint_mappings: { submit: { method: "POST", path: "/generate", body: { "{{snapshot.idempotency_key}}": "constant" } } } });
  const frozen = await connectionStore.get(connection.connection_id);
  const queued = await queuedGeneric(workbenchService, frozen, "body-key-retry-job");
  connector.submit = async (input) => { calls.push(["generic.submit", input]); throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" }); };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "REQUEST_TIMEOUT");
  const waiting = await router.get({ job_id: queued.job.id });
  assert.equal(waiting.job.retry_state, "manual");
  assert.equal(Object.hasOwn(calls[0][1], "idempotency_key"), false);
});

test("moves reported nonzero or unknown generic cost to explicit confirmation without calling Lovart", async (context) => {
  const { calls, connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "cost-job");
  connector.submit = async (input) => { calls.push(["generic.submit", input]); return { task_id: "cost-task", status: "submitted", pending_confirmation: { amount: 3, unit: "credits" } }; };
  const pending = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(pending.job.status, "awaiting_cost_confirmation");
  assert.deepEqual(pending.job.estimated_cost.amount, 3);
  assert.equal(calls.some(([name]) => name.startsWith("lovart")), false);

  const unknown = await queuedGeneric(workbenchService, connection, "unknown-cost-job");
  connector.submit = async () => ({ task_id: "unknown-task", status: "submitted", requires_confirmation: true });
  const unknownPending = await router.executePrepared({ job_id: unknown.job.id });
  assert.equal(unknownPending.job.status, "awaiting_cost_confirmation");
  assert.equal(unknownPending.job.estimated_cost.unknown, true);
});

test("treats absent generic provider cost metadata as unknown and allows an explicit decline", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "implicit-cost-job");
  connector.submit = async () => ({ task_id: "implicit-cost-task", status: "submitted" });
  const pending = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(pending.job.status, "awaiting_cost_confirmation");
  assert.equal(pending.job.estimated_cost.unknown, true);
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  const declined = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "declined", source: "user:current_session", idempotency_key: "implicit-cost-declined" });
  assert.equal(declined.job.status, "declined");
});

test("does not consume an unknown-cost acceptance when the provider has no confirm or refresh operation", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-confirm-operation-job");
  connector.submit = async () => ({ task_id: "unknown-confirm-task", status: "submitted" });
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  const accepted = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-confirm-accepted" });
  await assert.rejects(router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id }), (error) => error.code === "COST_CONFIRMATION_REQUIRED");
  assert.equal((await router.get({ job_id: pending.job.id })).job.cost_decisions[0].consumed_at, null);
  const declined = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "declined", source: "user:current_session", idempotency_key: "unknown-confirm-declined" });
  assert.equal(declined.job.status, "declined");
});

test("refreshes an unknown provider cost into a new fingerprint before a later approval", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-confirm-job");
  connector.submit = async () => ({ task_id: "unknown-confirm-task", status: "submitted" });
  connector.refreshCost = async (input) => ({ task_id: input.task_id, cost: { amount: 0, unit: "provider" } });
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  const accepted = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-confirm-provider-accepted" });
  const refreshed = await router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id });
  assert.equal(refreshed.job.status, "awaiting_cost_confirmation");
  assert.equal(refreshed.job.estimated_cost.amount, 0);
  const refreshedFingerprint = createCostFingerprint({ ...refreshed.job.estimated_cost, job_id: refreshed.job.id, attempt: refreshed.job.attempt, provider_id: "fixture-api" });
  assert.notEqual(refreshedFingerprint, fingerprint);
  const refreshedDecision = await workbenchService.recordCostDecision({ job_id: refreshed.job.id, attempt: refreshed.job.attempt, cost_fingerprint: refreshedFingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-confirm-provider-refreshed-accepted" });
  const completed = await router.confirm({ job_id: refreshed.job.id, attempt: refreshed.job.attempt, cost_fingerprint: refreshedFingerprint, decision_id: refreshedDecision.decision.decision_id });
  assert.equal(completed.job.status, "succeeded");
});

test("commits a leased unknown-cost decision only after the provider confirm operation succeeds", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-provider-confirm-job");
  connector.submit = async () => ({ task_id: "unknown-provider-confirm-task", status: "submitted" });
  connector.confirm = async () => ({ task_id: "unknown-provider-confirm-task", status: "confirmed" });
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  const accepted = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-provider-confirm-accepted" });
  const completed = await router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id });
  assert.equal(completed.job.status, "succeeded");
  const stored = await router.get({ job_id: queued.job.id });
  assert.equal(stored.job.cost_decisions[0].confirmation.status, "succeeded");
  assert.ok(stored.job.cost_decisions[0].confirmation.lease_id);
});

test("preserves an unknown-cost acceptance when the provider refresh fails", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-confirm-failure-job");
  connector.submit = async () => ({ task_id: "unknown-confirm-failure-task", status: "submitted" });
  let refreshes = 0;
  connector.refreshCost = async () => {
    refreshes += 1;
    if (refreshes === 1) throw Object.assign(new Error("rate limited"), { code: "UPSTREAM_RATE_LIMITED" });
    return { cost: { amount: 0, unit: "provider" } };
  };
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  const accepted = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-confirm-failure-accepted" });
  await assert.rejects(router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id }), (error) => error.code === "UPSTREAM_RATE_LIMITED");
  const after = await router.get({ job_id: queued.job.id });
  assert.equal(after.job.status, "awaiting_cost_confirmation");
  assert.equal(after.job.cost_decisions[0].decision_id, accepted.decision.decision_id);
  assert.equal(after.job.cost_decisions[0].consumed_at, null);
  const retried = await router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id });
  assert.equal(refreshes, 2);
  assert.equal(retried.job.estimated_cost.amount, 0);
});

test("never calls unknown-cost refresh with a forged, stale, or missing acceptance", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-forged-decision-job");
  connector.submit = async () => ({ task_id: "unknown-forged-task", status: "submitted" });
  let refreshCalls = 0;
  connector.refreshCost = async () => { refreshCalls += 1; return { cost: { amount: 0, unit: "provider" } }; };
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  await assert.rejects(router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: "forged-decision" }), (error) => error.code === "COST_CONFIRMATION_CONFLICT");
  assert.equal(refreshCalls, 0);

  const accepted = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-forged-accepted" });
  await assert.rejects(router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: "stale-fingerprint", decision_id: accepted.decision.decision_id }), (error) => error.code === "COST_CONFIRMATION_CONFLICT");
  assert.equal(refreshCalls, 0);
  await router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id });
  assert.equal(refreshCalls, 1);
});

test("holds an unknown-cost decision lease across provider refresh so a concurrent decline cannot race through", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-cost-lease-race-job");
  connector.submit = async () => ({ task_id: "unknown-lease-task", status: "submitted" });
  let enteredRefresh;
  const entered = new Promise((resolve) => { enteredRefresh = resolve; });
  let releaseRefresh;
  const release = new Promise((resolve) => { releaseRefresh = resolve; });
  connector.refreshCost = async () => {
    enteredRefresh();
    await release;
    return { cost: { amount: 0, unit: "provider" } };
  };
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  const accepted = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-lease-accepted" });
  const confirming = router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id });
  await entered;
  await assert.rejects(
    workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "declined", source: "user:current_session", idempotency_key: "unknown-lease-declined-race" }),
    (error) => error.code === "STATUS_CONFLICT",
  );
  releaseRefresh();
  const refreshed = await confirming;
  assert.equal(refreshed.job.status, "awaiting_cost_confirmation");
  assert.equal(refreshed.job.estimated_cost.amount, 0);
});

test("allows a decline before unknown-cost confirmation reserves the provider lease", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "unknown-cost-decline-before-reserve-job");
  connector.submit = async () => ({ task_id: "unknown-decline-task", status: "submitted" });
  let refreshCalls = 0;
  connector.refreshCost = async () => { refreshCalls += 1; return { cost: { amount: 0, unit: "provider" } }; };
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt, provider_id: "fixture-api" });
  const accepted = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "unknown-decline-before-accepted" });
  await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "declined", source: "user:current_session", idempotency_key: "unknown-decline-before-declined" });
  await assert.rejects(router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: accepted.decision.decision_id }), (error) => error.code === "COST_CONFIRMATION_CONFLICT");
  assert.equal(refreshCalls, 0);
});

test("keeps provider polling failures retryable and resumes via the saved provider task id", async (context) => {
  const { calls, resultFile, connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "poll-retry-job");
  let polls = 0;
  connector.poll = async (input) => {
    calls.push(["generic.poll", input]);
    polls += 1;
    if (polls === 1) throw Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" });
    return { task_id: "task-1", status: "succeeded", result: [{ id: "poll-result", kind: "image", local_path: resultFile }] };
  };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "REQUEST_TIMEOUT");
  const retryable = await router.get({ job_id: queued.job.id });
  assert.equal(retryable.job.status, "generating");
  assert.equal(retryable.job.provider_task_id, "task-1");
  const resumed = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(resumed.job.status, "succeeded");
  assert.equal(calls.filter(([name]) => name === "generic.submit").length, 1);
  assert.equal(calls.filter(([name]) => name === "generic.poll").length, 2);
});

test("keeps a rate-limited poll retryable and resumes without a second provider submit", async (context) => {
  const { calls, resultFile, connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "poll-rate-limit-job");
  let polls = 0;
  connector.poll = async (input) => {
    calls.push(["generic.poll", input]);
    polls += 1;
    if (polls === 1) throw Object.assign(new Error("rate limited"), { code: "UPSTREAM_RATE_LIMITED" });
    return { task_id: "task-1", status: "succeeded", result: [{ id: "rate-result", kind: "image", local_path: resultFile }] };
  };
  await assert.rejects(router.executePrepared({ job_id: queued.job.id }), (error) => error.code === "UPSTREAM_RATE_LIMITED");
  const waiting = await router.get({ job_id: queued.job.id });
  assert.equal(waiting.job.status, "generating");
  assert.equal(waiting.job.provider_task_id, "task-1");
  const resumed = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(resumed.job.status, "succeeded");
  assert.equal(calls.filter(([name]) => name === "generic.submit").length, 1);
});

test("continues a known-cost generic job only after an accepted current-session decision", async (context) => {
  const { connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "cost-confirm-job");
  connector.submit = async () => ({ task_id: "confirm-task", status: "submitted", pending_confirmation: { amount: 2, unit: "credits" } });
  const pending = await router.executePrepared({ job_id: queued.job.id });
  const fingerprint = createCostFingerprint({ ...pending.job.estimated_cost, job_id: pending.job.id, attempt: pending.job.attempt });
  const decision = await workbenchService.recordCostDecision({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: "provider-cost-accepted" });
  const completed = await router.confirm({ job_id: pending.job.id, attempt: pending.job.attempt, cost_fingerprint: fingerprint, decision_id: decision.decision.decision_id });
  assert.equal(completed.job.status, "succeeded");
});

test("preserves same-content provider artifacts when their provider identities differ", async (context) => {
  const { dataDirectory, connection, workbenchService, router, connector } = await fixture(context);
  const queued = await queuedGeneric(workbenchService, connection, "cardinality-job");
  const first = path.join(dataDirectory, "results", "same-1.png");
  const second = path.join(dataDirectory, "results", "same-2.png");
  await Promise.all([writeFile(first, "same", { mode: 0o600 }), writeFile(second, "same", { mode: 0o600 })]);
  connector.poll = async () => ({ task_id: "task-1", status: "succeeded", result: [{ id: "provider-a", kind: "image", local_path: first }, { id: "provider-b", kind: "image", local_path: second }] });
  connector.importResults = async (input) => ({ artifacts: input.result });
  const output = await router.executePrepared({ job_id: queued.job.id });
  assert.equal(output.artifacts.length, 2);
  assert.deepEqual(output.artifacts.map((artifact) => artifact.source_artifact_id), ["provider-a", "provider-b"]);
});
