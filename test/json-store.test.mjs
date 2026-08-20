import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const lockTimeoutMessage = "state lock is unavailable";

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
      return filePath;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

async function waitForWaiterMarker(dataDirectory, stateFileName, timeoutMs = 3_000) {
  const prefix = `${stateFileName}.lock.waiter-`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marker = (await readdir(dataDirectory)).find((entry) => entry.startsWith(prefix));
    if (marker) return path.join(dataDirectory, marker);
    await delay(10);
  }
  throw new Error(`timed out waiting for ${prefix}`);
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
      if (mutation.authorization) state.authorizations.push(mutation.authorization);
      if (mutation.consume_authorization) {
        const authorization = state.authorizations.find(({ id }) => id === mutation.consume_authorization.id);
        authorization.consumed_at = mutation.consume_authorization.at;
      }
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

async function lockArtifacts(dataDirectory, stateFileName = "state.json") {
  return (await readdir(dataDirectory)).filter((entry) => entry.startsWith(`${stateFileName}.lock`));
}

function assertLockUnavailable(result) {
  assert.equal(result.status, "rejected");
  assert.equal(result.reason?.code, "STATE_LOCK_UNAVAILABLE");
  assert.equal(result.reason?.message, lockTimeoutMessage);
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
    stateFileName: probeStateFile,
    createInitialState: () => ({ version: 1, enabled: false }),
  });
  await store.read();
  const statePath = path.join(dir, probeStateFile);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { version: 1, enabled: false });
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("a real CLI waiter enters contention before disable and preserves the server update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-race-"));
  const authorization = {
    id: "authorization-1",
    kind: "lovart_capability_probe",
    source: "user:current_session",
    reason: "concurrent request",
    policy_version: "lovart-readonly-probe-v1",
    issued_at: "2026-08-20T00:00:01.000Z",
    expires_at: "2026-08-20T00:02:01.000Z",
    consumed_at: null,
    idempotency_key: "authorization-key",
  };
  const audit = {
    type: "authorization_created",
    authorization_id: "authorization-1",
    at: "2026-08-20T00:00:01.000Z",
  };
  await seedProbeState(dir, {
    version: 1,
    enabled: true,
    authorizations: [],
    attempts: [],
    audit_events: [{ type: "probe_enabled", at: "2026-08-20T00:00:00.000Z" }],
  });
  const worker = spawnBlockedProbeUpdate(dir, { authorization, audit });
  await waitForPath(worker.readyPath);
  const cli = spawnFlag(dir, "disable");
  let markerPath;
  try {
    markerPath = await waitForWaiterMarker(dir, probeStateFile);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.deepEqual(Object.keys(marker).sort(), ["pid", "token"]);
    assert.equal(marker.pid, cli.child.pid);
    assert.match(marker.token, /^[0-9a-f-]{36}$/);
    assert.equal((await stat(markerPath)).mode & 0o777, 0o600);

    await releaseBlockedUpdate(worker);
    const [workerResult, cliResult] = await Promise.all([worker.done, cli.done]);
    assert.equal(workerResult.code, 0, workerResult.stderr);
    assert.equal(cliResult.code, 0, cliResult.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, probeStateFile), "utf8")), {
      version: 1,
      enabled: false,
      authorizations: [authorization],
      attempts: [],
      audit_events: [
        { type: "probe_enabled", at: "2026-08-20T00:00:00.000Z" },
        audit,
      ],
    });
    await assert.rejects(access(markerPath), { code: "ENOENT" });
    assert.deepEqual(await lockArtifacts(dir, probeStateFile), []);
  } finally {
    await releaseBlockedUpdate(worker);
    await Promise.all([worker.done, cli.done]);
  }
});

test("a concurrent attempt and audit write are retained when the CLI toggles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-attempt-"));
  const initial = {
    version: 1,
    enabled: true,
    authorizations: [{
      id: "authorization-1",
      kind: "lovart_capability_probe",
      source: "user:current_session",
      reason: "concurrent request",
      policy_version: "lovart-readonly-probe-v1",
      issued_at: "2026-08-20T00:00:00.000Z",
      expires_at: "2026-08-20T00:02:00.000Z",
      consumed_at: null,
      idempotency_key: "authorization-key",
    }],
    attempts: [],
    audit_events: [{
      type: "authorization_created",
      authorization_id: "authorization-1",
      at: "2026-08-20T00:00:00.000Z",
    }],
  };
  await seedProbeState(dir, initial);
  const attempt = {
    id: "attempt-1",
    authorization_id: "authorization-1",
    idempotency_key: "attempt-key",
    status: "pending",
    started_at: "2026-08-20T00:00:01.000Z",
    completed_at: null,
    result: null,
    error_code: null,
  };
  const audit = {
    type: "probe_claimed",
    authorization_id: "authorization-1",
    attempt_id: "attempt-1",
    at: "2026-08-20T00:00:01.000Z",
  };
  const worker = spawnBlockedProbeUpdate(dir, {
    consume_authorization: { id: "authorization-1", at: "2026-08-20T00:00:01.000Z" },
    attempt,
    audit,
  });
  await waitForPath(worker.readyPath);
  const cli = spawnFlag(dir, "disable");
  try {
    await waitForWaiterMarker(dir, probeStateFile);
    await releaseBlockedUpdate(worker);
    const [workerResult, cliResult] = await Promise.all([worker.done, cli.done]);

    assert.equal(workerResult.code, 0, workerResult.stderr);
    assert.equal(cliResult.code, 0, cliResult.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, probeStateFile), "utf8")), {
      ...initial,
      enabled: false,
      authorizations: [{ ...initial.authorizations[0], consumed_at: "2026-08-20T00:00:01.000Z" }],
      attempts: [attempt],
      audit_events: [...initial.audit_events, audit],
    });
    assert.deepEqual(await lockArtifacts(dir, probeStateFile), []);
  } finally {
    await releaseBlockedUpdate(worker);
    await Promise.all([worker.done, cli.done]);
  }
});

test("active, abandoned PID-reuse, and incomplete locks all fail closed without mutation", async () => {
  const activeDir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-active-"));
  await seedProbeState(activeDir, {
    version: 1,
    enabled: true,
    authorizations: [],
    attempts: [],
    audit_events: [],
  });
  const activeWorker = spawnBlockedProbeUpdate(activeDir, { server_revision: 3 });
  await waitForPath(activeWorker.readyPath);
  const activeLock = path.join(activeDir, `${probeStateFile}.lock`);
  const activeOwnerBefore = await readFile(path.join(activeLock, "owner.json"), "utf8");

  const abandonedDir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-abandoned-"));
  const abandonedState = path.join(abandonedDir, "state.json");
  const abandonedLock = `${abandonedState}.lock`;
  const abandonedOwner = JSON.stringify({
    version: 1,
    pid: process.pid,
    token: "11111111-1111-4111-8111-111111111111",
    created_at_ms: 0,
  });
  await writeFile(abandonedState, '{"version":1,"count":0}\n', { mode: 0o600 });
  await mkdir(abandonedLock, { mode: 0o700 });
  await writeFile(path.join(abandonedLock, "owner.json"), abandonedOwner, { mode: 0o600 });

  const incompleteDir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-incomplete-"));
  const incompleteState = path.join(incompleteDir, "state.json");
  const incompleteLock = `${incompleteState}.lock`;
  await writeFile(incompleteState, '{"version":1,"count":0}\n', { mode: 0o600 });
  await mkdir(incompleteLock, { mode: 0o700 });

  const activeStore = new JsonStore({
    dataDirectory: activeDir,
    stateFileName: probeStateFile,
    createInitialState: () => ({}),
  });
  const abandonedStore = new JsonStore({
    dataDirectory: abandonedDir,
    createInitialState: () => ({ version: 1, count: 0 }),
  });
  const incompleteStore = new JsonStore({
    dataDirectory: incompleteDir,
    createInitialState: () => ({ version: 1, count: 0 }),
  });
  const startedAt = Date.now();
  const results = await Promise.allSettled([
    activeStore.update((state) => { state.enabled = false; return null; }),
    abandonedStore.update((state) => { state.count += 1; return null; }),
    incompleteStore.update((state) => { state.count += 1; return null; }),
  ]);
  const elapsedMs = Date.now() - startedAt;

  try {
    for (const result of results) assertLockUnavailable(result);
    assert.ok(elapsedMs >= 4_500 && elapsedMs < 8_000, `bounded timeout took ${elapsedMs}ms`);
    assert.equal(await readFile(path.join(activeLock, "owner.json"), "utf8"), activeOwnerBefore);
    assert.equal(await readFile(path.join(abandonedLock, "owner.json"), "utf8"), abandonedOwner);
    assert.deepEqual(await readdir(incompleteLock), []);
    assert.deepEqual(JSON.parse(await readFile(abandonedState, "utf8")), { version: 1, count: 0 });
    assert.deepEqual(JSON.parse(await readFile(incompleteState, "utf8")), { version: 1, count: 0 });
    assert.deepEqual(await lockArtifacts(abandonedDir), ["state.json.lock"]);
    assert.deepEqual(await lockArtifacts(incompleteDir), ["state.json.lock"]);
  } finally {
    await releaseBlockedUpdate(activeWorker);
    const result = await activeWorker.done;
    assert.equal(result.code, 0, result.stderr);
    await rm(abandonedLock, { recursive: true, force: true });
    await rm(incompleteLock, { recursive: true, force: true });
  }
  assert.deepEqual(await lockArtifacts(activeDir, probeStateFile), []);
});

test("a throwing mutator releases normally and the same queue remains usable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-throw-"));
  const lockDirectory = path.join(dir, "state.json.lock");
  const store = new JsonStore({ dataDirectory: dir, createInitialState: () => ({ version: 1, count: 0 }) });

  await assert.rejects(store.update(async () => {
    assert.equal((await stat(lockDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(lockDirectory, "owner.json"))).mode & 0o777, 0o600);
    throw new Error("mutator failed");
  }), /mutator failed/);
  assert.deepEqual(await lockArtifacts(dir), []);

  await store.update((state) => { state.count += 1; return null; });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")), { version: 1, count: 1 });
  assert.deepEqual(await lockArtifacts(dir), []);
});

test("a release ownership failure retains the operation error and leaves the public lock untouched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imvia-json-store-release-error-"));
  const lockDirectory = path.join(dir, "state.json.lock");
  const ownerPath = path.join(lockDirectory, "owner.json");
  const store = new JsonStore({ dataDirectory: dir, createInitialState: () => ({ version: 1, count: 0 }) });
  const operationError = new Error("operation failed first");
  const replacementOwner = JSON.stringify({
    version: 1,
    pid: process.pid,
    token: "33333333-3333-4333-8333-333333333333",
    created_at_ms: 1,
  });

  try {
    await assert.rejects(store.update(async () => {
      await writeFile(ownerPath, replacementOwner, { mode: 0o600 });
      throw operationError;
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "operation failed first");
      assert.equal(error.cause, operationError);
      assert.equal(error.errors[0], operationError);
      assert.equal(error.errors[1]?.code, "STATE_LOCK_OWNERSHIP_CHANGED");
      return true;
    });
    assert.equal(await readFile(ownerPath, "utf8"), replacementOwner);
    assert.deepEqual(await lockArtifacts(dir), ["state.json.lock"]);
  } finally {
    await rm(lockDirectory, { recursive: true });
  }
});
