import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifactTransfer } from "../src/lovart/artifact-transfer.js";

test("prepareUpload accepts only regular files inside the managed data directory", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-artifact-transfer-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const localPath = path.join(dataDirectory, "references", "image.png");
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, "image", { flag: "w", mode: 0o600 });
  const transfer = createArtifactTransfer({ dataDirectory });
  assert.deepEqual(await transfer.prepareUpload({ local_path: localPath }), { file_path: localPath });
  await assert.rejects(() => transfer.prepareUpload({ local_path: "/tmp/outside.png" }), (error) => error.code === "PATH_NOT_ALLOWED");
});

test("prepareWorkspaceAsset accepts only bundled asset paths", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-artifact-transfer-workspace-"));
  const workspaceDirectory = path.join(dataDirectory, "workbench", "dist");
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await mkdir(path.join(workspaceDirectory, "assets"), { recursive: true });
  await writeFile(path.join(workspaceDirectory, "assets", "sample.png"), "image", { mode: 0o600 });
  const transfer = createArtifactTransfer({ dataDirectory, workspaceDirectory });
  assert.deepEqual(await transfer.prepareWorkspaceAsset({ asset_path: "/assets/sample.png" }), { file_path: path.join(workspaceDirectory, "assets", "sample.png") });
  await assert.rejects(() => transfer.prepareWorkspaceAsset({ asset_path: "/etc/passwd" }), (error) => error.code === "PATH_NOT_ALLOWED");
});

test("prepareManagedUpload resolves only opaque workbench upload names", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-artifact-transfer-managed-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const assetName = "123e4567-e89b-42d3-a456-426614174000.png";
  const localPath = path.join(dataDirectory, "workbench-uploads", assetName);
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, "image", { mode: 0o600 });
  const transfer = createArtifactTransfer({ dataDirectory });

  assert.deepEqual(await transfer.prepareManagedUpload({ asset_name: assetName }), { file_path: localPath });
  await assert.rejects(() => transfer.prepareManagedUpload({ asset_name: "../secret.png" }), (error) => error.code === "PATH_NOT_ALLOWED");
});

test("downloadResults writes HTTPS artifacts under one deterministic job directory", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-artifact-transfer-results-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const requests = [];
  const transfer = createArtifactTransfer({
    dataDirectory,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, headers: new Map([["content-type", "image/png"]]), async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; } };
    },
  });
  const result = await transfer.downloadResults({
    job_id: "job-1",
    result: { items: [{ kind: "image", url: "https://cdn.lovart.ai/result.png", artifact_id: "source-1" }] },
  });
  assert.deepEqual(result.artifacts.map(({ kind, source_url, source_artifact_id, local_path }) => ({ kind, source_url, source_artifact_id, local_path: path.relative(dataDirectory, local_path) })), [{
    kind: "image",
    source_url: "https://cdn.lovart.ai/result.png",
    source_artifact_id: "source-1",
    local_path: path.join("results", "job-1", "artifact-001.png"),
  }]);
  assert.equal((await readFile(result.artifacts[0].local_path)).toString("hex"), "010203");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers, undefined);
});

test("downloadResults rejects non-HTTPS URLs and preserves no partial result", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-artifact-transfer-reject-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const transfer = createArtifactTransfer({ dataDirectory, fetchImpl: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(
    () => transfer.downloadResults({ job_id: "job-2", result: { items: [{ kind: "image", url: "http://evil.example/result.png" }] } }),
    (error) => error.code === "ARTIFACT_URL_NOT_ALLOWED",
  );
});
