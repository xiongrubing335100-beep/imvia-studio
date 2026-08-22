import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
const DIGEST = /^[0-9a-f]{64}$/;

const MESSAGES = Object.freeze({
  PLATFORM_UNSUPPORTED: "Lovart connection is unavailable on this platform.",
  HELPER_NOT_PACKAGED: "Lovart connection helper is not packaged correctly.",
  UPSTREAM_SECURITY_REJECTED: "Lovart connection helper failed integrity verification.",
});

function stableFailure(code) {
  const error = new Error(MESSAGES[code] ?? MESSAGES.UPSTREAM_SECURITY_REJECTED);
  error.code = code;
  return error;
}

export function helperTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.has(target)) throw stableFailure("PLATFORM_UNSUPPORTED");
  return target;
}

async function defaultHashFile(file) {
  const digest = createHash("sha256");
  digest.update(await readFile(file));
  return digest.digest("hex");
}

function expectedRelativePath(target) {
  const filename = target.startsWith("win32-")
    ? "imvia-credential-helper.exe"
    : "imvia-credential-helper";
  return path.join("native", target, filename);
}

export async function resolveCredentialHelper({
  pluginRoot,
  platform = process.platform,
  arch = process.arch,
  readFileImpl = readFile,
  hashFileImpl = defaultHashFile,
} = {}) {
  const target = helperTarget(platform, arch);
  if (typeof pluginRoot !== "string" || !pluginRoot) throw stableFailure("HELPER_NOT_PACKAGED");

  const root = path.resolve(pluginRoot);
  let manifest;
  try {
    manifest = JSON.parse(await readFileImpl(path.join(root, "native/manifest.json"), "utf8"));
  } catch {
    throw stableFailure("HELPER_NOT_PACKAGED");
  }
  const entry = manifest?.version === 1 && manifest.helpers?.[target];
  if (!entry || typeof entry.path !== "string" || !DIGEST.test(entry.sha256 ?? "")) {
    throw stableFailure("HELPER_NOT_PACKAGED");
  }

  const expected = expectedRelativePath(target);
  const relative = entry.path.replaceAll("\\", "/");
  if (relative !== expected.replaceAll("\\", "/")) throw stableFailure("UPSTREAM_SECURITY_REJECTED");

  const candidate = path.resolve(root, entry.path);
  const prefix = `${root}${path.sep}`;
  if (!candidate.startsWith(prefix)) throw stableFailure("UPSTREAM_SECURITY_REJECTED");

  let actualDigest;
  try {
    actualDigest = await hashFileImpl(candidate);
  } catch {
    throw stableFailure("HELPER_NOT_PACKAGED");
  }
  if (String(actualDigest).toLowerCase() !== entry.sha256.toLowerCase()) {
    throw stableFailure("UPSTREAM_SECURITY_REJECTED");
  }
  return Object.freeze({ target, path: candidate, sha256: entry.sha256.toLowerCase() });
}

export { TARGETS };
