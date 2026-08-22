#!/usr/bin/env node
import { copyFile, chmod, mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const TARGETS = Object.freeze({
  "darwin-arm64": "imvia-credential-helper",
  "darwin-x64": "imvia-credential-helper",
  "win32-arm64": "imvia-credential-helper.exe",
  "win32-x64": "imvia-credential-helper.exe",
});

function fail(code, message) { const error = new Error(message || code); error.code = code; throw error; }

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--") || !argv[i + 1]) fail("ASSEMBLY_INVALID", `Missing value for ${key}`);
    result[key.slice(2)] = argv[++i];
  }
  return result;
}

async function digest(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }

export async function assembleCredentialHelpers({ output, artifacts }) {
  if (!output || !artifacts || Object.keys(artifacts).sort().join(",") !== Object.keys(TARGETS).sort().join(",")) fail("ASSEMBLY_INVALID");
  const root = path.resolve(output);
  const helpers = {};
  for (const [target, filename] of Object.entries(TARGETS)) {
    const artifactRoot = path.resolve(artifacts[target]);
    const source = path.join(artifactRoot, filename);
    let info;
    try { info = await lstat(source); } catch { fail("HELPER_NOT_PACKAGED"); }
    if (!info.isFile() || info.isSymbolicLink()) fail("UPSTREAM_SECURITY_REJECTED");
    if (target.startsWith("darwin-") && (info.mode & 0o111) === 0) fail("UPSTREAM_SECURITY_REJECTED");
    const signatureFile = path.join(artifactRoot, "signature.json");
    try {
      const signature = JSON.parse(await readFile(signatureFile, "utf8"));
      if (signature.signed !== true || signature.target !== target) fail("UPSTREAM_SECURITY_REJECTED");
    } catch (error) {
      if (error.code) throw error;
      fail("UPSTREAM_SECURITY_REJECTED");
    }
    const destination = path.join(root, "native", target, filename);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(source, destination);
    if (target.startsWith("darwin-")) await chmod(destination, 0o755);
    helpers[target] = { path: path.relative(root, destination), sha256: await digest(destination) };
  }
  const manifest = { version: 1, helpers };
  await writeFile(path.join(root, "native", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const input = args(process.argv.slice(2));
  const output = input.output || process.cwd();
  const artifacts = Object.fromEntries(Object.keys(TARGETS).map((target) => {
    if (!input[target]) fail("ASSEMBLY_INVALID", `Missing --${target}`);
    return [target, input[target]];
  }));
  assembleCredentialHelpers({ output, artifacts }).then(() => process.stdout.write("credential helpers assembled\n"), (error) => {
    process.stderr.write(`${error.code || "ASSEMBLY_FAILED"}\n`);
    process.exitCode = 1;
  });
}

export { TARGETS };
