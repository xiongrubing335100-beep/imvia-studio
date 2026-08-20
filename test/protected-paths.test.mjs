import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktreesDirectory = path.dirname(pluginRoot);
const packageDirectory = path.basename(worktreesDirectory) === ".worktrees"
  ? path.dirname(worktreesDirectory)
  : pluginRoot;
const verifier = path.join(pluginRoot, "scripts/verify-protected-paths.mjs");
const protectedRoots = ["lovart-codex-plugin", "lovart-local-marketplace", "lovart-output"];
const protectedBaseCandidates = [
  path.dirname(packageDirectory),
  path.join(path.dirname(packageDirectory), "lovart插件"),
];
const hasProtectedWorkspace = protectedBaseCandidates.some(
  (base) => protectedRoots.every((root) => existsSync(path.join(base, root))),
);

test("protected-path verifier accepts an unchanged manifest and rejects a mutation", async (context) => {
  const protectedBase = protectedBaseCandidates[0];
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-paths-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const protectedRoot = path.join(sandbox, "protected");
  const manifestPath = path.join(sandbox, "manifest.json");
  await mkdir(protectedRoot);
  await writeFile(path.join(protectedRoot, "asset.txt"), "baseline\n");
  await writeFile(manifestPath, JSON.stringify({ version: 1, roots: [path.relative(protectedBase, protectedRoot)], files: [] }));

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

test("relative manifests and protected roots resolve in both supported repository layouts", async (context) => {
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-layout-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));

  for (const layout of ["sibling", "lovart-child"]) {
    const layoutRoot = path.join(sandbox, layout);
    const checkout = path.join(layoutRoot, "imvia-studio");
    const protectedBase = layout === "sibling"
      ? layoutRoot
      : path.join(layoutRoot, "lovart插件");
    const root = "fixture-protected-root";
    const contents = `${layout}\n`;
    await mkdir(path.join(checkout, "scripts"), { recursive: true });
    await mkdir(path.join(checkout, "test"), { recursive: true });
    await mkdir(path.join(protectedBase, root), { recursive: true });
    await copyFile(verifier, path.join(checkout, "scripts/verify-protected-paths.mjs"));
    await writeFile(path.join(protectedBase, root, "asset.txt"), contents);
    await writeFile(path.join(checkout, "test/manifest.json"), JSON.stringify({
      version: 1,
      roots: [root],
      files: [{
        path: `${root}/asset.txt`,
        type: "file",
        size_bytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));

    const verification = spawnSync(
      process.execPath,
      [path.join(checkout, "scripts/verify-protected-paths.mjs"), "verify", "test/manifest.json"],
      { cwd: layoutRoot, encoding: "utf8" },
    );
    assert.equal(verification.status, 0, `${layout}: ${verification.stderr}`);
    assert.match(verification.stdout, /Protected-path verification passed \(1 files\)/);
  }
});

test("verifier rejects a manifest when neither exact protected base contains every root", async (context) => {
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-missing-layout-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const checkout = path.join(sandbox, "imvia-studio");
  await mkdir(path.join(checkout, "scripts"), { recursive: true });
  await mkdir(path.join(checkout, "test"), { recursive: true });
  await copyFile(verifier, path.join(checkout, "scripts/verify-protected-paths.mjs"));
  await writeFile(path.join(checkout, "test/manifest.json"), JSON.stringify({
    version: 1,
    roots: ["fixture-protected-root"],
    files: [],
  }));

  const verification = spawnSync(
    process.execPath,
    [path.join(checkout, "scripts/verify-protected-paths.mjs"), "verify", "test/manifest.json"],
    { cwd: sandbox, encoding: "utf8" },
  );
  assert.notEqual(verification.status, 0);
  assert.match(verification.stderr, /fixture-protected-root/);
  assert.equal(verification.stderr.includes(sandbox), true);
  assert.equal(verification.stderr.includes(path.join(sandbox, "lovart插件")), true);
});

test("package verification command uses the repository-relative manifest", async () => {
  const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["verify:protected-paths"],
    "node scripts/verify-protected-paths.mjs verify test/protected-paths.manifest.json",
  );
});

test("current Lovart protected paths still match the recorded baseline", { skip: !hasProtectedWorkspace }, () => {
  const manifestPath = path.join(pluginRoot, "test/protected-paths.manifest.json");
  const verification = spawnSync(
    process.execPath,
    [verifier, "verify", manifestPath],
    { cwd: packageDirectory, encoding: "utf8" },
  );
  assert.equal(verification.status, 0, verification.stderr);
  assert.match(verification.stdout, /Protected-path verification passed/);
});
