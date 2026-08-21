import assert from "node:assert/strict";
import test from "node:test";
import { presentLovartResultWorkspace, resultArtifactPreview } from "../src/domain/lovart-result-presentation.js";

test("keeps the empty result shell before the first imported artifact", () => {
  for (const status of [null, "generating", "awaiting_cost_confirmation", "failed"]) {
    const model = presentLovartResultWorkspace({ job: status ? { id: "job-1", status } : null, artifacts: [] });
    assert.equal(model.state, "empty");
    assert.deepEqual(model.artifacts, []);
  }
});

test("switches to populated groups in import order and preserves partial results", () => {
  const model = presentLovartResultWorkspace({
    job: { id: "job-1", status: "partially_succeeded" },
    artifacts: [
      { id: "b", job_id: "job-1", kind: "video", created_at: "2026-08-21T00:00:02.000Z" },
      { id: "a", job_id: "job-1", kind: "image", created_at: "2026-08-21T00:00:01.000Z" },
      { id: "a", job_id: "job-1", kind: "image", created_at: "2026-08-21T00:00:01.000Z" },
      { id: "c", job_id: "job-2", kind: "audio", created_at: "2026-08-21T00:00:03.000Z" },
    ],
  });
  assert.equal(model.state, "populated");
  assert.deepEqual(model.artifacts.map((artifact) => artifact.id), ["a", "b", "c"]);
  assert.deepEqual(model.groups.map((group) => [group.job_id, group.artifacts.length]), [["job-1", 2], ["job-2", 1]]);
});

test("stale selected job with no matching artifacts remains empty", () => {
  const model = presentLovartResultWorkspace({ job: { id: "job-new", status: "generating" }, artifacts: [{ id: "old", job_id: "job-old", kind: "image" }] });
  assert.equal(model.state, "preparing");
  assert.equal(model.groups[0].job_id, "job-old");
});

test("preview affordances are media-specific and redacted", () => {
  assert.deepEqual(resultArtifactPreview({ id: "a", kind: "image", local_path: "/secret/key" }), { kind: "image", label: "图片结果", canPreview: true });
  assert.deepEqual(resultArtifactPreview({ id: "v", kind: "video" }), { kind: "video", label: "视频结果", canPreview: true });
  assert.equal(JSON.stringify(resultArtifactPreview({ id: "a", kind: "image", local_path: "/secret/key" })).includes("secret"), false);
});
