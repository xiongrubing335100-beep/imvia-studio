import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import { normalizeLovartCapabilities } from "../src/probe/capability-normalizer.js";
import { runReadOnlyProbe } from "../src/probe/child-core.js";
import { createProbeChildRunner } from "../src/probe/child-runner.js";
import { readProbeCredentials } from "../src/probe/keychain-provider.js";

const CHECKED_AT_MS = Date.parse("2026-08-20T00:00:00.000Z");
const ACCESS_MARKER = "ACCESS_MARKER";
const SECRET_MARKER = "SECRET_MARKER";
const RAW_MARKER = "RAW_RESPONSE_MARKER";

const validSummary = {
  reachable: true,
  authenticated: true,
  service_version: null,
  capability_status: "available",
  workbench_models: [
    { name: "Seedance 2.5", mode: "video", availability: "available" },
    { name: "Seedance 2.0 VIP", mode: "video", availability: "unknown" },
    { name: "Seedance 2.0 Fast", mode: "video", availability: "unavailable" },
    { name: "Minimax H3", mode: "video", availability: "unavailable" },
    { name: "Kling 3.0", mode: "video", availability: "unavailable" },
    { name: "Kling 3.0 Omni", mode: "video", availability: "unavailable" },
    { name: "Seedream 4.0", mode: "image", availability: "unavailable" },
    { name: "Seedream 3.0", mode: "image", availability: "unknown" },
    { name: "Seedream 3.0 Fast", mode: "image", availability: "unknown" },
    { name: "Image 2", mode: "image", availability: "unknown" },
    { name: "Nano Banana Pro", mode: "image", availability: "unavailable" },
    { name: "Nano Banana 2", mode: "image", availability: "unavailable" },
    { name: "Seedream 5.0", mode: "image", availability: "unknown" },
    { name: "Seedream 5.0 Lite", mode: "image", availability: "unavailable" },
    { name: "Midjourney", mode: "image", availability: "unavailable" },
  ],
  checked_at: "2026-08-20T00:00:00.000Z",
  expires_at: "2026-08-20T00:05:00.000Z",
  policy_version: "lovart-readonly-probe-v1",
};

const successEnvelope = JSON.stringify({ ok: true, result: validSummary });

function serializedError(error) {
  return JSON.stringify({
    name: error?.name,
    code: error?.code,
    message: error?.message,
    details: error?.details,
    stack: error?.stack,
    cause: error?.cause,
  });
}

function assertRedactedFailure(error, code = "UPSTREAM_UNREACHABLE") {
  assert.equal(error.code, code);
  const serialized = serializedError(error);
  for (const marker of [ACCESS_MARKER, SECRET_MARKER, RAW_MARKER])
    assert.equal(serialized.includes(marker), false, `error leaked ${marker}`);
  assert.deepEqual(error.details, {});
  return true;
}

function createSecurityFake(outcomes) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const outcome = outcomes[calls.length - 1] ?? outcomes.at(-1);
    if (outcome?.throws) throw outcome.throws;
    queueMicrotask(() => callback(outcome?.error ?? null, outcome?.stdout ?? "", outcome?.stderr ?? ""));
  };
  return { calls, execFile };
}

function createSpawnFake(scenario) {
  const calls = [];
  const children = [];
  const spawnProcess = (file, args, options) => {
    if (scenario?.spawnThrows) throw scenario.spawnThrows;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killCalls = [];
    child.kill = (signal) => {
      child.killCalls.push(signal);
      return true;
    };
    calls.push({ file, args, options });
    children.push(child);
    queueMicrotask(() => scenario(child));
    return child;
  };
  return { calls, children, spawnProcess };
}

function closeChild(child, { stdout = successEnvelope, stderr = "", code = 0, signal = null } = {}) {
  if (stdout !== null) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code, signal);
}

test("Keychain provider performs two sequential fixed shell-free lookups", async () => {
  const fake = createSecurityFake([
    { stdout: `${ACCESS_MARKER}\n` },
    { stdout: `${SECRET_MARKER}\n` },
  ]);

  const credentials = await readProbeCredentials({ execFile: fake.execFile, platform: "darwin" });

  assert.deepEqual(credentials, { accessKey: ACCESS_MARKER, secretKey: SECRET_MARKER });
  assert.deepEqual(fake.calls, [
    {
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", "ai.imvia.studio.lovart-readonly", "-a", "access-key", "-w"],
      options: { encoding: "utf8", maxBuffer: 4096, shell: false },
    },
    {
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", "ai.imvia.studio.lovart-readonly", "-a", "secret-key", "-w"],
      options: { encoding: "utf8", maxBuffer: 4096, shell: false },
    },
  ]);
});

test("non-darwin credential lookup fails before invoking the Keychain command", async () => {
  const fake = createSecurityFake([{ stdout: ACCESS_MARKER }]);

  await assert.rejects(
    readProbeCredentials({ execFile: fake.execFile, platform: "linux" }),
    (error) => assertRedactedFailure(error, "CREDENTIAL_REFERENCE_UNAVAILABLE"),
  );
  assert.equal(fake.calls.length, 0);
});

test("every Keychain failure is replaced by one redacted credential-reference error", async () => {
  const failures = [
    [{ error: Object.assign(new Error(`${ACCESS_MARKER} denied`), { stderr: SECRET_MARKER, code: 44 }) }],
    [{ stdout: `${ACCESS_MARKER}\n` }, { error: new Error(`${SECRET_MARKER} denied`) }],
    [{ throws: new Error(`${ACCESS_MARKER} synchronous failure`) }],
    [{ stdout: "" }],
    [{ stdout: `${ACCESS_MARKER}\n` }, { stdout: "\n" }],
  ];

  for (const outcomes of failures) {
    const fake = createSecurityFake(outcomes);
    await assert.rejects(
      readProbeCredentials({ execFile: fake.execFile, platform: "darwin" }),
      (error) => assertRedactedFailure(error, "CREDENTIAL_REFERENCE_UNAVAILABLE"),
    );
    assert.ok(fake.calls.length <= 2);
  }
});

test("child core keeps fake credentials and raw fields out of its normalized result", async () => {
  let received;
  let transportCalls = 0;
  let nowCalls = 0;
  const result = await runReadOnlyProbe({
    keychainProvider: async () => ({ accessKey: ACCESS_MARKER, secretKey: SECRET_MARKER }),
    transport: async (credentials) => {
      transportCalls += 1;
      received = credentials;
      return {
        unlimited: true,
        available_models: { IMAGE: [], VIDEO: ["generate_video_seedance_v2_5"] },
        raw_identifier: RAW_MARKER,
      };
    },
    normalizer: normalizeLovartCapabilities,
    now: () => {
      nowCalls += 1;
      return CHECKED_AT_MS;
    },
  });

  assert.deepEqual(received, { accessKey: ACCESS_MARKER, secretKey: SECRET_MARKER });
  assert.equal(transportCalls, 1);
  assert.equal(nowCalls, 1);
  assert.deepEqual(result, validSummary);
  const serialized = JSON.stringify(result);
  for (const marker of [ACCESS_MARKER, SECRET_MARKER, RAW_MARKER])
    assert.equal(serialized.includes(marker), false);
});

test("missing or invalid Keychain credentials produce zero transport calls", async () => {
  const providers = [
    async () => { throw Object.assign(new Error(`${ACCESS_MARKER} denied`), { code: "CREDENTIAL_REFERENCE_UNAVAILABLE" }); },
    async () => ({ accessKey: "", secretKey: SECRET_MARKER }),
    async () => ({ accessKey: ACCESS_MARKER }),
  ];

  for (const keychainProvider of providers) {
    let transportCalls = 0;
    await assert.rejects(runReadOnlyProbe({
      keychainProvider,
      transport: async () => { transportCalls += 1; },
      normalizer: normalizeLovartCapabilities,
    }), (error) => assertRedactedFailure(error, "CREDENTIAL_REFERENCE_UNAVAILABLE"));
    assert.equal(transportCalls, 0);
  }
});

test("child core replaces dependency error text while retaining an allowed stable code", async () => {
  await assert.rejects(runReadOnlyProbe({
    keychainProvider: async () => ({ accessKey: ACCESS_MARKER, secretKey: SECRET_MARKER }),
    transport: async () => {
      throw Object.assign(new Error(`${ACCESS_MARKER} ${SECRET_MARKER} ${RAW_MARKER}`), {
        code: "AUTHENTICATION_FAILED",
        cause: new Error(RAW_MARKER),
      });
    },
    normalizer: normalizeLovartCapabilities,
  }), (error) => assertRedactedFailure(error, "AUTHENTICATION_FAILED"));
});

test("runner starts only the absolute fixed child path with a minimal environment", async () => {
  const previous = process.env.ACCESS_MARKER;
  process.env.ACCESS_MARKER = SECRET_MARKER;
  try {
    const fake = createSpawnFake((child) => closeChild(child));
    const runner = createProbeChildRunner({
      nodePath: "/fixed/node",
      childPath: "/fixed/probe-child.js",
      spawnProcess: fake.spawnProcess,
    });

    assert.deepEqual(await runner.run({ accessKey: ACCESS_MARKER, secretKey: SECRET_MARKER }), validSummary);
    assert.deepEqual(fake.calls, [{
      file: "/fixed/node",
      args: ["/fixed/probe-child.js"],
      options: {
        shell: false,
        env: { LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    }]);
    assert.equal(JSON.stringify(fake.calls).includes(ACCESS_MARKER), false);
    assert.equal(JSON.stringify(fake.calls).includes(SECRET_MARKER), false);
  } finally {
    if (previous === undefined) delete process.env.ACCESS_MARKER;
    else process.env.ACCESS_MARKER = previous;
  }
});

test("runner rejects relative executable paths before spawning", () => {
  assert.throws(
    () => createProbeChildRunner({ nodePath: "node", childPath: "/fixed/child.js", spawnProcess() {} }),
    /absolute/,
  );
  assert.throws(
    () => createProbeChildRunner({ nodePath: "/fixed/node", childPath: "child.js", spawnProcess() {} }),
    /absolute/,
  );
});

test("runner reconstructs a valid stable child error without trusting child objects", async () => {
  const fake = createSpawnFake((child) => closeChild(child, {
    stdout: JSON.stringify({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED", message: "Lovart authentication was rejected" },
    }),
  }));
  const runner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/child.js",
    spawnProcess: fake.spawnProcess,
  });

  await assert.rejects(runner.run(), (error) => {
    assertRedactedFailure(error, "AUTHENTICATION_FAILED");
    assert.deepEqual(Object.keys(error).sort(), ["code", "details"]);
    return true;
  });
});

test("runner rejects malformed, multiple, or marker-bearing envelopes without echoing output", async () => {
  const outputs = [
    "not-json " + RAW_MARKER,
    `${successEnvelope}\n${successEnvelope}`,
    JSON.stringify({ ok: true, result: { ...validSummary, identifier: RAW_MARKER } }),
    JSON.stringify({ ok: true, result: { ...validSummary, checked_at: "not-a-date" } }),
    JSON.stringify({ ok: true, result: { ...validSummary, workbench_models: [] } }),
    JSON.stringify({ ok: true, result: validSummary, raw: RAW_MARKER }),
    JSON.stringify({ ok: false, error: { code: "AUTHENTICATION_FAILED", message: SECRET_MARKER } }),
    JSON.stringify({ ok: false, error: { code: "UNKNOWN_CODE", message: RAW_MARKER } }),
    JSON.stringify({ ok: false, error: { code: "UPSTREAM_UNREACHABLE", message: "Lovart upstream is unreachable", cause: RAW_MARKER } }),
    "",
  ];

  for (const stdout of outputs) {
    const fake = createSpawnFake((child) => closeChild(child, { stdout }));
    const runner = createProbeChildRunner({
      nodePath: "/fixed/node",
      childPath: "/fixed/child.js",
      spawnProcess: fake.spawnProcess,
    });
    await assert.rejects(runner.run(), (error) => assertRedactedFailure(error));
  }
});

test("runner accepts stdout at 65,536 bytes and kills immediately at 65,537 bytes", async () => {
  const exactOutput = successEnvelope.padEnd(65_536, " ");
  const exact = createSpawnFake((child) => closeChild(child, { stdout: exactOutput }));
  const exactRunner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/child.js",
    spawnProcess: exact.spawnProcess,
  });
  assert.deepEqual(await exactRunner.run(), validSummary);
  assert.deepEqual(exact.children[0].killCalls, []);

  const overflow = createSpawnFake((child) => {
    child.stdout.write(Buffer.alloc(65_537, 0x78));
  });
  const overflowRunner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/child.js",
    spawnProcess: overflow.spawnProcess,
  });
  await assert.rejects(overflowRunner.run(), (error) => assertRedactedFailure(error));
  assert.deepEqual(overflow.children[0].killCalls, ["SIGKILL"]);
});

test("stdout overflow settles failure before synchronous kill-side close events", async () => {
  const exactOutput = successEnvelope.padEnd(65_536, " ");
  const fake = createSpawnFake((child) => {
    child.kill = (signal) => {
      child.killCalls.push(signal);
      child.emit("close", 0, null);
      return true;
    };
    child.stdout.write(exactOutput);
    child.stdout.write("x");
  });
  const runner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/child.js",
    spawnProcess: fake.spawnProcess,
  });

  await assert.rejects(runner.run(), (error) => assertRedactedFailure(error));
  assert.deepEqual(fake.children[0].killCalls, ["SIGKILL"]);
});

test("runner bounds stderr, never echoes it, and kills on byte 4,097", async () => {
  const bounded = createSpawnFake((child) => closeChild(child, {
    stderr: `${ACCESS_MARKER}${"x".repeat(4_096 - ACCESS_MARKER.length)}`,
  }));
  const boundedRunner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/child.js",
    spawnProcess: bounded.spawnProcess,
  });
  await assert.rejects(boundedRunner.run(), (error) => assertRedactedFailure(error));
  assert.deepEqual(bounded.children[0].killCalls, []);

  const overflow = createSpawnFake((child) => child.stderr.write(Buffer.alloc(4_097, 0x78)));
  const overflowRunner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/child.js",
    spawnProcess: overflow.spawnProcess,
  });
  await assert.rejects(overflowRunner.run(), (error) => assertRedactedFailure(error));
  assert.deepEqual(overflow.children[0].killCalls, ["SIGKILL"]);
});

test("runner maps spawn, stream, exit, and signal races to one redacted failure", async () => {
  const scenarios = [
    { spawnThrows: new Error(`${ACCESS_MARKER} spawn throw`) },
    (child) => child.emit("error", new Error(`${SECRET_MARKER} spawn error`)),
    (child) => child.stdout.emit("error", new Error(`${RAW_MARKER} stdout error`)),
    (child) => child.stderr.emit("error", new Error(`${RAW_MARKER} stderr error`)),
    (child) => closeChild(child, { code: 7 }),
    (child) => closeChild(child, { code: null, signal: "SIGTERM" }),
    (child) => {
      child.emit("error", new Error(`${ACCESS_MARKER} first`));
      closeChild(child, { stdout: `${SECRET_MARKER}${RAW_MARKER}`, code: 7, signal: "SIGTERM" });
      child.emit("close", 0, null);
    },
  ];

  for (const scenario of scenarios) {
    const fake = createSpawnFake(typeof scenario === "function" ? scenario : scenario);
    const runner = createProbeChildRunner({
      nodePath: "/fixed/node",
      childPath: "/fixed/child.js",
      spawnProcess: fake.spawnProcess,
    });
    await assert.rejects(runner.run(), (error) => assertRedactedFailure(error));
  }
});

test("child executable and runner contain no user argument or inherited environment path", async () => {
  const childSource = await readFile(new URL("../src/probe/child.js", import.meta.url), "utf8");
  const runnerSource = await readFile(new URL("../src/probe/child-runner.js", import.meta.url), "utf8");

  for (const source of [childSource, runnerSource]) {
    assert.doesNotMatch(source, /process\.argv/);
    assert.doesNotMatch(source, /process\.env/);
    assert.doesNotMatch(source, /shell\s*:\s*true/);
  }
  assert.doesNotMatch(childSource, /parseArgs|node:util/);
});
