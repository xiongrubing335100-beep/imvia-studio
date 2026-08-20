import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 20;
const DEFAULT_STALE_LOCK_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 250;
const LOCK_TOKEN = /^[0-9a-f-]{36}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseOwner(serialized) {
  try {
    const owner = JSON.parse(serialized);
    if (owner?.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== "string" || !LOCK_TOKEN.test(owner.token)
      || !Number.isFinite(owner.created_at_ms) || owner.created_at_ms < 0) return null;
    return owner;
  } catch {
    return null;
  }
}

export class JsonStore {
  #queue = Promise.resolve();
  #lockTimeoutMs;
  #lockPollMs;
  #staleLockMs;
  #heartbeatIntervalMs;
  #lockDirectory;
  #ownerPath;
  #testHooks;

  constructor({
    dataDirectory,
    createInitialState,
    stateFileName = "state.json",
    lockTimeoutMs,
    lockPollMs,
    staleLockMs,
    heartbeatIntervalMs,
    testHooks,
  }) {
    if (path.basename(stateFileName) !== stateFileName || !stateFileName.endsWith(".json")) {
      throw new TypeError("stateFileName must be a local .json filename");
    }
    this.dataDirectory = dataDirectory;
    this.createInitialState = createInitialState;
    this.statePath = path.join(dataDirectory, stateFileName);
    this.#lockDirectory = `${this.statePath}.lock`;
    this.#ownerPath = path.join(this.#lockDirectory, "owner.json");
    this.#lockTimeoutMs = positiveInteger(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.#lockPollMs = positiveInteger(lockPollMs, DEFAULT_LOCK_POLL_MS);
    this.#staleLockMs = positiveInteger(staleLockMs, DEFAULT_STALE_LOCK_MS);
    const requestedHeartbeat = positiveInteger(heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.#heartbeatIntervalMs = Math.min(requestedHeartbeat, Math.max(1, Math.floor(this.#staleLockMs / 3)));
    this.#testHooks = testHooks && typeof testHooks === "object" ? testHooks : null;
  }

  async read() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    try {
      return await this.#readExisting();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return this.#withLock(async () => {
        try {
          return await this.#readExisting();
        } catch (lockedError) {
          if (lockedError?.code !== "ENOENT") throw lockedError;
          const initial = this.createInitialState();
          await this.#write(initial);
          return clone(initial);
        }
      });
    }
  }

  async update(mutator) {
    const operation = this.#queue.then(() => this.#withLock(async () => {
      let state;
      try {
        state = await this.#readExisting();
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        state = this.createInitialState();
        await this.#write(state);
      }
      const result = await mutator(state);
      await this.#write(state);
      return clone(result);
    }));
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #readExisting() {
    return clone(JSON.parse(await readFile(this.statePath, "utf8")));
  }

  async #withLock(operation) {
    const lock = await this.#acquireLock();
    try {
      return await operation();
    } finally {
      await this.#releaseLock(lock);
    }
  }

  async #acquireLock() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#lockTimeoutMs;
    while (true) {
      await this.#cleanupStaleOrphans();
      await this.#callHook("beforeLockDirectoryCreate");
      try {
        await mkdir(this.#lockDirectory, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await this.#callHook("onLockWait");
        await this.#recoverStaleLock();
        if (Date.now() >= deadline) throw new Error("state lock acquisition timed out");
        await delay(this.#lockPollMs);
        continue;
      }

      const token = randomUUID();
      let heartbeat;
      try {
        await this.#callHook("afterLockDirectoryCreate", { token });
        await this.#callHook("beforeOwnerWrite", { token });
        await writeFile(this.#ownerPath, JSON.stringify({
          version: 1,
          pid: process.pid,
          token,
          created_at_ms: Date.now(),
        }), { encoding: "utf8", flag: "wx", mode: 0o600 });
        heartbeat = this.#startHeartbeat(this.#lockDirectory, token);
        await this.#callHook("afterOwnerWritten", { token, lockDirectory: this.#lockDirectory });
        return { token, heartbeat };
      } catch (error) {
        if (heartbeat) await heartbeat.stop();
        await this.#moveOwnedDirectoryForCleanup(token, "release");
        throw error;
      }
    }
  }

  #startHeartbeat(directory, token, ownerFileName = "owner.json") {
    const ownerPath = path.join(directory, ownerFileName);
    let stopped = false;
    let beating = false;
    let inFlight = Promise.resolve();
    const beat = () => {
      if (stopped || beating) return;
      beating = true;
      inFlight = (async () => {
        try {
          const owner = parseOwner(await readFile(ownerPath, "utf8"));
          if (!owner || owner.token !== token) return;
          const now = new Date();
          await utimes(ownerPath, now, now);
        } catch (error) {
          if (error?.code !== "ENOENT") return;
        }
      })().finally(() => { beating = false; });
    };
    const timer = setInterval(beat, this.#heartbeatIntervalMs);
    timer.unref();
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  async #releaseLock({ token, heartbeat }) {
    let hookError;
    let releasePath;
    let operationHeartbeat;
    try {
      const owner = await this.#readOwner(this.#lockDirectory);
      if (!owner || owner.token !== token) return;
      try {
        await this.#callHook("beforeReleaseRename", { token });
      } catch (error) {
        hookError = error;
      }
      releasePath = `${this.#lockDirectory}.release-${token}-${randomUUID()}`;
      const operationToken = await this.#writeOperationOwner(this.#lockDirectory);
      await this.#callHook("afterReleaseOperationOwnerWritten", { token });
      try {
        await rename(this.#lockDirectory, releasePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        return;
      }
      operationHeartbeat = this.#startHeartbeat(releasePath, operationToken, "operation-owner.json");
    } finally {
      await heartbeat.stop();
    }

    try {
      const movedOwner = await this.#readOwner(releasePath);
      if (!movedOwner || movedOwner.token !== token) {
        throw new Error("state lock ownership changed during release");
      }
      await this.#callHook("afterReleaseRename", { token, releasePath });
      if (hookError) throw hookError;
    } finally {
      if (operationHeartbeat) await operationHeartbeat.stop();
      await this.#removeUniquePath(releasePath);
    }
  }

  async #moveOwnedDirectoryForCleanup(token, kind) {
    const owner = await this.#readOwner(this.#lockDirectory).catch(() => null);
    if (!owner || owner.token !== token) return;
    const uniquePath = `${this.#lockDirectory}.${kind}-${token}-${randomUUID()}`;
    try {
      await rename(this.#lockDirectory, uniquePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return;
    }
    await this.#removeUniquePath(uniquePath);
  }

  async #recoverStaleLock() {
    const observed = await this.#readSnapshot(this.#lockDirectory);
    if (!observed || !this.#isStale(observed)) return false;
    await this.#callHook("beforeRecoveryClaim", { identity: observed.identity });

    const claimPath = `${this.#lockDirectory}.recover-${observed.key}.claim`;
    try {
      await mkdir(claimPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await this.#callHook("afterRecoveryClaimMiss", { identity: observed.identity });
      return false;
    }

    const claimToken = randomUUID();
    let claimHeartbeat;
    let operationHeartbeat;
    let recoveryPath;
    try {
      await writeFile(path.join(claimPath, "owner.json"), JSON.stringify({
        version: 1,
        pid: process.pid,
        token: claimToken,
        created_at_ms: Date.now(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      claimHeartbeat = this.#startHeartbeat(claimPath, claimToken);

      const current = await this.#readSnapshot(this.#lockDirectory);
      if (!current || current.identity !== observed.identity || !this.#isStale(current)) return false;

      recoveryPath = `${this.#lockDirectory}.recovery-${observed.key}-${claimToken}`;
      const operationToken = await this.#writeOperationOwner(this.#lockDirectory);
      await this.#callHook("afterRecoveryOperationOwnerWritten", { identity: observed.identity });
      try {
        await rename(this.#lockDirectory, recoveryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await this.#callHook("afterRecoveryClaimMiss", { identity: observed.identity });
        return false;
      }
      operationHeartbeat = this.#startHeartbeat(recoveryPath, operationToken, "operation-owner.json");
      await this.#callHook("afterRecoveryRename", { identity: observed.identity, recoveryPath });
      await operationHeartbeat.stop();
      operationHeartbeat = undefined;
      await this.#removeUniquePath(recoveryPath);
      recoveryPath = undefined;
      await this.#callHook("afterRecoveryCleanup", { identity: observed.identity });
      return true;
    } finally {
      if (operationHeartbeat) await operationHeartbeat.stop();
      if (claimHeartbeat) await claimHeartbeat.stop();
      if (recoveryPath) await this.#removeUniquePath(recoveryPath);
      await this.#removeUniquePath(claimPath);
    }
  }

  async #readSnapshot(directory) {
    let directoryStat;
    try {
      directoryStat = await stat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const operationOwnerPath = path.join(directory, "operation-owner.json");
    try {
      const [serialized, ownerStat] = await Promise.all([
        readFile(operationOwnerPath, "utf8"),
        stat(operationOwnerPath),
      ]);
      const owner = parseOwner(serialized);
      return {
        owner,
        heartbeatMs: ownerStat.mtimeMs,
        identity: `${directoryStat.dev}-${directoryStat.ino}-operation-${owner?.token ?? "invalid"}`,
        key: owner?.token ?? `${directoryStat.dev}-${directoryStat.ino}`,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const ownerPath = path.join(directory, "owner.json");
    try {
      const [serialized, ownerStat] = await Promise.all([readFile(ownerPath, "utf8"), stat(ownerPath)]);
      const owner = parseOwner(serialized);
      return {
        owner,
        heartbeatMs: ownerStat.mtimeMs,
        identity: `${directoryStat.dev}-${directoryStat.ino}-${owner?.token ?? "invalid"}`,
        key: owner?.token ?? `${directoryStat.dev}-${directoryStat.ino}`,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      owner: null,
      heartbeatMs: directoryStat.mtimeMs,
      identity: `${directoryStat.dev}-${directoryStat.ino}-incomplete`,
      key: `${directoryStat.dev}-${directoryStat.ino}`,
    };
  }

  #isStale(snapshot) {
    return Date.now() - snapshot.heartbeatMs >= this.#staleLockMs;
  }

  async #readOwner(directory) {
    try {
      return parseOwner(await readFile(path.join(directory, "owner.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeOperationOwner(directory) {
    const token = randomUUID();
    const temporaryOwnerPath = path.join(directory, `operation-owner-${token}.json`);
    await writeFile(temporaryOwnerPath, JSON.stringify({
      version: 1,
      pid: process.pid,
      token,
      created_at_ms: Date.now(),
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryOwnerPath, path.join(directory, "operation-owner.json"));
    return token;
  }

  async #cleanupStaleOrphans() {
    const base = path.basename(this.#lockDirectory);
    const entries = await readdir(this.dataDirectory);
    for (const entry of entries) {
      if (!entry.startsWith(`${base}.`)) continue;
      const candidate = path.join(this.dataDirectory, entry);
      const isClaim = entry.startsWith(`${base}.recover-`) && entry.endsWith(".claim");
      const isUniqueDirectory = entry.startsWith(`${base}.recovery-`)
        || entry.startsWith(`${base}.release-`);
      if (!isClaim && !isUniqueDirectory) continue;
      const snapshot = await this.#readSnapshot(candidate);
      if (snapshot && this.#isStale(snapshot)) await this.#removeUniquePath(candidate);
    }
  }

  async #removeUniquePath(uniquePath) {
    try {
      await rm(uniquePath, { recursive: true, force: false });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async #callHook(name, context = {}) {
    const hook = this.#testHooks?.[name];
    if (typeof hook === "function") await hook(context);
  }

  async #write(state) {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}
