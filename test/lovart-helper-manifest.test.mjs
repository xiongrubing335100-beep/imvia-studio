import assert from "node:assert/strict";
import test from "node:test";

import {
  helperTarget,
  resolveCredentialHelper,
} from "../src/lovart/helper-manifest.js";

function fixture({ target = "darwin-arm64", manifestDigest, actualDigest } = {}) {
  const files = new Map([
    ["/plugin/native/manifest.json", JSON.stringify({
      version: 1,
      helpers: {
        [target]: {
          path: `native/${target}/imvia-credential-helper`,
          sha256: manifestDigest ?? "a".repeat(64),
        },
      },
    })],
  ]);
  return {
    pluginRoot: "/plugin",
    platform: target.startsWith("darwin") ? "darwin" : "win32",
    arch: target.endsWith("arm64") ? "arm64" : "x64",
    readFileImpl: async (file) => files.get(file),
    hashFileImpl: async () => actualDigest ?? manifestDigest ?? "a".repeat(64),
  };
}

test("maps only the four packaged targets", () => {
  assert.equal(helperTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(helperTarget("darwin", "x64"), "darwin-x64");
  assert.equal(helperTarget("win32", "arm64"), "win32-arm64");
  assert.equal(helperTarget("win32", "x64"), "win32-x64");
  assert.throws(() => helperTarget("linux", "x64"), (error) => error.code === "PLATFORM_UNSUPPORTED");
});

test("rejects a helper whose digest differs from the manifest", async () => {
  await assert.rejects(
    resolveCredentialHelper(fixture({ manifestDigest: "a".repeat(64), actualDigest: "b".repeat(64) })),
    (error) => error.code === "UPSTREAM_SECURITY_REJECTED",
  );
});

test("rejects a manifest path that escapes the plugin root", async () => {
  const input = fixture();
  input.readFileImpl = async () => JSON.stringify({
    version: 1,
    helpers: {
      "darwin-arm64": { path: "../outside/helper", sha256: "a".repeat(64) },
    },
  });
  await assert.rejects(resolveCredentialHelper(input), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
});

test("returns the confined helper path and digest", async () => {
  const result = await resolveCredentialHelper(fixture());
  assert.deepEqual(result, {
    target: "darwin-arm64",
    path: "/plugin/native/darwin-arm64/imvia-credential-helper",
    sha256: "a".repeat(64),
  });
});
