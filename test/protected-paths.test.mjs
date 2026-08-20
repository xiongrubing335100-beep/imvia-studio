import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
const liveManifestPath = path.join(pluginRoot, "test/protected-paths.manifest.json");

function protectedBaseCandidatesFor(packageRoot) {
  return [
    path.dirname(packageRoot),
    path.join(path.dirname(packageRoot), "lovart插件"),
  ];
}

function validatedManifestRoots(manifest) {
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object" || manifest.version !== 1) {
    throw new Error("Protected-path manifest must be an object using version 1");
  }
  if (!Array.isArray(manifest.roots) || manifest.roots.length === 0) {
    throw new Error("Protected-path manifest roots must be a non-empty array");
  }
  if (manifest.roots.some((root) => typeof root !== "string" || root.length === 0)) {
    throw new Error("Protected-path manifest roots must be non-empty strings");
  }
  const roots = manifest.roots.map((root) => path.normalize(root));
  if (roots.some((root, index) => path.isAbsolute(root)
    || root === "." || root === ".." || root.startsWith(`..${path.sep}`)
    || root !== manifest.roots[index])) {
    throw new Error("Protected-path manifest roots must use normalized relative paths");
  }
  if (JSON.stringify(roots) !== JSON.stringify([...roots].sort())) {
    throw new Error("Protected-path manifest roots must be sorted");
  }
  if (new Set(roots).size !== roots.length) {
    throw new Error("Protected-path manifest contains a duplicate protected root");
  }
  return roots;
}

function hasProtectedWorkspaceForManifest({ packageDirectory: packageRoot, manifestPath }) {
  const roots = validatedManifestRoots(JSON.parse(readFileSync(manifestPath, "utf8")));
  return protectedBaseCandidatesFor(packageRoot).some(
    (base) => roots.every((root) => existsSync(path.join(base, root))),
  );
}

const protectedBaseCandidates = protectedBaseCandidatesFor(packageDirectory);
const hasProtectedWorkspace = hasProtectedWorkspaceForManifest({ packageDirectory, manifestPath: liveManifestPath });

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

  const typeFlippedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  typeFlippedManifest.files[0].type = "symlink";
  await writeFile(manifestPath, JSON.stringify(typeFlippedManifest));
  const typeFlipped = spawnSync(process.execPath, [verifier, "verify", manifestPath], { cwd: pluginRoot, encoding: "utf8" });
  assert.notEqual(typeFlipped.status, 0);
  assert.match(typeFlipped.stderr, /changed: .*asset\.txt/);

  typeFlippedManifest.files[0].type = "file";
  await writeFile(manifestPath, JSON.stringify(typeFlippedManifest));

  await writeFile(path.join(protectedRoot, "asset.txt"), "mutated\n");
  const changed = spawnSync(process.execPath, [verifier, "verify", manifestPath], { cwd: pluginRoot, encoding: "utf8" });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /changed: .*asset\.txt/);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.files.length, 1);
});

test("manifest roots drive live-workspace detection without a hard-coded root list", async (context) => {
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-detection-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const candidateBase = path.dirname(sandbox);
  const manifestPath = path.join(sandbox, "manifest.json");
  const presentRoot = path.relative(candidateBase, path.join(sandbox, "present-root"));
  await mkdir(path.join(candidateBase, presentRoot), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ version: 1, roots: [presentRoot], files: [] }));

  assert.equal(hasProtectedWorkspaceForManifest({ packageDirectory: sandbox, manifestPath }), true);
  await writeFile(manifestPath, JSON.stringify({ version: 1, roots: ["missing-root"], files: [] }));
  assert.equal(hasProtectedWorkspaceForManifest({ packageDirectory: sandbox, manifestPath }), false);
});

test("live-workspace detection fails loudly for a missing or invalid manifest", async (context) => {
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-detection-invalid-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const manifestPath = path.join(sandbox, "manifest.json");

  assert.throws(
    () => hasProtectedWorkspaceForManifest({ packageDirectory: sandbox, manifestPath }),
    /ENOENT/,
  );
  const invalidManifests = [
    ["not JSON", /JSON/],
    [JSON.stringify({ version: 2, roots: ["root"] }), /version 1/],
    [JSON.stringify({ version: 1 }), /non-empty array/],
    [JSON.stringify({ version: 1, roots: [] }), /non-empty array/],
    [JSON.stringify({ version: 1, roots: [1] }), /non-empty strings/],
    [JSON.stringify({ version: 1, roots: ["/absolute"] }), /normalized relative paths/],
    [JSON.stringify({ version: 1, roots: ["../escape"] }), /normalized relative paths/],
    [JSON.stringify({ version: 1, roots: ["a/../root"] }), /normalized relative paths/],
    [JSON.stringify({ version: 1, roots: ["root", "root"] }), /duplicate/],
  ];
  for (const [contents, expectedError] of invalidManifests) {
    await writeFile(manifestPath, contents);
    assert.throws(
      () => hasProtectedWorkspaceForManifest({ packageDirectory: sandbox, manifestPath }),
      expectedError,
      contents,
    );
  }
});

test("verifier rejects invalid manifest metadata and duplicate paths", async (context) => {
  const protectedBase = protectedBaseCandidates[0];
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-metadata-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const roots = ["a", "b"].map((name) => path.relative(protectedBase, path.join(sandbox, name))).sort();
  for (const root of roots) await mkdir(path.join(protectedBase, root), { recursive: true });
  await writeFile(path.join(protectedBase, roots[0], "asset.txt"), "same\n");
  const manifestPath = path.join(sandbox, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ version: 1, roots, files: [] }));
  const snapshot = spawnSync(process.execPath, [verifier, "snapshot", manifestPath], { encoding: "utf8" });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const baseline = JSON.parse(await readFile(manifestPath, "utf8"));
  const mutations = [
    [{ ...baseline, version: 2 }, /version 1/],
    [{ ...baseline, roots: [...baseline.roots].reverse() }, /sorted/],
    [{ ...baseline, roots: [...baseline.roots, baseline.roots[0]].sort() }, /duplicate protected root/],
    [{ ...baseline, files: [...baseline.files, baseline.files[0]] }, /duplicate protected path/],
    [{ ...baseline, files: [{ ...baseline.files[0], path: "outside.txt" }] }, /outside the declared roots/],
  ];
  for (const [manifest, expectedError] of mutations) {
    await writeFile(manifestPath, JSON.stringify(manifest));
    const verification = spawnSync(process.execPath, [verifier, "verify", manifestPath], { encoding: "utf8" });
    assert.notEqual(verification.status, 0, JSON.stringify(manifest));
    assert.match(verification.stderr, expectedError);
  }
});

test("escaping manifest roots retain their explicit validation error", async (context) => {
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-escape-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const checkout = path.join(sandbox, "imvia-studio");
  await mkdir(path.join(checkout, "scripts"), { recursive: true });
  await mkdir(path.join(checkout, "test"), { recursive: true });
  await copyFile(verifier, path.join(checkout, "scripts/verify-protected-paths.mjs"));
  await writeFile(path.join(checkout, "test/manifest.json"), JSON.stringify({
    version: 1,
    roots: ["../escape"],
    files: [],
  }));
  const verification = spawnSync(
    process.execPath,
    [path.join(checkout, "scripts/verify-protected-paths.mjs"), "verify", "test/manifest.json"],
    { encoding: "utf8" },
  );
  assert.notEqual(verification.status, 0);
  assert.match(verification.stderr, /Protected root must stay inside the workspace: \.\.\/escape/);
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

test("a linked checkout owns its relative manifest while the main checkout anchors both protected layouts", async (context) => {
  const sandbox = await mkdtemp(path.join(pluginRoot, ".protected-worktree-layout-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));

  for (const layout of ["sibling", "lovart-child"]) {
    const layoutRoot = path.join(sandbox, layout);
    const mainCheckout = path.join(layoutRoot, "imvia-studio");
    const linkedCheckout = path.join(mainCheckout, ".worktrees", "review-branch");
    const protectedBase = layout === "sibling" ? layoutRoot : path.join(layoutRoot, "lovart插件");
    const root = "fixture-protected-root";
    const contents = `${layout}-linked\n`;
    await mkdir(path.join(linkedCheckout, "scripts"), { recursive: true });
    await mkdir(path.join(linkedCheckout, "test"), { recursive: true });
    await mkdir(path.join(protectedBase, root), { recursive: true });
    await copyFile(verifier, path.join(linkedCheckout, "scripts/verify-protected-paths.mjs"));
    await writeFile(path.join(protectedBase, root, "asset.txt"), contents);
    await writeFile(path.join(linkedCheckout, "test/manifest.json"), JSON.stringify({
      version: 1,
      roots: [root],
      files: [{
        path: `${root}/asset.txt`,
        type: "file",
        size_bytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
      }],
    }));
    if (layout === "lovart-child") {
      await mkdir(path.join(mainCheckout, "test"), { recursive: true });
      await writeFile(path.join(mainCheckout, "test/manifest.json"), "not the linked manifest\n");
    }

    const verification = spawnSync(
      process.execPath,
      [path.join(linkedCheckout, "scripts/verify-protected-paths.mjs"), "verify", "test/manifest.json"],
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
  const verification = spawnSync(
    process.execPath,
    [verifier, "verify", liveManifestPath],
    { cwd: packageDirectory, encoding: "utf8" },
  );
  assert.equal(verification.status, 0, verification.stderr);
  assert.match(verification.stdout, /Protected-path verification passed/);
});
