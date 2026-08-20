import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeLovartCapabilities } from "../src/probe/capability-normalizer.js";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const flagScript = path.join(repositoryRoot, "scripts/set-lovart-readonly-probe.mjs");
const credentialScript = path.join(repositoryRoot, "scripts/configure-lovart-readonly.swift");
const stateFileName = "lovart-probe-state-v1.json";

function commandEnvironment(dataDirectory) {
  const environment = { ...process.env };
  if (dataDirectory === undefined) delete environment.IMVIA_DATA_DIR;
  else environment.IMVIA_DATA_DIR = dataDirectory;
  return environment;
}

function swiftFunctionBody(source, name) {
  const start = source.indexOf(`func ${name}`);
  assert.notEqual(start, -1, name);
  const openingBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  assert.fail(`${name} has no closing brace`);
}

async function runFlag(argument, dataDirectory, script = flagScript) {
  const arguments_ = Array.isArray(argument) ? argument : [argument];
  return execute(process.execPath, [script, ...arguments_], {
    cwd: repositoryRoot,
    env: commandEnvironment(dataDirectory),
  });
}

async function readState(dataDirectory) {
  return JSON.parse(await readFile(path.join(dataDirectory, stateFileName), "utf8"));
}

test("credential helper uses protected GUI input and fixed Keychain items", async () => {
  const source = await readFile(credentialScript, "utf8");

  assert.match(source, /import AppKit/);
  assert.match(source, /import Security/);
  assert.equal((source.match(/NSSecureTextField/g) ?? []).length, 2);
  assert.match(source, /runModal/);
  assert.match(source, /kSecClassGenericPassword/);
  assert.match(source, /SecItemCopyMatching/);
  assert.match(source, /SecItemAdd/);
  assert.match(source, /SecItemUpdate/);
  assert.match(source, /ai\.imvia\.studio\.lovart-readonly/);
  assert.match(source, /access-key/);
  assert.match(source, /secret-key/);

  const forbidden = [
    "CommandLine.arguments",
    "CommandLine",
    "ProcessInfo.arguments",
    "processInfo.arguments",
    "ProcessInfo.processInfo.environment",
    "ProcessInfo",
    "getenv(",
    "readLine(",
    "standardInput",
    "FileHandle",
    "FileManager",
    "Data(contentsOf:",
    "String(contentsOf:",
    "NSPasteboard",
    "URLSession",
    "NSURLConnection",
    "Process(",
    "NSTask",
    "/bin/sh",
    "/bin/zsh",
    "NSLog",
    "os_log",
    "Logger(",
    "debugPrint(",
    "dump(",
    "fatalError(",
    "fputs(",
    "fprintf(",
  ];
  for (const token of forbidden) assert.equal(source.includes(token), false, token);
  assert.doesNotMatch(source, /func\s+\w+\s*\([^)]*\b(?:service|account)\b/i);
  assert.equal((source.match(/SecItemCopyMatching\(query as CFDictionary, nil\)/g) ?? []).length, 2);
  assert.doesNotMatch(source, /kSecReturn(?:Data|Attributes|Ref|PersistentRef)/);
  assert.deepEqual([...new Set(source.match(/\bSecItem[A-Za-z0-9_]+/g) ?? [])].sort(), [
    "SecItemAdd",
    "SecItemCopyMatching",
    "SecItemUpdate",
  ]);
  assert.doesNotMatch(source, /print\s*\([^"\n]/);
  assert.doesNotMatch(source, /print\s*\("[^"\n]*\\\(/);
});

test("credential helper binds each write function to its exact fixed Keychain mapping", async () => {
  const source = await readFile(credentialScript, "utf8");
  const accessBody = swiftFunctionBody(source, "storeAccessKey");
  const secretBody = swiftFunctionBody(source, "storeSecretKey");

  for (const body of [accessBody, secretBody]) {
    assert.match(body, /kSecClass as String:\s*kSecClassGenericPassword/);
    assert.match(body, /kSecAttrService as String:\s*keychainService/);
  }
  assert.match(accessBody, /kSecAttrAccount as String:\s*accessKeyAccount/);
  assert.doesNotMatch(accessBody, /secretKeyAccount/);
  assert.match(secretBody, /kSecAttrAccount as String:\s*secretKeyAccount/);
  assert.doesNotMatch(secretBody, /accessKeyAccount/);
});

test("credential helper reviewed bytes require a separate security review before fingerprint updates", async () => {
  const reviewedBytes = await readFile(credentialScript);
  const reviewedSha256 = "137fc6674246aa624466b1a9ba1403ffaf6b82f8cca6b1111a5a642a67a010bd";
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  assert.equal(sha256(reviewedBytes), reviewedSha256);
  for (const mutation of [
    "\nputs(\"fixed\")\n",
    "\nfgets(nil, 0, nil)\n",
    "\nsystem(\"true\")\n",
    "\nposix_spawn(nil, nil, nil, nil, nil, nil)\n",
    "\nLogger ().info(\"fixed\")\n",
    "\n// mutate a fixed Keychain query after construction\n",
  ]) {
    assert.notEqual(sha256(Buffer.concat([reviewedBytes, Buffer.from(mutation)])), reviewedSha256, mutation);
  }
});

test("credential helper rejects empty values and clears protected fields and temporary data", async () => {
  const source = await readFile(credentialScript, "utf8");

  assert.match(source, /stringValue\.trimmingCharacters\(in:\s*\.whitespacesAndNewlines\)\.isEmpty/);
  assert.match(source, /accessField\.stringValue\s*=\s*""/);
  assert.match(source, /secretField\.stringValue\s*=\s*""/);
  assert.match(source, /accessData\.resetBytes\(in:/);
  assert.match(source, /secretData\.resetBytes\(in:/);

  const printCalls = [...source.matchAll(/print\s*\(([^\n]*)\)/g)].map((match) => match[1].trim());
  assert.deepEqual(printCalls, [
    '"Lovart read-only credentials saved."',
    '"Lovart read-only credential configuration failed. You may safely rerun this helper."',
  ]);
  assert.ok(printCalls.every((argument) => /^"[^"\\]*"$/.test(argument)), printCalls.join("\n"));
  assert.match(source, /if accessStored\s*\{\s*secretStored\s*=\s*storeSecretKey\(secretData\)\s*\}/);
  assert.match(source, /exit\(EXIT_SUCCESS\)/);
  assert.match(source, /exit\(EXIT_FAILURE\)/);
});

test("flag command creates disabled-by-default state and toggles enabled only", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-flag-"));

  await runFlag("enable", dataDirectory);
  assert.deepEqual(await readState(dataDirectory), {
    version: 1,
    enabled: true,
    authorizations: [],
    attempts: [],
    audit_events: [],
  });

  await runFlag("disable", dataDirectory);
  assert.deepEqual(await readState(dataDirectory), {
    version: 1,
    enabled: false,
    authorizations: [],
    attempts: [],
    audit_events: [],
  });
});

test("flag command preserves rich probe state byte-for-byte except enabled", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-rich-"));
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const summary = normalizeLovartCapabilities({
    unlimited: true,
    available_models: { IMAGE: [], VIDEO: ["generate_video_seedance_v2_5"] },
  }, { checkedAtMs: Date.parse("2026-08-20T00:00:01.000Z") });
  const authorization = (id, issuedAt, consumedAt = null) => ({
    id,
    kind: "lovart_capability_probe",
    source: "user:current_session",
    reason: `prior request ${id}`,
    policy_version: "lovart-readonly-probe-v1",
    issued_at: issuedAt,
    expires_at: new Date(Date.parse(issuedAt) + 120_000).toISOString(),
    consumed_at: consumedAt,
    idempotency_key: `${id}-key`,
  });
  const original = {
    version: 1,
    enabled: false,
    authorizations: [
      authorization("authorization-completed", "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:01.000Z"),
      authorization("authorization-failed", "2026-08-20T00:01:00.000Z", "2026-08-20T00:01:01.000Z"),
      authorization("authorization-pending", "2026-08-20T00:02:00.000Z", "2026-08-20T00:02:01.000Z"),
      authorization("authorization-unused", "2026-08-20T00:03:00.000Z"),
    ],
    attempts: [
      {
        id: "attempt-completed",
        authorization_id: "authorization-completed",
        idempotency_key: "attempt-completed-key",
        status: "completed",
        started_at: "2026-08-20T00:00:01.000Z",
        completed_at: "2026-08-20T00:00:02.000Z",
        result: summary,
        error_code: null,
      },
      {
        id: "attempt-failed",
        authorization_id: "authorization-failed",
        idempotency_key: "attempt-failed-key",
        status: "failed",
        started_at: "2026-08-20T00:01:01.000Z",
        completed_at: "2026-08-20T00:01:02.000Z",
        result: null,
        error_code: "UPSTREAM_UNAVAILABLE",
      },
      {
        id: "attempt-pending",
        authorization_id: "authorization-pending",
        idempotency_key: "attempt-pending-key",
        status: "pending",
        started_at: "2026-08-20T00:02:01.000Z",
        completed_at: null,
        result: null,
        error_code: null,
      },
    ],
    audit_events: [
      { type: "authorization_created", authorization_id: "authorization-completed", at: "2026-08-20T00:00:00.000Z" },
      { type: "probe_claimed", authorization_id: "authorization-completed", attempt_id: "attempt-completed", at: "2026-08-20T00:00:01.000Z" },
      { type: "probe_completed", attempt_id: "attempt-completed", at: "2026-08-20T00:00:02.000Z" },
      { type: "authorization_created", authorization_id: "authorization-failed", at: "2026-08-20T00:01:00.000Z" },
      { type: "probe_claimed", authorization_id: "authorization-failed", attempt_id: "attempt-failed", at: "2026-08-20T00:01:01.000Z" },
      { type: "probe_failed", attempt_id: "attempt-failed", code: "UPSTREAM_UNAVAILABLE", at: "2026-08-20T00:01:02.000Z" },
      { type: "authorization_created", authorization_id: "authorization-pending", at: "2026-08-20T00:02:00.000Z" },
      { type: "probe_claimed", authorization_id: "authorization-pending", attempt_id: "attempt-pending", at: "2026-08-20T00:02:01.000Z" },
      { type: "authorization_created", authorization_id: "authorization-unused", at: "2026-08-20T00:03:00.000Z" },
    ],
  };
  const statePath = path.join(dataDirectory, stateFileName);
  await writeFile(statePath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });

  await runFlag("enable", dataDirectory);
  assert.deepEqual(await readState(dataDirectory), { ...original, enabled: true });

  await runFlag("disable", dataDirectory);
  assert.deepEqual(await readState(dataDirectory), original);
});

test("flag command rejects every argument shape except one exact enable or disable token", async () => {
  await stat(flagScript);
  const invalidArguments = [[], ["enable", "extra"], ["disable", "extra"], ["ENABLE"], ["--enable"], ["true"]];
  for (const arguments_ of invalidArguments) {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-invalid-"));
    await assert.rejects(runFlag(arguments_, dataDirectory));
    await assert.rejects(readFile(path.join(dataDirectory, stateFileName), "utf8"), { code: "ENOENT" });
  }
});

test("IMVIA_DATA_DIR overrides the script-relative default directory", async () => {
  const temporaryRepository = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-default-"));
  const temporaryScripts = path.join(temporaryRepository, "scripts");
  await mkdir(temporaryScripts, { mode: 0o700 });
  const copiedScript = path.join(temporaryScripts, path.basename(flagScript));
  await copyFile(flagScript, copiedScript);
  await symlink(path.join(repositoryRoot, "src"), path.join(temporaryRepository, "src"), "dir");

  const explicitDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-explicit-"));
  await runFlag("enable", explicitDirectory, copiedScript);
  assert.equal((await readState(explicitDirectory)).enabled, true);
  await assert.rejects(
    readFile(path.join(temporaryRepository, ".imvia-studio-dev", stateFileName), "utf8"),
    { code: "ENOENT" },
  );

  await runFlag("disable", undefined, copiedScript);
  assert.equal((await readState(path.join(temporaryRepository, ".imvia-studio-dev"))).enabled, false);
});

test("flag command keeps state permissions private and has no credential or network authority", async () => {
  const source = await readFile(flagScript, "utf8");
  const imports = [...source.matchAll(/^import[^\n]*from\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), [
    "../src/probe/authorization-service.js",
    "../src/probe/probe-store.js",
    "node:path",
    "node:url",
  ].sort());
  assert.doesNotMatch(source, /keychain|transport|child|mcp|https?:|fetch\s*\(|exec|spawn/i);
  assert.match(source, /createProbeAuthorizationService/);
  assert.match(source, /setEnabledForUserCommand/);
  assert.match(source, /probeStore\.update/);
  assert.match(source, /structuredClone\(state\.audit_events\)/);
  assert.match(source, /state\.audit_events\s*=\s*auditEvents/);

  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-mode-"));
  const { stdout, stderr } = await runFlag("enable", dataDirectory);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dataDirectory, stateFileName))).mode & 0o777, 0o600);
});

test("package exposes only the five targeted Task 8 scripts", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["configure:lovart-readonly"], "swift scripts/configure-lovart-readonly.swift");
  assert.equal(packageJson.scripts["enable:lovart-readonly-probe"], "node scripts/set-lovart-readonly-probe.mjs enable");
  assert.equal(packageJson.scripts["disable:lovart-readonly-probe"], "node scripts/set-lovart-readonly-probe.mjs disable");
  assert.equal(packageJson.scripts["test:probe"], "node --test test/json-store.test.mjs test/probe-*.test.mjs test/capability-normalizer.test.mjs test/mcp-probe.test.mjs");
  assert.equal(packageJson.scripts["test:mcp"], "node --test test/mcp-health.test.mjs test/mcp-probe.test.mjs");
});
