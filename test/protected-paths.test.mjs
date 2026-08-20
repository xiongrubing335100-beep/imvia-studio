import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(pluginRoot, "..");
const verifier = path.join(pluginRoot, "scripts/verify-protected-paths.mjs");
const protectedRoots = ["lovart-codex-plugin", "lovart-local-marketplace", "lovart-output"];
const hasProtectedWorkspace = protectedRoots.every((root) => existsSync(path.join(workspaceRoot, root)));

test("protected-path verifier accepts an unchanged manifest and rejects a mutation", async (context) => {
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-paths-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const protectedRoot = path.join(sandbox, "protected");
  const manifestPath = path.join(sandbox, "manifest.json");
  await mkdir(protectedRoot);
  await writeFile(path.join(protectedRoot, "asset.txt"), "baseline\n");
  await writeFile(manifestPath, JSON.stringify({ version: 1, roots: [path.relative(workspaceRoot, protectedRoot)], files: [] }));

  const snapshot = spawnSync(process.execPath, [verifier, "snapshot", manifestPath], { cwd: pluginRoot, encoding: "utf8" });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const clean = spawnSync(process.execPath, [verifier, "verify", manifestPath], { cwd: pluginRoot, encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);

  await writeFile(path.join(protectedRoot, "asset.txt"), "mutated\n");
  const changed = spawnSync(process.execPath, [verifier, "verify", manifestPath], { cwd: pluginRoot, encoding: "utf8" });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /changed: .*asset\.txt/);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.files.length, 1);
});

test("current Lovart protected paths still match the recorded baseline", { skip: !hasProtectedWorkspace }, () => {
  const manifestPath = path.join(pluginRoot, "test/protected-paths.manifest.json");
  const verification = spawnSync(
    process.execPath,
    [verifier, "verify", manifestPath],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(verification.status, 0, verification.stderr);
  assert.match(verification.stdout, /Protected-path verification passed/);
});
