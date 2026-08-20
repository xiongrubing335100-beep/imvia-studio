import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACTIONS,
  nextOrchestrationAction,
  orderedReferenceIds,
} from "../src/orchestration/policy.js";

test("returns one legal next action for queue, upload, submit, confirmation, and generation", () => {
  assert.equal(nextOrchestrationAction({ job: { status: "queued_for_agent", attempt: 1 } }).type, ACTIONS.BEGIN_UPLOAD);
  assert.equal(nextOrchestrationAction({ job: { status: "uploading", attempt: 1 }, event: { type: "uploads_succeeded" } }).type, ACTIONS.SUBMIT_GENERATION);
  assert.equal(nextOrchestrationAction({ job: { status: "submitted", attempt: 1 }, event: { type: "cost_confirmation" } }).type, ACTIONS.WAIT_FOR_COST);
  assert.equal(nextOrchestrationAction({ job: { status: "generating", attempt: 1 }, event: { type: "status_succeeded" } }).type, ACTIONS.FETCH_RESULT);
});

test("rejects ambiguous and stale cost decisions without a confirm action", () => {
  const job = { id: "job-1", status: "awaiting_cost_confirmation", attempt: 2, cost_fingerprint: "a".repeat(64) };
  assert.equal(nextOrchestrationAction({ job, decision: { kind: "ambiguous" } }).type, ACTIONS.REQUEST_COST_CONFIRMATION);
  assert.equal(nextOrchestrationAction({ job, decision: { kind: "accepted", job_id: "job-old", attempt: 2, cost_fingerprint: "a".repeat(64) } }).type, ACTIONS.REJECT_DECISION);
});

test("orders referenced assets by stable prompt token then remaining reference IDs", () => {
  const snapshot = { prompt: { tokens: [{ reference_id: "video-1" }, { reference_id: "image-1" }, { reference_id: "video-1" }] }, reference_ids: ["image-1", "audio-1", "video-1"] };
  assert.deepEqual(orderedReferenceIds(snapshot), ["video-1", "image-1", "audio-1"]);
});

test("throws on an unknown event instead of guessing success", () => {
  assert.throws(() => nextOrchestrationAction({ job: { status: "submitted", attempt: 1 }, event: { type: "mystery" } }), (error) => error.code === "ORCHESTRATION_EVENT_UNKNOWN");
});

test("throws on an unknown event while awaiting cost confirmation", () => {
  const job = { id: "job-1", status: "awaiting_cost_confirmation", attempt: 2, cost_fingerprint: "a".repeat(64) };
  const decision = { kind: "accepted", job_id: "job-1", attempt: 2, cost_fingerprint: "a".repeat(64) };
  assert.throws(() => nextOrchestrationAction({ job, event: { type: "mystery" }, decision }), (error) => error.code === "ORCHESTRATION_EVENT_UNKNOWN");
});

test("policy has no I/O, transport, environment, or network capability", async () => {
  const source = await readFile(new URL("../src/orchestration/policy.js", import.meta.url), "utf8");
  for (const forbidden of ["node:fs", "node:http", "node:https", "fetch(", "StdioClientTransport", "process.env"]) {
    assert.equal(source.includes(forbidden), false, `Forbidden policy capability: ${forbidden}`);
  }
});
