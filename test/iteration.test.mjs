import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchService } from "../src/domain/workbench-service.js";

async function completeJob({ service, dataDirectory, draftId, idempotencyKey, threadId, artifactName }) {
  const { job } = await service.prepareGeneration({
    draft_id: draftId,
    expected_revision: 1,
    idempotency_key: idempotencyKey,
  });
  await service.updateJob({ job_id: job.id, expected_status: "queued_for_agent", next_status: "uploading", attempt: 1, source: "fixture:iteration" });
  await service.updateJob({
    job_id: job.id,
    expected_status: "uploading",
    next_status: "submitted",
    attempt: 1,
    source: "fixture:iteration",
    ...(threadId == null ? {} : { lovart_thread_id: threadId }),
  });
  await service.updateJob({ job_id: job.id, expected_status: "submitted", next_status: "generating", attempt: 1, source: "fixture:iteration" });
  const resultDirectory = path.join(dataDirectory, "results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = path.join(resultDirectory, `${artifactName}.mp4`);
  await writeFile(resultPath, `${artifactName}-fixture-video`);
  const imported = await service.importResult({
    job_id: job.id,
    idempotency_key: `${idempotencyKey}-result`,
    artifacts: [{ kind: "video", local_path: resultPath, mime_type: "video/mp4", source_artifact_id: `${artifactName}-video` }],
  });
  return { job: imported.job, artifact: imported.results[0].artifact };
}

async function createSucceededParent(context, { threadId = "fixture-thread-parent" } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-iteration-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const service = createWorkbenchService({ dataDirectory });
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: 0,
    actor: "user",
    reason: "Create a completed parent fixture.",
    patch: {
      model: "Seedance 2.5",
      "prompt.text": "A parent fixture with a moving camera.",
      "settings.duration_seconds": 10,
    },
  });
  const completed = await completeJob({
    service,
    dataDirectory,
    draftId: initial.draft.id,
    idempotencyKey: "iteration-parent",
    threadId,
    artifactName: "parent",
  });
  return { dataDirectory, service, draftId: initial.draft.id, parent: completed.job, artifact: completed.artifact };
}

test("creates a new editable iteration draft without mutating its parent snapshot", async (context) => {
  const { service, parent, artifact } = await createSucceededParent(context);
  const originalPrompt = parent.snapshot.prompt.text;
  const created = await service.createIteration({ source_job_id: parent.id, artifact_id: artifact.id, reuse_lovart_thread: true, instruction: "Make the camera move more slowly." });
  assert.equal(created.parent_job_id, parent.id);
  assert.equal(created.iteration_index, 1);
  assert.equal(created.reusable_thread.lovart_thread_id, "fixture-thread-parent");
  assert.equal(created.reusable_thread.source, "fixture:iteration");
  assert.equal(created.draft.revision, 0);
  assert.equal(created.draft.prompt.text, `${originalPrompt}\n\n迭代要求：Make the camera move more slowly.`);

  const state = await service.getState({ include: ["jobs"] });
  assert.equal(state.jobs.find((job) => job.id === parent.id).snapshot.prompt.text, originalPrompt);
});

test("prepares a child snapshot with direct-parent lineage and optional thread reuse", async (context) => {
  const { service, parent, artifact } = await createSucceededParent(context);
  const created = await service.createIteration({ source_job_id: parent.id, artifact_id: artifact.id, reuse_lovart_thread: true, instruction: "Keep character continuity." });
  const prepared = await service.prepareGeneration({ draft_id: created.draft.id, expected_revision: 0, idempotency_key: "iteration-child" });
  assert.equal(prepared.job.parent_job_id, parent.id);
  assert.equal(prepared.job.iteration_index, 1);
  assert.equal(prepared.job.lovart_thread_id, "fixture-thread-parent");
  assert.equal(prepared.job.lovart_thread_source, "fixture:iteration");
  assert.deepEqual(prepared.job.cost_decisions, []);
});

test("treats a genuine legacy parent without iteration_index as iteration zero", async (context) => {
  const fixture = await createSucceededParent(context);
  const statePath = path.join(fixture.dataDirectory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.jobs.find((job) => job.id === fixture.parent.id).iteration_index;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const created = await fixture.service.createIteration({
    source_job_id: fixture.parent.id,
    artifact_id: fixture.artifact.id,
    reuse_lovart_thread: false,
    instruction: "Legacy child.",
  });
  assert.equal(created.iteration_index, 1);
});

test("rejects invalid stored parent iteration indices", async (context) => {
  for (const invalid of [-1, 1.5, null, "1"]) {
    await context.test(String(invalid), async (subcontext) => {
      const fixture = await createSucceededParent(subcontext);
      const statePath = path.join(fixture.dataDirectory, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.jobs.find((job) => job.id === fixture.parent.id).iteration_index = invalid;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      await assert.rejects(
        () => fixture.service.createIteration({ source_job_id: fixture.parent.id, artifact_id: fixture.artifact.id, reuse_lovart_thread: false, instruction: "Invalid index." }),
        (error) => error.code === "VALIDATION_FAILED" && error.details.field === "iteration_index",
      );
    });
  }
});

test("rejects a real artifact owned by another completed job", async (context) => {
  const fixture = await createSucceededParent(context);
  const other = await completeJob({
    service: fixture.service,
    dataDirectory: fixture.dataDirectory,
    draftId: fixture.draftId,
    idempotencyKey: "other-completed-parent",
    threadId: "fixture-thread-other",
    artifactName: "other-parent",
  });

  await assert.rejects(
    () => fixture.service.createIteration({ source_job_id: fixture.parent.id, artifact_id: other.artifact.id, reuse_lovart_thread: false, instruction: "Cross-job artifact." }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("rejects requested thread reuse from a parent that genuinely has no thread", async (context) => {
  const fixture = await createSucceededParent(context, { threadId: null });
  await assert.rejects(
    () => fixture.service.createIteration({ source_job_id: fixture.parent.id, artifact_id: fixture.artifact.id, reuse_lovart_thread: true, instruction: "No thread." }),
    (error) => error.code === "VALIDATION_FAILED" && error.details.field === "reuse_lovart_thread",
  );
});

test("rejects legacy or invalid direct-parent thread provenance", async (context) => {
  for (const provenance of [undefined, "imvia:iteration", "fixture:"]) {
    await context.test(String(provenance), async (subcontext) => {
      const fixture = await createSucceededParent(subcontext);
      const statePath = path.join(fixture.dataDirectory, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const parent = state.jobs.find((job) => job.id === fixture.parent.id);
      if (provenance === undefined) delete parent.lovart_thread_source;
      else parent.lovart_thread_source = provenance;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      await assert.rejects(
        () => fixture.service.createIteration({ source_job_id: fixture.parent.id, artifact_id: fixture.artifact.id, reuse_lovart_thread: true, instruction: "Invalid provenance." }),
        (error) => error.code === "VALIDATION_FAILED" && error.details.field === "reuse_lovart_thread",
      );
    });
  }
});
