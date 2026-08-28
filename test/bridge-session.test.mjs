import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBridgeSessionService } from "../src/bridge/bridge-session-service.js";
import { buildWorkbenchTaskMessage } from "../src/bridge/task-message.js";

async function withService(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "imvia-bridge-"));
  try {
    let now = Date.parse("2026-08-23T00:00:00.000Z");
    const service = createBridgeSessionService({ dataDirectory: directory, clock: () => now });
    await run(service, { advance: (milliseconds) => { now += milliseconds; } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("conversation bridge registers, claims, accepts, and marks Codex receipt", async () => {
  await withService(async (service) => {
    const opened = await service.openSession();
    assert.equal(opened.bridge_state, "mounting");
    assert.equal((await service.validateSessionToken({ session_id: opened.session_id, open_token: opened.open_token })).session_id, opened.session_id);
    const ready = await service.registerBridge({ session_id: opened.session_id, open_token: opened.open_token, bridge_id: "bridge-1" });
    assert.equal(ready.bridge_state, "ready");
    const created = await service.createDispatch({
      job_id: "job-1",
      workbench_session_id: opened.session_id,
      idempotency_key: "handoff-1",
      snapshot: { mode: "image", model: "I2Image 2", prompt: { text: "make an image" }, settings: { ratio: "3:4" } },
    });
    assert.equal(created.dispatch.delivery_state, "pending_bridge");
    const claimed = await service.claimNext({ session_id: opened.session_id, bridge_id: "bridge-1" });
    assert.equal(claimed.dispatch.job_id, "job-1");
    assert.equal(claimed.dispatch.schema_version, "imvia.workbench-task.v1");
    assert.equal(claimed.dispatch.activation.source, "workbench_action");
    assert.ok(claimed.dispatch.claim_token);
    await service.markHostAccepted({ dispatch_id: claimed.dispatch.dispatch_id, session_id: opened.session_id, bridge_id: "bridge-1", claim_token: claimed.dispatch.claim_token });
    const received = await service.markCodexReceived({ job_id: "job-1", snapshot_digest: claimed.dispatch.snapshot_digest });
    assert.equal(received.dispatch.delivery_state, "codex_received");
    assert.equal((await service.claimNext({ session_id: opened.session_id, bridge_id: "bridge-1" })).dispatch, null);
  });
});

test("conversation bridge reuses idempotent dispatches and rejects an invalid session token", async () => {
  await withService(async (service) => {
    const opened = await service.openSession();
    await assert.rejects(
      service.registerBridge({ session_id: opened.session_id, open_token: "wrong", bridge_id: "bridge-1" }),
      (error) => error.code === "SESSION_TOKEN_INVALID",
    );
    const snapshot = { mode: "video", prompt: { text: "make a video" }, references: [] };
    const first = await service.createDispatch({ job_id: "job-2", workbench_session_id: opened.session_id, idempotency_key: "same-key", snapshot });
    const second = await service.createDispatch({ job_id: "job-2", workbench_session_id: opened.session_id, idempotency_key: "same-key", snapshot });
    assert.equal(second.idempotent, true);
    assert.equal(second.dispatch.id, first.dispatch.id);
  });
});

test("a bridge heartbeat becomes stale without changing the durable dispatch", async () => {
  await withService(async (service, clock) => {
    const opened = await service.openSession();
    await service.registerBridge({ session_id: opened.session_id, open_token: opened.open_token, bridge_id: "bridge-1" });
    await service.createDispatch({ job_id: "job-3", workbench_session_id: opened.session_id, idempotency_key: "handoff-3", snapshot: { mode: "image", prompt: { text: "x" } } });
    clock.advance(21_000);
    const status = await service.getSessionStatus({ session_id: opened.session_id });
    assert.equal(status.bridge_state, "stale");
    const claimed = await service.claimNext({ session_id: opened.session_id, bridge_id: "bridge-1" });
    assert.equal(claimed.active, false);
    assert.equal((await service.listDispatches({ session_id: opened.session_id }))[0].delivery_state, "pending_bridge");
  });
});

test("bridge lifecycle emits redacted delivery events", async () => {
  await withService(async (service) => {
    const events = [];
    service.subscribe((event) => events.push(event));
    const opened = await service.openSession();
    await service.registerBridge({ session_id: opened.session_id, open_token: opened.open_token, bridge_id: "bridge-1" });
    await service.createDispatch({ job_id: "job-4", workbench_session_id: opened.session_id, idempotency_key: "handoff-4", snapshot: { mode: "image", prompt: { text: "private prompt" } } });
    const created = events.find((event) => event.type === "dispatch.created");
    assert.equal(created.data.job_id, "job-4");
    assert.equal(Object.hasOwn(created.data, "snapshot"), false);
    assert.equal(Object.hasOwn(created.data, "message"), false);
  });
});

test("the Codex task message identifies an unconstrained image count as Auto", () => {
  const message = buildWorkbenchTaskMessage({
    jobId: "job-auto",
    dispatchId: "dispatch-auto",
    workbenchSessionId: "session-auto",
    digest: "digest-auto",
    snapshot: {
      mode: "image",
      model: "Image 2",
      prompt: { text: "Split the source into all required images." },
      references: [],
      settings: { ratio: "3:4", resolution: "2K", count_mode: "auto", count: null },
    },
  });

  assert.match(message, /设置：3:4 · 2K · Auto/u);
  assert.doesNotMatch(message, /1个/u);
});

test("an external-provider dispatch locks Codex to that API without Lovart instructions", async () => {
  await withService(async (service) => {
    const opened = await service.openSession();
    await service.registerBridge({ session_id: opened.session_id, open_token: opened.open_token, bridge_id: "external-provider-bridge" });
    await service.createDispatch({
      job_id: "external-provider-job",
      workbench_session_id: opened.session_id,
      idempotency_key: "external-provider-handoff",
      snapshot: {
        provider_id: "fixture-api",
        provider_label: "Fixture API",
        connection_id: "fixture-connection",
        connection_config_revision: 7,
        mode: "image",
        model: "fixture-image",
        prompt: { text: "Generate through the configured API only." },
        references: [],
        settings: { ratio: "1:1" },
      },
    });

    const claimed = await service.claimNext({ session_id: opened.session_id, bridge_id: "external-provider-bridge" });
    assert.equal(claimed.dispatch.summary.provider_id, "fixture-api");
    assert.equal(claimed.dispatch.summary.connection_id, "fixture-connection");
    assert.equal(claimed.dispatch.summary.connection_config_revision, 7);
    assert.match(claimed.dispatch.message, /提供方：Fixture API \(fixture-api\)/u);
    assert.match(claimed.dispatch.message, /只能通过 imvia_execute_workbench_submission/u);
    assert.match(claimed.dispatch.message, new RegExp(claimed.dispatch.snapshot_digest, "u"));
    assert.match(claimed.dispatch.message, /不得调用任何 Lovart 工具或能力/u);
    assert.doesNotMatch(claimed.dispatch.message, /准备调用 Lovart|持续同步 Lovart|通过 Lovart .*处理/u);
  });
});
