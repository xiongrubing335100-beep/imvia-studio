import assert from "node:assert/strict";
import test from "node:test";
import {
  assertContinuationParent,
  chooseLovartProject,
  normalizeLovartProjectLocator,
} from "../src/domain/lovart-project-context.js";

test("normalizes a Lovart project id into the official canvas URL", () => {
  assert.deepEqual(normalizeLovartProjectLocator("project-1"), {
    project_id: "project-1",
    canvas_url: "https://www.lovart.ai/canvas?projectId=project-1",
  });
  assert.deepEqual(
    normalizeLovartProjectLocator("https://www.lovart.ai/canvas?projectId=project-1"),
    { project_id: "project-1", canvas_url: "https://www.lovart.ai/canvas?projectId=project-1" },
  );
});

test("rejects arbitrary hosts, paths, credentials, fragments, and empty locators", () => {
  for (const locator of [
    "",
    "   ",
    "https://evil.example/?projectId=project-1",
    "http://www.lovart.ai/canvas?projectId=project-1",
    "https://www.lovart.ai/not-canvas?projectId=project-1",
    "https://user:secret@www.lovart.ai/canvas?projectId=project-1",
    "https://www.lovart.ai/canvas?projectId=project-1#https://evil.example/?projectId=bad",
    "https://www.lovart.ai/canvas",
    "https://www.lovart.ai/canvas?projectId=",
  ]) {
    assert.throws(
      () => normalizeLovartProjectLocator(locator),
      (error) => error.code === "INVALID_LOVART_PROJECT_LOCATOR",
      locator,
    );
  }
});

test("chooses explicit project, then active project, then auto-create", () => {
  assert.deepEqual(chooseLovartProject({ explicit_project_id: "explicit", active_project_id: "active" }), {
    project_id: "explicit",
    source: "explicit",
  });
  assert.deepEqual(chooseLovartProject({ explicit_project_id: "", active_project_id: "active" }), {
    project_id: "active",
    source: "active",
  });
  assert.deepEqual(chooseLovartProject({ explicit_project_id: null, active_project_id: null }), {
    project_id: null,
    source: "auto_create",
  });
});

test("requires a lineage reference for contextual continuation", () => {
  assert.deepEqual(assertContinuationParent({ activation_source: "explicit" }), {
    activation_source: "explicit",
  });
  assert.deepEqual(assertContinuationParent({ activation_source: "workbench" }), {
    activation_source: "workbench",
  });
  assert.deepEqual(assertContinuationParent({ activation_source: "contextual", parent_job_id: "job-1" }), {
    activation_source: "contextual",
    parent_job_id: "job-1",
  });
  assert.deepEqual(assertContinuationParent({ activation_source: "contextual", artifact_id: "artifact-1" }), {
    activation_source: "contextual",
    artifact_id: "artifact-1",
  });
  assert.throws(
    () => assertContinuationParent({ activation_source: "contextual" }),
    (error) => error.code === "INVALID_CONTINUATION_PARENT",
  );
  assert.throws(
    () => assertContinuationParent({ activation_source: "contextual", parent_job_id: "" }),
    (error) => error.code === "INVALID_CONTINUATION_PARENT",
  );
});
