import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { JsonStore } from "../src/persistence/json-store.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const jsonStoreUrl = pathToFileURL(path.join(repositoryRoot, "src/persistence/json-store.js")).href;
const flagScript = path.join(repositoryRoot, "scripts/set-lovart-readonly-probe.mjs");
const probeStateFile = "lovart-probe-state-v1.json";

function observeChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error, stdout, stderr }));
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForPath(filePath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

function spawnBlockedProbeUpdate(dataDirectory, mutation) {
  const readyPath = path.join(dataDirectory, `ready-${Date.now()}-${Math.random()}`);
  const releasePath = path.join(dataDirectory, `release-${Date.now()}-${Math.random()}`);
  const program = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { JsonStore } from ${JSON.stringify(jsonStoreUrl)};
    const store = new JsonStore({
      dataDirectory: process.env.TEST_DATA_DIRECTORY,
      stateFileName: ${JSON.stringify(probeStateFile)},
      createInitialState: () => ({ version: 1, enabled: true, authorizations: [], attempts: [], audit_events: [] }),
    });
    const mutation = JSON.parse(process.env.TEST_MUTATION);
    await store.update(async (state) => {
      if (mutation.server_revision !== undefined) state.server_revision = mutation.server_revision;
      if (mutation.attempt) state.attempts.push(mutation.attempt);
      if (mutation.audit) state.audit_events.push(mutation.audit);
      await writeFile(process.env.TEST_READY_PATH, "ready", { mode: 0o600 });
      while (true) {
        try {
          await access(process.env.TEST_RELEASE_PATH);
          break;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await delay(10);
        }
      }
      return null;
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TEST_DATA_DIRECTORY: dataDirectory,
      TEST_MUTATION: JSON.stringify(mutation),
      TEST_READY_PATH: readyPath,
      TEST_RELEASE_PATH: releasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, done: observeChild(child), readyPath, releasePath };
}

function spawnFlag(dataDirectory, token) {
  const child = spawn(process.execPath, [flagScript, token], {
    cwd: repositoryRoot,
    env: { ...process.env, IMVIA_DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, done: observeChild(child) };
}

async function seedProbeState(dataDirectory, state) {
  await writeFile(path.join(dataDirectory, probeStateFile), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function releaseBlockedUpdate(worker) {
  await writeFile(worker.releasePath, "release", { mode: 0o600 });
}

test("JsonStore preserves state.json as the default", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-"));
  const store = new JsonStore({ dataDirectory: dir, createInitialState: () => ({ version: 1 }) });
  await store.read();
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1 });
});

test("JsonStore supports an isolated state filename with private permissions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-"));
  const store = new JsonStore({
    dataDirectory: dir,
    stateFileName: "lovart-probe-state-v1.json",
    createInitialState: () => ({ version: 1, enabled: false }),
  });
  await store.read();
  const statePath = path.join(dir, "lovart-probe-state-v1.json");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { version: 1, enabled: false });
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("a concurrent server-like writer cannot restore enabled after the CLI disables it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-race-"));
  await seedProbeState(dir, {
    version: 1,
    enabled: true,
    authorizations: [],
    attempts: [],
    audit_events: [{ type: "existing" }],
  });
  const worker = spawnBlockedProbeUpdate(dir, { server_revision: 2 });
  await waitForPath(worker.readyPath);
  const cli = spawnFlag(dir, "disable");
  const observed = await Promise.race([cli.done.then(() => "exited"), delay(120, "waiting")]);
  await releaseBlockedUpdate(worker);
  const [workerResult, cliResult] = await Promise.all([worker.done, cli.done]);

  assert.equal(observed, "waiting");
  assert.equal(workerResult.code, 0, workerResult.stderr);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, probeStateFile), "utf8")), {
    version: 1,
    enabled: false,
    authorizations: [],
    attempts: [],
    audit_events: [{ type: "existing" }],
    server_revision: 2,
  });
});

test("a concurrent attempt and audit write are both retained when the CLI toggles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-attempt-"));
  const initial = {
    version: 1,
    enabled: true,
    authorizations: [{ id: "authorization-1" }],
    attempts: [],
    audit_events: [{ type: "authorization_created" }],
  };
  await seedProbeState(dir, initial);
  const attempt = { id: "attempt-1", status: "pending" };
  const audit = { type: "probe_claimed", attempt_id: "attempt-1" };
  const worker = spawnBlockedProbeUpdate(dir, { attempt, audit });
  await waitForPath(worker.readyPath);
  const cli = spawnFlag(dir, "disable");
  await delay(80);
  await releaseBlockedUpdate(worker);
  const [workerResult, cliResult] = await Promise.all([worker.done, cli.done]);

  assert.equal(workerResult.code, 0, workerResult.stderr);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, probeStateFile), "utf8")), {
    ...initial,
    enabled: false,
    attempts: [attempt],
    audit_events: [...initial.audit_events, audit],
  });
});

test("an active owner is waited on, times out boundedly, and keeps its lock intact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-active-lock-"));
  await seedProbeState(dir, { version: 1, enabled: true, authorizations: [], attempts: [], audit_events: [] });
  const worker = spawnBlockedProbeUpdate(dir, { server_revision: 3 });
  await waitForPath(worker.readyPath);
  const lockPath = path.join(dir, `${probeStateFile}.lock`);
  try {
    const lockBefore = await readFile(lockPath, "utf8");
    const contender = new JsonStore({
      dataDirectory: dir,
      stateFileName: probeStateFile,
      createInitialState: () => ({}),
      lockTimeoutMs: 80,
      lockPollMs: 10,
    });
    await assert.rejects(contender.update((state) => { state.enabled = false; return null; }), /state lock acquisition timed out/);
    assert.equal(await readFile(lockPath, "utf8"), lockBefore);
  } finally {
    await releaseBlockedUpdate(worker);
    const result = await worker.done;
    assert.equal(result.code, 0, result.stderr);
  }
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("a process crash leaves a recoverable lock without losing the next update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-crash-lock-"));
  await seedProbeState(dir, { version: 1, count: 0 });
  const worker = spawnBlockedProbeUpdate(dir, { server_revision: 4 });
  await waitForPath(worker.readyPath);
  const lockPath = path.join(dir, `${probeStateFile}.lock`);
  let lockMode;
  let crashed;
  try {
    lockMode = (await stat(lockPath)).mode & 0o777;
  } finally {
    worker.child.kill("SIGKILL");
    crashed = await worker.done;
  }
  assert.equal(lockMode, 0o600);
  assert.equal(crashed.signal, "SIGKILL");

  const store = new JsonStore({
    dataDirectory: dir,
    stateFileName: probeStateFile,
    createInitialState: () => ({ version: 1, count: 0 }),
  });
  await store.update((state) => { state.count += 1; return null; });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, probeStateFile), "utf8")), { version: 1, count: 1 });
  assert.equal((await readdir(dir)).some((entry) => entry.includes(`${probeStateFile}.lock`)), false);
});

test("an incomplete lock is preserved during its grace period and recovered after it is stale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-stale-lock-"));
  const statePath = path.join(dir, "state.json");
  const lockPath = `${statePath}.lock`;
  await writeFile(statePath, '{"version":1,"count":0}\n', { mode: 0o600 });
  await writeFile(lockPath, "incomplete-owner-record", { mode: 0o600 });
  const impatientStore = new JsonStore({
    dataDirectory: dir,
    createInitialState: () => ({ version: 1, count: 0 }),
    lockTimeoutMs: 50,
    lockPollMs: 10,
    invalidLockStaleMs: 250,
  });

  await assert.rejects(
    impatientStore.update((state) => { state.count += 1; return null; }),
    /state lock acquisition timed out/,
  );
  assert.equal(await readFile(lockPath, "utf8"), "incomplete-owner-record");

  await delay(250);
  const recoveryStore = new JsonStore({
    dataDirectory: dir,
    createInitialState: () => ({ version: 1, count: 0 }),
    lockTimeoutMs: 500,
    lockPollMs: 10,
    invalidLockStaleMs: 250,
  });
  await recoveryStore.update((state) => { state.count += 1; return null; });
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { version: 1, count: 1 });
  assert.equal((await readdir(dir)).some((entry) => entry.includes("state.json.lock")), false);
});

test("a throwing mutator releases its cross-process lock and preserves queue recovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-throw-lock-"));
  const lockPath = path.join(dir, "state.json.lock");
  const store = new JsonStore({ dataDirectory: dir, createInitialState: () => ({ version: 1, count: 0 }) });

  await assert.rejects(store.update(async () => {
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    throw new Error("mutator failed");
  }), /mutator failed/);
  await store.update((state) => { state.count += 1; return null; });

  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1, count: 1 });
  assert.equal((await readdir(dir)).some((entry) => entry.includes("state.json.lock")), false);
});
