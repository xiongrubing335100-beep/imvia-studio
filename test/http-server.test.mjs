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

  const root = await fetch(server.url, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/workbench?imvia=live");
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
