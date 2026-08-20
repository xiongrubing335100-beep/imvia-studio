#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkoutDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktreesDirectory = path.dirname(checkoutDirectory);
const protectedLayoutAnchor = path.basename(worktreesDirectory) === ".worktrees"
  ? path.dirname(worktreesDirectory)
  : checkoutDirectory;
const protectedBaseCandidates = [
  path.dirname(protectedLayoutAnchor),
  path.join(path.dirname(protectedLayoutAnchor), "lovart插件"),
];

function usage() {
  throw new Error("Usage: node scripts/verify-protected-paths.mjs <snapshot|verify> <manifest-path>");
}

function normalizeRelative(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Protected root must be a non-empty relative path: ${String(value)}`);
  }
  const relative = path.normalize(value);
  if (path.isAbsolute(relative) || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Protected root must stay inside the workspace: ${value}`);
  }
  return relative;
}

function validateManifest(manifest) {
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new Error("Protected-path manifest must be an object");
  }
  if (manifest.version !== 1) throw new Error("Protected-path manifest must use version 1");
  if (!Array.isArray(manifest.roots) || manifest.roots.length === 0) {
    throw new Error("Protected-path manifest roots must be a non-empty array");
  }
  const roots = manifest.roots.map(normalizeRelative);
  if (roots.some((root, index) => root !== manifest.roots[index])) {
    throw new Error("Protected-path manifest roots must use normalized relative paths");
  }
  if (JSON.stringify(roots) !== JSON.stringify([...roots].sort())) {
    throw new Error("Protected-path manifest roots must be sorted");
  }
  if (new Set(roots).size !== roots.length) throw new Error("Protected-path manifest contains a duplicate protected root");
  if (!Array.isArray(manifest.files)) throw new Error("Protected-path manifest files must be an array");

  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || Array.isArray(file) || typeof file !== "object" || typeof file.path !== "string") {
      throw new Error("Protected-path manifest contains an invalid file entry");
    }
    const relativePath = normalizeRelative(file.path);
    if (relativePath !== file.path) throw new Error(`Protected path must be normalized: ${file.path}`);
    if (paths.has(relativePath)) throw new Error(`Protected-path manifest contains a duplicate protected path: ${relativePath}`);
    paths.add(relativePath);
    if (!roots.some((root) => relativePath === root || relativePath.startsWith(`${root}${path.sep}`))) {
      throw new Error(`Protected path is outside the declared roots: ${relativePath}`);
    }
    if (!["file", "symlink"].includes(file.type)
      || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0
      || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Protected-path manifest metadata is invalid: ${relativePath}`);
    }
  }
  return { version: 1, roots, files: manifest.files };
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function candidateContainsRoots(base, roots) {
  const existence = await Promise.all(roots.map(async (root) => {
    try {
      await stat(path.resolve(base, root));
      return true;
    } catch {
      return false;
    }
  }));
  return existence.every(Boolean);
}

async function selectProtectedBase(roots) {
  for (const candidate of protectedBaseCandidates) {
    if (await candidateContainsRoots(candidate, roots)) return candidate;
  }
  throw new Error(`Protected roots (${roots.join(", ")}) were not found under either supported base: ${protectedBaseCandidates.join(", ")}`);
}

async function collectRoot(protectedBase, root) {
  const rootPath = path.resolve(protectedBase, normalizeRelative(root));
  const workspaceRealPath = await realpath(protectedBase);
  const rootRealPath = await realpath(rootPath);
  if (rootRealPath !== workspaceRealPath && !rootRealPath.startsWith(`${workspaceRealPath}${path.sep}`)) {
    throw new Error(`Protected root escapes the workspace: ${root}`);
  }

  const entries = [];
  async function visit(currentPath) {
    const currentStat = await lstat(currentPath);
    if (currentStat.isSymbolicLink()) {
      const target = await readlink(currentPath);
      entries.push({
        path: path.relative(protectedBase, currentPath).split(path.sep).join("/"),
        type: "symlink",
        size_bytes: Buffer.byteLength(target),
        sha256: createHash("sha256").update(target).digest("hex"),
      });
      return;
    }
    if (currentStat.isDirectory()) {
      const children = await readdir(currentPath);
      for (const child of children.sort()) await visit(path.join(currentPath, child));
      return;
    }
    if (!currentStat.isFile()) throw new Error(`Protected path contains a non-regular file: ${path.relative(protectedBase, currentPath)}`);
    const resolved = await realpath(currentPath);
    if (!resolved.startsWith(`${rootRealPath}${path.sep}`) && resolved !== rootRealPath) {
      throw new Error(`Protected file escapes its root: ${path.relative(protectedBase, currentPath)}`);
    }
    const fileStat = await stat(currentPath);
    entries.push({
      path: path.relative(protectedBase, currentPath).split(path.sep).join("/"),
      type: "file",
      size_bytes: fileStat.size,
      sha256: await sha256(currentPath),
    });
  }
  await visit(rootPath);
  return entries;
}

async function snapshot(protectedBase, roots) {
  const files = (await Promise.all(roots.map((root) => collectRoot(protectedBase, root)))).flat().sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, roots: [...roots].sort(), files };
}

function compare(expected, actual) {
  validateManifest(expected);
  validateManifest(actual);
  const expectedSerialized = JSON.stringify(expected);
  const actualSerialized = JSON.stringify(actual);
  if (expectedSerialized === actualSerialized) return [];
  const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  const differences = [];
  for (const file of expected.files) {
    const found = actualByPath.get(file.path);
    if (!found) differences.push(`removed: ${file.path}`);
    else if (found.type !== file.type || found.size_bytes !== file.size_bytes || found.sha256 !== file.sha256) differences.push(`changed: ${file.path}`);
  }
  for (const file of actual.files) if (!expectedByPath.has(file.path)) differences.push(`added: ${file.path}`);
  return differences;
}

async function main() {
  const [mode, manifestArgument] = process.argv.slice(2);
  if (!mode || !manifestArgument || !["snapshot", "verify"].includes(mode)) usage();
  const manifestPath = path.resolve(checkoutDirectory, manifestArgument);
  const existing = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const protectedBase = await selectProtectedBase(existing.roots);
  if (mode === "snapshot") {
    const result = await snapshot(protectedBase, existing.roots);
    await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Protected-path snapshot written (${result.files.length} files).`);
    return;
  }
  const actual = await snapshot(protectedBase, existing.roots);
  const differences = compare(existing, actual);
  if (differences.length) throw new Error(`Protected paths changed:\n${differences.join("\n")}`);
  console.log(`Protected-path verification passed (${actual.files.length} files).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
