#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkoutDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worktreesDirectory = path.dirname(checkoutDirectory);
const packageDirectory = path.basename(worktreesDirectory) === ".worktrees"
  ? path.dirname(worktreesDirectory)
  : checkoutDirectory;
const protectedBaseCandidates = [
  path.dirname(packageDirectory),
  path.join(path.dirname(packageDirectory), "lovart插件"),
];

function usage() {
  throw new Error("Usage: node scripts/verify-protected-paths.mjs <snapshot|verify> <manifest-path>");
}

function normalizeRelative(value) {
  const relative = path.normalize(value);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Protected root must stay inside the workspace: ${value}`);
  }
  return relative;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function candidateContainsRoots(base, roots) {
  const existence = await Promise.all(roots.map(async (root) => {
    try {
      await stat(path.resolve(base, normalizeRelative(root)));
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
  const expectedSerialized = JSON.stringify(expected);
  const actualSerialized = JSON.stringify(actual);
  if (expectedSerialized === actualSerialized) return [];
  const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  const differences = [];
  for (const file of expected.files) {
    const found = actualByPath.get(file.path);
    if (!found) differences.push(`removed: ${file.path}`);
    else if (found.size_bytes !== file.size_bytes || found.sha256 !== file.sha256) differences.push(`changed: ${file.path}`);
  }
  for (const file of actual.files) if (!expectedByPath.has(file.path)) differences.push(`added: ${file.path}`);
  return differences;
}

async function main() {
  const [mode, manifestArgument] = process.argv.slice(2);
  if (!mode || !manifestArgument || !["snapshot", "verify"].includes(mode)) usage();
  const manifestPath = path.resolve(packageDirectory, manifestArgument);
  const existing = JSON.parse(await readFile(manifestPath, "utf8"));
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
