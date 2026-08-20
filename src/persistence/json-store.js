import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 20;
const DEFAULT_INVALID_LOCK_STALE_MS = 1_000;
const LOCK_TOKEN = /^[0-9a-f-]{36}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseLockOwner(serialized) {
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

function ownerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export class JsonStore {
  #queue = Promise.resolve();
  #lockTimeoutMs;
  #lockPollMs;
  #invalidLockStaleMs;
  #lockPath;
  #recoveryPath;

  constructor({
    dataDirectory,
    createInitialState,
    stateFileName = "state.json",
    lockTimeoutMs,
    lockPollMs,
    invalidLockStaleMs,
  }) {
    if (path.basename(stateFileName) !== stateFileName || !stateFileName.endsWith(".json")) {
      throw new TypeError("stateFileName must be a local .json filename");
    }
    this.dataDirectory = dataDirectory;
    this.createInitialState = createInitialState;
    this.statePath = path.join(dataDirectory, stateFileName);
    this.#lockPath = `${this.statePath}.lock`;
    this.#recoveryPath = `${this.#lockPath}.recovery`;
    this.#lockTimeoutMs = positiveInteger(lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.#lockPollMs = positiveInteger(lockPollMs, DEFAULT_LOCK_POLL_MS);
    this.#invalidLockStaleMs = positiveInteger(invalidLockStaleMs, DEFAULT_INVALID_LOCK_STALE_MS);
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
    const owner = await this.#acquireLock();
    try {
      return await operation();
    } finally {
      await this.#releaseLock(owner);
    }
  }

  async #acquireLock() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#lockTimeoutMs;
    while (true) {
      await this.#finishRecovery();
      const token = randomUUID();
      const owner = {
        version: 1,
        pid: process.pid,
        token,
        created_at_ms: Date.now(),
      };
      const serialized = JSON.stringify(owner);
      const candidatePath = `${this.#lockPath}.${token}.owner`;
      await writeFile(candidatePath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        await link(candidatePath, this.#lockPath);
      } catch (error) {
        await this.#unlinkIfPresent(candidatePath);
        if (error?.code !== "EEXIST") throw error;
        await this.#recoverLockIfSafe();
        if (Date.now() >= deadline) throw new Error("state lock acquisition timed out");
        await delay(this.#lockPollMs);
        continue;
      }

      try {
        await stat(this.#recoveryPath);
      } catch (error) {
        if (error?.code === "ENOENT") return { serialized, candidatePath };
        await this.#releaseLock({ serialized, candidatePath });
        throw error;
      }
      await this.#releaseLock({ serialized, candidatePath });
      if (Date.now() >= deadline) throw new Error("state lock acquisition timed out");
      await delay(this.#lockPollMs);
    }
  }

  async #releaseLock({ serialized, candidatePath }) {
    try {
      if (await readFile(this.#lockPath, "utf8") === serialized) await unlink(this.#lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      try {
        if (await readFile(candidatePath, "utf8") === serialized) await unlink(candidatePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  async #recoverLockIfSafe() {
    let serialized;
    let lockStat;
    try {
      [serialized, lockStat] = await Promise.all([
        readFile(this.#lockPath, "utf8"),
        stat(this.#lockPath),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
    if (!this.#isRecoverable(serialized, lockStat.mtimeMs)) return false;
    try {
      await link(this.#lockPath, this.#recoveryPath);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
    }
    await this.#finishRecovery();
    try {
      await stat(this.#lockPath);
      return false;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  }

  async #finishRecovery() {
    let recoveryStat;
    try {
      recoveryStat = await stat(this.#recoveryPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    let lockStat;
    try {
      lockStat = await stat(this.#lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#cleanupRecoveryOwner();
      await this.#unlinkIfPresent(this.#recoveryPath);
      return;
    }

    if (lockStat.dev !== recoveryStat.dev || lockStat.ino !== recoveryStat.ino) {
      await this.#cleanupRecoveryOwner();
      await this.#unlinkIfPresent(this.#recoveryPath);
      return;
    }

    const serialized = await readFile(this.#recoveryPath, "utf8");
    if (!this.#isRecoverable(serialized, recoveryStat.mtimeMs)) return;
    await this.#unlinkIfPresent(this.#lockPath);
    await this.#cleanupRecoveryOwner(serialized);
    await this.#unlinkIfPresent(this.#recoveryPath);
  }

  #isRecoverable(serialized, modifiedAtMs) {
    const owner = parseLockOwner(serialized);
    if (owner) return !ownerIsAlive(owner.pid);
    return Date.now() - modifiedAtMs >= this.#invalidLockStaleMs;
  }

  async #cleanupRecoveryOwner(knownSerialized) {
    let serialized = knownSerialized;
    try {
      if (serialized === undefined) serialized = await readFile(this.#recoveryPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const owner = parseLockOwner(serialized);
    if (!owner) return;
    const candidatePath = `${this.#lockPath}.${owner.token}.owner`;
    try {
      if (await readFile(candidatePath, "utf8") === serialized) await unlink(candidatePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async #unlinkIfPresent(filePath) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async #write(state) {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}
