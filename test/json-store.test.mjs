import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

async function within(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => { throw new Error(`timed out waiting for ${label}`); }),
  ]);
}

async function readLockOwner(lockDirectory) {
  return JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8"));
}

async function lockArtifacts(dataDirectory, stateFileName = "state.json") {
  return (await readdir(dataDirectory)).filter((entry) => entry.startsWith(`${stateFileName}.lock`));
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

async function createStaleLockDirectory(dataDirectory, stateFileName = "state.json", {
  token = "11111111-1111-4111-8111-111111111111",
  pid = process.pid,
} = {}) {
  const lockDirectory = path.join(dataDirectory, `${stateFileName}.lock`);
  await mkdir(lockDirectory, { mode: 0o700 });
  const ownerPath = path.join(lockDirectory, "owner.json");
  await writeFile(ownerPath, JSON.stringify({
    version: 1,
    pid,
    token,
    created_at_ms: Date.now() - 10_000,
  }), { mode: 0o600 });
  const staleDate = new Date(Date.now() - 10_000);
  await utimes(ownerPath, staleDate, staleDate);
  await utimes(lockDirectory, staleDate, staleDate);
  return { lockDirectory, token };
}

function spawnCrashAtLockPhase(dataDirectory, phase) {
  const readyPath = path.join(dataDirectory, `crash-ready-${phase}`);
  const program = `
    import { writeFile } from "node:fs/promises";
    import { JsonStore } from ${JSON.stringify(jsonStoreUrl)};
    const pause = async () => {
      await writeFile(process.env.TEST_READY_PATH, "ready", { mode: 0o600 });
      await new Promise(() => setInterval(() => undefined, 1_000));
    };
    const store = new JsonStore({
      dataDirectory: process.env.TEST_DATA_DIRECTORY,
      createInitialState: () => ({ version: 1, count: 0 }),
      staleLockMs: 80,
      heartbeatIntervalMs: 15,
      lockPollMs: 5,
      lockTimeoutMs: 1_000,
      testHooks: { [process.env.TEST_PHASE]: pause },
    });
    await store.update((state) => { state.count += 1; return null; });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TEST_DATA_DIRECTORY: dataDirectory,
      TEST_PHASE: phase,
      TEST_READY_PATH: readyPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, done: observeChild(child), readyPath };
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
  await releaseBlockedUpdate(worker);
  const [workerResult, cliResult] = await Promise.all([worker.done, cli.done]);

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
  const lockDirectory = path.join(dir, `${probeStateFile}.lock`);
  try {
    const lockBefore = await readLockOwner(lockDirectory);
    const contender = new JsonStore({
      dataDirectory: dir,
      stateFileName: probeStateFile,
      createInitialState: () => ({}),
      lockTimeoutMs: 80,
      lockPollMs: 10,
    });
    await assert.rejects(contender.update((state) => { state.enabled = false; return null; }), /state lock acquisition timed out/);
    assert.deepEqual(await readLockOwner(lockDirectory), lockBefore);
  } finally {
    await releaseBlockedUpdate(worker);
    const result = await worker.done;
    assert.equal(result.code, 0, result.stderr);
  }
  await assert.rejects(stat(lockDirectory), { code: "ENOENT" });
});

test("a process crash leaves a recoverable lock without losing the next update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-crash-lock-"));
  await seedProbeState(dir, { version: 1, count: 0 });
  const worker = spawnBlockedProbeUpdate(dir, { server_revision: 4 });
  await waitForPath(worker.readyPath);
  const lockDirectory = path.join(dir, `${probeStateFile}.lock`);
  let lockMode;
  let ownerMode;
  let crashed;
  try {
    lockMode = (await stat(lockDirectory)).mode & 0o777;
    ownerMode = (await stat(path.join(lockDirectory, "owner.json"))).mode & 0o777;
  } finally {
    worker.child.kill("SIGKILL");
    crashed = await worker.done;
  }
  assert.equal(lockMode, 0o700);
  assert.equal(ownerMode, 0o600);
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
  const lockDirectory = `${statePath}.lock`;
  await writeFile(statePath, '{"version":1,"count":0}\n', { mode: 0o600 });
  await mkdir(lockDirectory, { mode: 0o700 });
  const impatientStore = new JsonStore({
    dataDirectory: dir,
    createInitialState: () => ({ version: 1, count: 0 }),
    lockTimeoutMs: 50,
    lockPollMs: 10,
    staleLockMs: 250,
  });

  await assert.rejects(
    impatientStore.update((state) => { state.count += 1; return null; }),
    /state lock acquisition timed out/,
  );
  assert.equal((await stat(lockDirectory)).mode & 0o777, 0o700);

  await delay(250);
  const recoveryStore = new JsonStore({
    dataDirectory: dir,
    createInitialState: () => ({ version: 1, count: 0 }),
    lockTimeoutMs: 500,
    lockPollMs: 10,
    staleLockMs: 250,
  });
  await recoveryStore.update((state) => { state.count += 1; return null; });
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { version: 1, count: 1 });
  assert.equal((await readdir(dir)).some((entry) => entry.includes("state.json.lock")), false);
});

test("a stale operation lease left before rename is recoverable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-operation-crash-"));
  await writeFile(path.join(dir, "state.json"), '{"version":1,"count":0}\n', { mode: 0o600 });
  const { lockDirectory } = await createStaleLockDirectory(dir);
  const operationOwnerPath = path.join(lockDirectory, "operation-owner.json");
  await writeFile(operationOwnerPath, JSON.stringify({
    version: 1,
    pid: process.pid,
    token: "22222222-2222-4222-8222-222222222222",
    created_at_ms: Date.now() - 10_000,
  }), { mode: 0o600 });
  const staleDate = new Date(Date.now() - 10_000);
  await utimes(operationOwnerPath, staleDate, staleDate);

  const store = new JsonStore({
    dataDirectory: dir,
    createInitialState: () => ({ version: 1, count: 0 }),
    staleLockMs: 40,
    heartbeatIntervalMs: 10,
    lockPollMs: 5,
    lockTimeoutMs: 500,
  });
  await store.update((state) => { state.count += 1; return null; });

  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1, count: 1 });
  assert.deepEqual(await lockArtifacts(dir), []);
});

test("a throwing mutator releases its cross-process lock and preserves queue recovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-throw-lock-"));
  const lockDirectory = path.join(dir, "state.json.lock");
  const store = new JsonStore({ dataDirectory: dir, createInitialState: () => ({ version: 1, count: 0 }) });

  await assert.rejects(store.update(async () => {
    assert.equal((await stat(lockDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(lockDirectory, "owner.json"))).mode & 0o777, 0o600);
    throw new Error("mutator failed");
  }), /mutator failed/);
  await store.update((state) => { state.count += 1; return null; });

  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1, count: 1 });
  assert.equal((await readdir(dir)).some((entry) => entry.includes("state.json.lock")), false);
});

test("two stale-lock recoverers cannot let an old decision remove a third writer's live lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-three-party-"));
  await writeFile(path.join(dir, "state.json"), '{"version":1,"count":0}\n', { mode: 0o600 });
  await createStaleLockDirectory(dir);

  const bothObserved = deferred();
  const allowClaims = deferred();
  const recoveryMoved = deferred();
  const allowRecoveryCleanup = deferred();
  const recoveryCleaned = deferred();
  const loserMissed = deferred();
  const allowLoserRetry = deferred();
  let observedCount = 0;
  let isolatedRecoveryPath;
  const hooks = () => ({
    beforeRecoveryClaim: async () => {
      observedCount += 1;
      if (observedCount === 2) bothObserved.resolve();
      await allowClaims.promise;
    },
    afterRecoveryClaimMiss: async () => {
      loserMissed.resolve();
      await allowLoserRetry.promise;
    },
    afterRecoveryRename: async ({ recoveryPath }) => {
      isolatedRecoveryPath = recoveryPath;
      recoveryMoved.resolve();
      await allowRecoveryCleanup.promise;
    },
    afterRecoveryCleanup: async () => recoveryCleaned.resolve(),
  });
  const options = {
    dataDirectory: dir,
    createInitialState: () => ({ version: 1, count: 0 }),
    staleLockMs: 40,
    heartbeatIntervalMs: 10,
    lockPollMs: 5,
    lockTimeoutMs: 2_000,
  };
  const first = new JsonStore({ ...options, testHooks: hooks() });
  const second = new JsonStore({ ...options, testHooks: hooks() });
  const recovererUpdates = [
    first.update((state) => { state.count += 1; return null; }),
    second.update((state) => { state.count += 1; return null; }),
  ];
  const recoverersDone = Promise.allSettled(recovererUpdates);
  const thirdRelease = deferred();
  const allGates = [allowClaims, allowRecoveryCleanup, allowLoserRetry, thirdRelease];

  try {
    await within(bothObserved.promise, 1_000, "both stale observations");
    allowClaims.resolve();
    await within(Promise.all([recoveryMoved.promise, loserMissed.promise]), 1_000, "one recovery winner and one loser");

    const thirdOwner = deferred();
    const thirdEntered = deferred();
    const third = new JsonStore({
      ...options,
      testHooks: { afterOwnerWritten: ({ token }) => thirdOwner.resolve(token) },
    });
    const thirdUpdate = third.update(async (state) => {
      thirdEntered.resolve();
      await thirdRelease.promise;
      state.count += 1;
      return null;
    });
    await within(thirdEntered.promise, 1_000, "third writer critical section");
    const thirdToken = await thirdOwner.promise;
    assert.equal((await stat(isolatedRecoveryPath)).isDirectory(), true);

    allowRecoveryCleanup.resolve();
    await within(recoveryCleaned.promise, 1_000, "isolated recovery cleanup");
    assert.equal((await readLockOwner(path.join(dir, "state.json.lock"))).token, thirdToken);

    thirdRelease.resolve();
    allowLoserRetry.resolve();
    const [thirdResult, recovererResults] = await Promise.all([thirdUpdate, recoverersDone]);
    assert.equal(thirdResult, null);
    assert.ok(recovererResults.every((result) => result.status === "fulfilled"), JSON.stringify(recovererResults));
  } finally {
    for (const gate of allGates) gate.resolve();
    await recoverersDone;
  }

  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1, count: 3 });
  assert.deepEqual(await lockArtifacts(dir), []);
});

test("a live owner heartbeat survives beyond the stale threshold and releases to a waiting writer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-heartbeat-"));
  const holderEntered = deferred();
  const holderRelease = deferred();
  const contenderWaiting = deferred();
  const options = {
    dataDirectory: dir,
    createInitialState: () => ({ version: 1, count: 0 }),
    staleLockMs: 60,
    heartbeatIntervalMs: 10,
    lockPollMs: 5,
    lockTimeoutMs: 1_000,
  };
  const holder = new JsonStore(options);
  const holderUpdate = holder.update(async (state) => {
    holderEntered.resolve();
    await holderRelease.promise;
    state.count += 1;
    return null;
  });
  await within(holderEntered.promise, 500, "holder critical section");
  const lockDirectory = path.join(dir, "state.json.lock");
  let contenderUpdate;
  try {
    const originalToken = (await readLockOwner(lockDirectory)).token;
    const contender = new JsonStore({
      ...options,
      testHooks: { onLockWait: () => contenderWaiting.resolve() },
    });
    contenderUpdate = contender.update((state) => { state.count += 1; return null; });
    await within(contenderWaiting.promise, 500, "contender lock wait");
    await delay(180);
    assert.equal((await readLockOwner(lockDirectory)).token, originalToken);
  } finally {
    holderRelease.resolve();
  }
  await Promise.all([holderUpdate, contenderUpdate].filter(Boolean));
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1, count: 2 });
  assert.deepEqual(await lockArtifacts(dir), []);
});

test("fresh heartbeat authority avoids PID probing while stale heartbeat permits PID-reuse recovery", async () => {
  const source = await readFile(path.join(repositoryRoot, "src/persistence/json-store.js"), "utf8");
  assert.doesNotMatch(source, /process\.kill/);

  const freshDir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-eperm-"));
  await writeFile(path.join(freshDir, "state.json"), '{"version":1,"count":0}\n', { mode: 0o600 });
  const fresh = await createStaleLockDirectory(freshDir, "state.json", { pid: 1 });
  const now = new Date();
  await utimes(path.join(fresh.lockDirectory, "owner.json"), now, now);
  const blocked = new JsonStore({
    dataDirectory: freshDir,
    createInitialState: () => ({ version: 1, count: 0 }),
    staleLockMs: 250,
    heartbeatIntervalMs: 20,
    lockPollMs: 5,
    lockTimeoutMs: 60,
  });
  await assert.rejects(blocked.update(() => null), /state lock acquisition timed out/);
  assert.equal((await readLockOwner(fresh.lockDirectory)).pid, 1);
  await rm(fresh.lockDirectory, { recursive: true });

  const staleDir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-pid-reuse-"));
  await writeFile(path.join(staleDir, "state.json"), '{"version":1,"count":0}\n', { mode: 0o600 });
  await createStaleLockDirectory(staleDir, "state.json", { pid: process.pid });
  const recovery = new JsonStore({
    dataDirectory: staleDir,
    createInitialState: () => ({ version: 1, count: 0 }),
    staleLockMs: 40,
    heartbeatIntervalMs: 10,
    lockPollMs: 5,
    lockTimeoutMs: 500,
  });
  await recovery.update((state) => { state.count += 1; return null; });
  assert.deepEqual(JSON.parse(await readFile(path.join(staleDir, "state.json"), "utf8")), { version: 1, count: 1 });
  assert.deepEqual(await lockArtifacts(staleDir), []);
});

test("SIGKILL around mkdir, owner write, and release phases is boundedly recoverable without residue", async () => {
  const phases = [
    "beforeLockDirectoryCreate",
    "afterLockDirectoryCreate",
    "beforeOwnerWrite",
    "afterOwnerWritten",
    "beforeReleaseRename",
    "afterReleaseOperationOwnerWritten",
    "afterReleaseRename",
  ];
  for (const phase of phases) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `imvia-json-store-crash-${phase}-`));
    const crashing = spawnCrashAtLockPhase(dir, phase);
    await within(waitForPath(crashing.readyPath), 1_000, `${phase} crash barrier`);
    crashing.child.kill("SIGKILL");
    const result = await crashing.done;
    assert.equal(result.signal, "SIGKILL", `${phase}: ${result.stderr}`);

    const recovery = new JsonStore({
      dataDirectory: dir,
      createInitialState: () => ({ version: 1, count: 0 }),
      staleLockMs: 80,
      heartbeatIntervalMs: 15,
      lockPollMs: 5,
      lockTimeoutMs: 1_000,
    });
    await recovery.update((state) => { state.count += 10; return null; });
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.ok(state.count === 10 || state.count === 11, `${phase}: ${state.count}`);
    if ((await lockArtifacts(dir)).length > 0) {
      await delay(100);
      await recovery.update(() => null);
    }
    assert.deepEqual(await lockArtifacts(dir), [], phase);
  }
});

test("lock implementation uses unrefed cleared heartbeats and never removes a public lock path", async () => {
  const source = await readFile(path.join(repositoryRoot, "src/persistence/json-store.js"), "utf8");
  assert.match(source, /\.unref\(\)/);
  assert.match(source, /clearInterval\(/);
  assert.doesNotMatch(source, /\blink\(/);
  assert.doesNotMatch(source, /(?:rm|unlink)\([^\n]*#lock(?:Path|Directory)/);
  assert.match(source, /rename\([^\n]*#lockDirectory/);
});
