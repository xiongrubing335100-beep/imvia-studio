#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = Object.freeze({
  "darwin-arm64": "imvia-credential-helper",
  "darwin-x64": "imvia-credential-helper",
  "win32-arm64": "imvia-credential-helper.exe",
  "win32-x64": "imvia-credential-helper.exe",
});

function fail(code, message = code) { const error = new Error(message); error.code = code; throw error; }
async function digest(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }

export async function verifyCredentialHelpers({ pluginRoot }) {
  const root = path.resolve(pluginRoot);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(root, "native/manifest.json"), "utf8")); } catch { fail("HELPER_NOT_PACKAGED"); }
  if (manifest?.version !== 1 || !manifest.helpers || Object.keys(manifest.helpers).sort().join(",") !== Object.keys(TARGETS).sort().join(",")) fail("HELPER_NOT_PACKAGED");
  const seen = new Set();
  for (const [target, filename] of Object.entries(TARGETS)) {
    const entry = manifest.helpers[target];
    if (!entry || typeof entry.path !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail("UPSTREAM_SECURITY_REJECTED");
    const expected = path.join("native", target, filename).replaceAll("\\", "/");
    if (entry.path.replaceAll("\\", "/") !== expected || seen.has(entry.path)) fail("UPSTREAM_SECURITY_REJECTED");
    seen.add(entry.path);
    const candidate = path.resolve(root, entry.path);
    if (!candidate.startsWith(`${root}${path.sep}`)) fail("UPSTREAM_SECURITY_REJECTED");
    let info;
    try { info = await lstat(candidate); } catch { fail("HELPER_NOT_PACKAGED"); }
    if (!info.isFile() || info.isSymbolicLink()) fail("UPSTREAM_SECURITY_REJECTED");
    if (target.startsWith("darwin-") && (info.mode & 0o111) === 0) fail("UPSTREAM_SECURITY_REJECTED");
    if (await digest(candidate) !== entry.sha256) fail("UPSTREAM_SECURITY_REJECTED");
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  verifyCredentialHelpers({ pluginRoot: process.cwd() }).then(() => process.stdout.write("credential helpers verified\n"), (error) => {
    process.stderr.write(`${error.code || "VERIFY_FAILED"}\n`);
    process.exitCode = 1;
  });
}

export { TARGETS };
