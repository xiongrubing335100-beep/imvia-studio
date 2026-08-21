import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHttpServer } from "../src/http/server.js";
import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { createCostFingerprint } from "../src/domain/cost-confirmation.js";

test("loopback HTTP server reads and revision-patches the same local workbench state", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-"));
  const server = await startHttpServer({ dataDirectory, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  assert.equal(server.host, "127.0.0.1");

  const initial = await fetch(`${server.url}/api/v1/state`).then((response) => response.json());
  assert.equal(initial.ok, true);
  const draftId = initial.data.draft.id;
  const updated = await fetch(`${server.url}/api/v1/drafts/${draftId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base_revision: 0, actor: "user", reason: "Edit locally.", patch: { "prompt.text": "A local HTTP draft." } }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.revision, 1);

  const conflict = await fetch(`${server.url}/api/v1/drafts/${draftId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base_revision: 0, actor: "user", reason: "Stale.", patch: { model: "Kling 3.0" } }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "REVISION_CONFLICT");
});

test("loopback HTTP server serves the bundled live IMVIA Studio workbench", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-workbench-ui-"));
  const server = await startHttpServer({ dataDirectory, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });

  assert.match(server.workbenchUrl, /^http:\/\/127\.0\.0\.1:\d+\/workbench\?imvia=live$/);
  const page = await fetch(server.workbenchUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  const html = await page.text();
  assert.match(html, /<div id="root"><\/div>/);
  const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(scriptPath);

  const script = await fetch(`${server.url}${scriptPath}`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /javascript/);
  assert.match(await script.text(), /IMVIA Studio/);

  const bridgePath = [...html.matchAll(/src="([^"]+\.js)"/g)].map((match) => match[1]).find((value) => value.includes("imvia-lovart-bridge"));
  assert.ok(bridgePath);
  const bridge = await fetch(`${server.url}${bridgePath}`);
  assert.equal(bridge.status, 200);
  assert.match(await bridge.text(), /\/workbench\/lovart\/connect/);

  const root = await fetch(server.url, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/workbench?imvia=live");
});

test("workbench connection routes expose only redacted Lovart status", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-lovart-"));
  const calls = [];
  const server = await startHttpServer({
    dataDirectory,
    port: 0,
    lovartConnection: {
      status: async () => ({ status: "not_connected", code: "CREDENTIAL_REFERENCE_UNAVAILABLE" }),
      connect: async () => { calls.push("connect"); return { status: "connected", checked_at: "2026-08-21T00:00:00.000Z", lovart: { reachable: true } }; },
    },
  });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });

  const status = await fetch(`${server.url}/api/v1/lovart/status`).then((response) => response.json());
  assert.deepEqual(status.data, { status: "not_connected", code: "CREDENTIAL_REFERENCE_UNAVAILABLE" });
  const connected = await fetch(`${server.url}/api/v1/lovart/connect`, { method: "POST", body: "{}" }).then((response) => response.json());
  assert.equal(connected.data.status, "connected");
  assert.deepEqual(calls, ["connect"]);
  assert.equal(JSON.stringify(connected).includes("accessKey"), false);
  assert.equal(JSON.stringify(connected).includes("secretKey"), false);
});

test("workbench connects through form navigation when page request APIs are unavailable", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-lovart-form-"));
  const calls = [];
  const server = await startHttpServer({
    dataDirectory,
    port: 0,
    lovartConnection: {
      status: async () => ({ status: "connected", checked_at: "2026-08-21T00:00:00.000Z" }),
      connect: async () => { calls.push("connect"); return { status: "connected", checked_at: "2026-08-21T00:00:00.000Z", lovart: { reachable: true } }; },
    },
  });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });

  const bootstrap = await fetch(`${server.url}/workbench/bootstrap.js`);
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrap.headers.get("content-type") || "", /javascript/);
  const bootstrapSource = await bootstrap.text();
  assert.match(bootstrapSource, /"status":"connected"/);
  assert.equal(bootstrapSource.includes("accessKey"), false);
  assert.equal(bootstrapSource.includes("secretKey"), false);

  const page = await fetch(server.workbenchUrl).then((response) => response.text());
  const bridgePath = [...page.matchAll(/src="([^"]+\.js)"/g)].map((match) => match[1]).find((value) => value.includes("imvia-lovart-bridge"));
  assert.equal(bridgePath, "/assets/imvia-lovart-bridge-v2.js");
  const bridgeSource = await fetch(`${server.url}${bridgePath}`).then((response) => response.text());
  assert.match(bridgeSource, /method="post"/i);
  assert.match(bridgeSource, /action="\/workbench\/lovart\/connect"/);
  assert.equal(/\bfetch\s*\(/.test(bridgeSource), false);
  assert.equal(/XMLHttpRequest/.test(bridgeSource), false);

  const connected = await fetch(`${server.url}/workbench/lovart/connect`, { method: "POST", redirect: "manual" });
  assert.equal(connected.status, 303);
  assert.equal(connected.headers.get("location"), "/workbench?imvia=live&lovart=connected");
  assert.deepEqual(calls, ["connect"]);
});

test("SSE emits the updated draft revision after a local patch", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-sse-"));
  const server = await startHttpServer({ dataDirectory, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const initial = await fetch(`${server.url}/api/v1/state`).then((response) => response.json());
  const stream = await fetch(`${server.url}/api/v1/events`);
  const reader = stream.body.getReader();
  const nextEvent = (async () => {
    const chunk = await reader.read();
    return new TextDecoder().decode(chunk.value);
  })();
  await fetch(`${server.url}/api/v1/drafts/${initial.data.draft.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_revision: 0, actor: "user", reason: "Edit with an event.", patch: { "prompt.text": "SSE draft." } }) });
  const event = await nextEvent;
  assert.match(event, /id: 1/);
  assert.match(event, /event: draft\.updated/);
  await reader.cancel();
});

test("SSE forwards patches made through the shared domain service", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-shared-sse-"));
  const service = createWorkbenchService({ dataDirectory });
  const server = await startHttpServer({ service, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const initial = await service.getState();
  const stream = await fetch(`${server.url}/api/v1/events`);
  const reader = stream.body.getReader();
  const nextEvent = reader.read().then(({ value }) => new TextDecoder().decode(value));
  await service.patchWorkbench({ draft_id: initial.draft.id, base_revision: 0, actor: "codex", reason: "MCP-equivalent patch.", patch: { model: "Kling 3.0" } });

  assert.match(await nextEvent, /event: draft\.updated/);
  await reader.cancel();
});

test("HTTP runs the local cost-confirmation fixture and exposes imported artifacts", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-fixture-"));
  const service = createWorkbenchService({ dataDirectory });
  const server = await startHttpServer({ service, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const fixture = JSON.parse(await readFile(new URL("./fixtures/lovart-success.json", import.meta.url), "utf8"));
  const resultDirectory = path.join(dataDirectory, "results");
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(path.join(resultDirectory, "rainy-street.mp4"), "fixture-video-bytes");
  const initial = await fetch(`${server.url}/api/v1/state`).then((response) => response.json());
  const draftId = initial.data.draft.id;
  await fetch(`${server.url}/api/v1/drafts/${draftId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base_revision: 0, actor: "user", reason: "Prepare HTTP fixture.", patch: { model: "Seedance 2.5", "prompt.text": "HTTP fixture lifecycle.", "settings.duration_seconds": 10 } }),
  });

  const preparedResponse = await fetch(`${server.url}/api/v1/drafts/${draftId}/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expected_revision: 1, idempotency_key: "http-fixture" }),
  });
  assert.equal(preparedResponse.status, 200);
  const prepared = await preparedResponse.json();
  assert.equal(prepared.data.status, "queued_for_agent");

  for (const transition of fixture.transitions) {
    let confirmation = {};
    if (transition.expected_status === "awaiting_cost_confirmation" && transition.next_status === "generating") {
      const jobId = prepared.data.job_id;
      const fingerprint = createCostFingerprint({ job_id: jobId, attempt: 1, amount: 135, unit: "credits", checked_at: "2026-08-20T00:00:00.000Z", source: "fixture:lovart_generate" });
      const accepted = await service.recordCostDecision({ job_id: jobId, attempt: 1, cost_fingerprint: fingerprint, decision: "accepted", source: "user:current_session", idempotency_key: `http-fixture-accept:${jobId}` });
      await service.claimCostDecision({ decision_id: accepted.decision.decision_id, job_id: jobId, attempt: 1, cost_fingerprint: fingerprint });
      confirmation = { cost_decision_id: accepted.decision.decision_id, confirmation_evidence: { kind: "confirmation_accepted" } };
    }
    const response = await fetch(`${server.url}/api/v1/jobs/${prepared.data.job_id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt: 1, ...transition, ...confirmation }),
    });
    assert.equal(response.status, 200);
  }
  const artifacts = fixture.artifacts.map((artifact) => ({ ...artifact, local_path: path.join(dataDirectory, artifact.local_path) }));
  const importedResponse = await fetch(`${server.url}/api/v1/jobs/${prepared.data.job_id}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifacts, idempotency_key: "http-fixture-result" }),
  });
  assert.equal(importedResponse.status, 200);
  assert.equal((await importedResponse.json()).data.status, "succeeded");

  const state = await fetch(`${server.url}/api/v1/state?include=jobs,artifacts`).then((response) => response.json());
  assert.equal(state.data.jobs[0].status, "succeeded");
  assert.equal(state.data.artifacts[0].source_artifact_id, "fixture-video-001");
  assert.equal(Object.hasOwn(state.data.artifacts[0], "local_path"), false);
  assert.equal(state.data.artifacts[0].content_url, `/api/v1/artifacts/${state.data.artifacts[0].id}/content`);
});

test("SSE forwards job lifecycle events", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-job-sse-"));
  const service = createWorkbenchService({ dataDirectory });
  const server = await startHttpServer({ service, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const initial = await service.getState();
  await service.patchWorkbench({ draft_id: initial.draft.id, base_revision: 0, actor: "user", reason: "Prepare SSE job.", patch: { model: "Seedance 2.5", "prompt.text": "SSE lifecycle.", "settings.duration_seconds": 10 } });
  const { job } = await service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "sse-job" });
  const stream = await fetch(`${server.url}/api/v1/events`);
  const reader = stream.body.getReader();
  const nextEvent = reader.read().then(({ value }) => new TextDecoder().decode(value));
  await service.updateJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "fixture:sse" });

  assert.match(await nextEvent, /event: job\.updated/);
  await reader.cancel();
});

test("HTTP exposes project context and derives workbench Lovart activation", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-projects-"));
  const calls = [];
  const projectContextService = {
    async list() { return { active_lovart_project_id: "project-1", projects: [{ project_id: "project-1", name: "项目", canvas_url: "https://www.lovart.ai/canvas?projectId=project-1" }] }; },
    async select(input) { calls.push(["select", input]); return { project_id: "project-2", canvas_url: "https://www.lovart.ai/canvas?projectId=project-2" }; },
    async create(input) { calls.push(["create", input]); return { project_id: "project-new", canvas_url: "https://www.lovart.ai/canvas?projectId=project-new" }; },
  };
  const orchestrator = {
    async submit(input) { calls.push(["submit", input]); return { job: { id: "job-1", status: "queued_for_agent" } }; },
    async get(input) { return { job: { id: input.job_id, status: "succeeded" }, artifacts: [] }; },
    async confirm(input) { calls.push(["confirm", input]); return { job: { id: input.job_id, status: "succeeded" }, result: {} }; },
  };
  const service = createWorkbenchService({ dataDirectory });
  const server = await startHttpServer({ dataDirectory, service, projectContextService, orchestrator, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });

  const projects = await fetch(`${server.url}/api/v1/lovart/projects`).then((response) => response.json());
  assert.equal(projects.data.active_lovart_project_id, "project-1");
  const selected = await fetch(`${server.url}/api/v1/lovart/projects/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locator: "project-2" }) }).then((response) => response.json());
  assert.equal(selected.data.project_id, "project-2");
  const created = await fetch(`${server.url}/api/v1/lovart/projects/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "新项目" }) }).then((response) => response.json());
  assert.equal(created.data.project_id, "project-new");
  const generated = await fetch(`${server.url}/api/v1/generations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "A red apple", idempotency_key: "http-job" }) });
  assert.equal(generated.status, 202);
  assert.equal(calls.find(([name]) => name === "submit")[1].activation.source, "workbench_action");
  assert.equal(JSON.stringify(generated).includes("accessKey"), false);
  const rejectedActivation = await fetch(`${server.url}/api/v1/generations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "bad", activation: { source: "codex_explicit" }, idempotency_key: "http-bad" }) });
  assert.equal(rejectedActivation.status, 400);
});

test("HTTP remembers a project and queues a Codex handoff without validating or calling Lovart", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-handoff-"));
  const calls = [];
  const service = createWorkbenchService({ dataDirectory });
  const projectContextService = {
    async list() { return { active_lovart_project_id: null, projects: [] }; },
    async remember(input) {
      calls.push(["remember", input]);
      return { project_id: "project-local", canvas_url: "https://www.lovart.ai/canvas?projectId=project-local" };
    },
    async select() { calls.push(["select"]); throw new Error("select must not run"); },
  };
  const orchestrator = { async submit() { calls.push(["submit"]); throw new Error("submit must not run"); } };
  const server = await startHttpServer({ dataDirectory, service, projectContextService, orchestrator, port: 0 });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });

  const remembered = await fetch(`${server.url}/api/v1/lovart/projects/remember`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locator: "project-local", source: "user_selected" }),
  }).then((response) => response.json());
  assert.equal(remembered.data.project_id, "project-local");

  const uploaded = await fetch(`${server.url}/api/v1/workbench/assets`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.from("local-image-bytes"),
  }).then((response) => response.json());
  assert.match(uploaded.data.attachment, /^imvia-upload:[0-9a-f-]+\.png$/u);
  assert.equal(await readFile(path.join(dataDirectory, "workbench-uploads", uploaded.data.attachment.slice("imvia-upload:".length)), "utf8"), "local-image-bytes");

  const submitted = await fetch(`${server.url}/api/v1/workbench/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotency_key: "http-handoff-1",
      snapshot: { mode: "image", model: "Seedream 4.0", prompt: { text: "Send this to Codex", tokens: [] }, attachments: [uploaded.data.attachment], settings: { count: 1 } },
    }),
  }).then((response) => response.json());
  assert.equal(submitted.data.status, "queued_for_agent");
  assert.deepEqual(calls, [["remember", { locator: "project-local", source: "user_selected" }]]);
});

test("HTTP follow-up derives contextual activation and rejects client activation", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-follow-up-"));
  const calls = [];
  const server = await startHttpServer({
    dataDirectory,
    service: createWorkbenchService({ dataDirectory }),
    orchestrator: {
      async followUp(input) { calls.push(input); return { job: { id: "follow-job", status: "queued_for_agent" }, idempotent: false }; },
      async get(input) { return { job: { id: input.job_id }, artifacts: [] }; },
    },
    port: 0,
  });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const response = await fetch(`${server.url}/api/v1/jobs/parent-job/follow-ups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact_id: "artifact-1", instruction: "Make it dusk", idempotency_key: "follow-http" }),
  });
  assert.equal(response.status, 202);
  assert.equal(calls[0].parent_job_id, "parent-job");
  assert.equal(calls[0].activation.source, "codex_context_continuation");
  assert.equal(calls[0].activation.artifact_id, "artifact-1");
  const rejected = await fetch(`${server.url}/api/v1/jobs/parent-job/follow-ups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact_id: "artifact-1", instruction: "bad", activation: { source: "codex_explicit" }, idempotency_key: "follow-http-2" }),
  });
  assert.equal(rejected.status, 400);
});

test("HTTP reads a redacted job and delegates exact cost confirmation", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-http-job-routes-"));
  const calls = [];
  const server = await startHttpServer({
    dataDirectory,
    port: 0,
    orchestrator: {
      async get(input) { return { job: { id: input.job_id, status: "awaiting_cost_confirmation" }, artifacts: [] }; },
      async confirm(input) { calls.push(input); return { job: { id: input.job_id, status: "succeeded" }, result: { final_status: "done" } }; },
      async submit() { return { job: { id: "unused" } }; },
    },
  });
  context.after(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const job = await fetch(`${server.url}/api/v1/jobs/job-1`).then((response) => response.json());
  assert.equal(job.data.job.id, "job-1");
  const confirmed = await fetch(`${server.url}/api/v1/jobs/job-1/cost-decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attempt: 1, cost_fingerprint: "a".repeat(64), decision_id: "decision-1" }) }).then((response) => response.json());
  assert.equal(confirmed.data.job.status, "succeeded");
  assert.deepEqual(calls, [{ job_id: "job-1", attempt: 1, cost_fingerprint: "a".repeat(64), decision_id: "decision-1" }]);
});
