import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assembleCredentialHelpers } from "../scripts/assemble-credential-helpers.mjs";
import { verifyCredentialHelpers } from "../scripts/verify-credential-helpers.mjs";

const targets = {
  "darwin-arm64": "imvia-credential-helper",
  "darwin-x64": "imvia-credential-helper",
  "win32-arm64": "imvia-credential-helper.exe",
  "win32-x64": "imvia-credential-helper.exe",
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "imvia-helper-"));
  const output = path.join(root, "plugin");
  const artifacts = {};
  for (const [target, filename] of Object.entries(targets)) {
    const directory = path.join(root, "artifacts", target);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, filename), `helper-${target}`);
    if (target.startsWith("darwin-")) await chmod(path.join(directory, filename), 0o755);
    await writeFile(path.join(directory, "signature.json"), JSON.stringify({ signed: true, target }));
    artifacts[target] = directory;
  }
  return { root, output, artifacts };
}

test("assembly emits exactly four confined helper entries", async () => {
  const input = await fixture();
  const manifest = await assembleCredentialHelpers(input);
  assert.deepEqual(Object.keys(manifest.helpers).sort(), Object.keys(targets).sort());
  for (const entry of Object.values(manifest.helpers)) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await verifyCredentialHelpers({ pluginRoot: input.output }), manifest);
});

test("verification rejects a digest mismatch", async () => {
  const input = await fixture();
  await assembleCredentialHelpers(input);
  const manifestPath = path.join(input.output, "native/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.helpers["darwin-arm64"].sha256 = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyCredentialHelpers({ pluginRoot: input.output }), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
});

test("assembly rejects unsigned artifacts", async () => {
  const input = await fixture();
  await writeFile(path.join(input.artifacts["win32-x64"], "signature.json"), JSON.stringify({ signed: false, target: "win32-x64" }));
  await assert.rejects(assembleCredentialHelpers(input), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
});
