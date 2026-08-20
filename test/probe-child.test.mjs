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

function installTimerHarness(t) {
  const timers = [];
  const cleared = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const handle = { callback, delay };
    timers.push(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    cleared.push(handle);
  });
  return {
    cleared,
    fire(handle) {
      handle.callback();
    },
    timers,
  };
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
      options: {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        shell: false,
        timeout: 15_000,
      },
    },
    {
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", "ai.imvia.studio.lovart-readonly", "-a", "secret-key", "-w"],
      options: {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        shell: false,
        timeout: 15_000,
      },
    },
  ]);
});

test("a never-callback Keychain lookup is killed at 15 seconds with a redacted failure", async (t) => {
  const timer = installTimerHarness(t);
  const calls = [];
  const killCalls = [];
  const execFile = (file, args, options) => {
    calls.push({ file, args, options });
    return {
      kill(signal) {
        killCalls.push(signal);
        return true;
      },
    };
  };
  const outcome = readProbeCredentials({ execFile, platform: "darwin" });

  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0].delay, 15_000);
  assert.deepEqual(calls[0].options, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 4096,
    shell: false,
    timeout: 15_000,
  });
  timer.fire(timer.timers[0]);
  await assert.rejects(
    outcome,
    (error) => assertRedactedFailure(error, "CREDENTIAL_REFERENCE_UNAVAILABLE"),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(killCalls, ["SIGKILL"]);
  assert.deepEqual(timer.cleared, [timer.timers[0]]);
});

test("Keychain lookup watchdogs clear once on callback success, failure, and synchronous throw", async (t) => {
  const timer = installTimerHarness(t);
  const success = createSecurityFake([
    { stdout: `${ACCESS_MARKER}\n` },
    { stdout: `${SECRET_MARKER}\n` },
  ]);
  await readProbeCredentials({ execFile: success.execFile, platform: "darwin" });

  const callbackFailure = createSecurityFake([{
    error: new Error(`${ACCESS_MARKER} callback failure`),
    stderr: SECRET_MARKER,
  }]);
  await assert.rejects(
    readProbeCredentials({ execFile: callbackFailure.execFile, platform: "darwin" }),
    (error) => assertRedactedFailure(error, "CREDENTIAL_REFERENCE_UNAVAILABLE"),
  );

  const synchronousFailure = createSecurityFake([{
    throws: new Error(`${RAW_MARKER} synchronous failure`),
  }]);
  await assert.rejects(
    readProbeCredentials({ execFile: synchronousFailure.execFile, platform: "darwin" }),
    (error) => assertRedactedFailure(error, "CREDENTIAL_REFERENCE_UNAVAILABLE"),
  );

  assert.equal(timer.timers.length, 4);
  assert.deepEqual(timer.timers.map(({ delay }) => delay), [15_000, 15_000, 15_000, 15_000]);
  for (const handle of timer.timers)
    assert.equal(timer.cleared.filter((cleared) => cleared === handle).length, 1);
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

test("a never-closing child is killed by the fixed 40-second watchdog", async (t) => {
  const timer = installTimerHarness(t);
  const fake = createSpawnFake(() => {});
  const runner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/probe-child.js",
    spawnProcess: fake.spawnProcess,
  });
  const outcome = runner.run();

  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0].delay, 40_000);
  timer.fire(timer.timers[0]);
  await assert.rejects(outcome, (error) => assertRedactedFailure(error));
  assert.deepEqual(fake.children[0].killCalls, ["SIGKILL"]);
  assert.deepEqual(timer.cleared, [timer.timers[0]]);
});

test("runner clears its one watchdog on every settlement family", async (t) => {
  const timer = installTimerHarness(t);
  const cases = [
    {
      scenario: (child) => closeChild(child),
      verify: async (outcome) => assert.deepEqual(await outcome, validSummary),
    },
    {
      scenario: (child) => closeChild(child, {
        stdout: JSON.stringify({
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "Lovart authentication was rejected" },
        }),
      }),
      verify: async (outcome) => assert.rejects(
        outcome,
        (error) => assertRedactedFailure(error, "AUTHENTICATION_FAILED"),
      ),
    },
    {
      scenario: { spawnThrows: new Error(`${ACCESS_MARKER} spawn throw`) },
      verify: async (outcome) => assert.rejects(outcome, (error) => assertRedactedFailure(error)),
    },
    {
      scenario: (child) => closeChild(child, { code: 7 }),
      verify: async (outcome) => assert.rejects(outcome, (error) => assertRedactedFailure(error)),
    },
    {
      scenario: (child) => child.stdout.emit("error", new Error(RAW_MARKER)),
      verify: async (outcome) => assert.rejects(outcome, (error) => assertRedactedFailure(error)),
    },
  ];

  for (const entry of cases) {
    const timerIndex = timer.timers.length;
    const fake = createSpawnFake(entry.scenario);
    const runner = createProbeChildRunner({
      nodePath: "/fixed/node",
      childPath: "/fixed/child.js",
      spawnProcess: fake.spawnProcess,
    });
    await entry.verify(runner.run());
    assert.equal(timer.timers[timerIndex].delay, 40_000);
    assert.equal(timer.cleared.filter((handle) => handle === timer.timers[timerIndex]).length, 1);
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

test("stream and child errors without close kill once and absorb repeated late errors", async () => {
  for (const source of ["stdout", "stderr", "child"]) {
    const fake = createSpawnFake((child) => {
      const emitter = source === "child" ? child : child[source];
      emitter.emit("error", new Error(`${RAW_MARKER} first ${source} error`));
    });
    const runner = createProbeChildRunner({
      nodePath: "/fixed/node",
      childPath: "/fixed/child.js",
      spawnProcess: fake.spawnProcess,
    });

    await assert.rejects(runner.run(), (error) => assertRedactedFailure(error));
    assert.deepEqual(fake.children[0].killCalls, ["SIGKILL"]);
    assert.doesNotThrow(() => {
      fake.children[0].stdout.emit("error", new Error(`${ACCESS_MARKER} late stdout one`));
      fake.children[0].stdout.emit("error", new Error(`${ACCESS_MARKER} late stdout two`));
      fake.children[0].stderr.emit("error", new Error(`${SECRET_MARKER} late stderr one`));
      fake.children[0].stderr.emit("error", new Error(`${SECRET_MARKER} late stderr two`));
      fake.children[0].emit("error", new Error(`${RAW_MARKER} late child one`));
      fake.children[0].emit("error", new Error(`${RAW_MARKER} late child two`));
    });
    assert.deepEqual(fake.children[0].killCalls, ["SIGKILL"]);
  }
});

test("repeated errors after successful close remain absorbed and cannot change the result", async () => {
  const fake = createSpawnFake((child) => closeChild(child));
  const runner = createProbeChildRunner({
    nodePath: "/fixed/node",
    childPath: "/fixed/child.js",
    spawnProcess: fake.spawnProcess,
  });
  const result = await runner.run();

  assert.deepEqual(result, validSummary);
  assert.doesNotThrow(() => {
    for (let index = 0; index < 2; index += 1) {
      fake.children[0].stdout.emit("error", new Error(`${ACCESS_MARKER} late stdout`));
      fake.children[0].stderr.emit("error", new Error(`${SECRET_MARKER} late stderr`));
      fake.children[0].emit("error", new Error(`${RAW_MARKER} late child`));
    }
  });
  assert.deepEqual(fake.children[0].killCalls, []);
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
