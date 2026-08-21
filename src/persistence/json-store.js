import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 20;
const LOCK_TOKEN = /^[0-9a-f-]{36}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function localLockError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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

function combinedOperationAndReleaseError(operationError, releaseError) {
  const message = typeof operationError?.message === "string"
    ? operationError.message
    : "state operation failed before lock release";
  return new AggregateError([operationError, releaseError], message, { cause: operationError });
}

export class JsonStore {
  #queue = Promise.resolve();
  #lockDirectory;
  #ownerPath;
  #testHooks;

  constructor({ dataDirectory, createInitialState, stateFileName = "state.json", testHooks }) {
    if (path.basename(stateFileName) !== stateFileName || !stateFileName.endsWith(".json")) {
      throw new TypeError("stateFileName must be a local .json filename");
    }
    this.dataDirectory = dataDirectory;
    this.createInitialState = createInitialState;
    this.statePath = path.join(dataDirectory, stateFileName);
    this.#lockDirectory = `${this.statePath}.lock`;
    this.#ownerPath = path.join(this.#lockDirectory, "owner.json");
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
    let operationFailed = false;
    let operationError;
    try {
      return await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      try {
        await this.#releaseLock(lock);
      } catch (releaseError) {
        if (operationFailed) throw combinedOperationAndReleaseError(operationError, releaseError);
        throw releaseError;
      }
    }
  }

  async #acquireLock() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let waiterPath;
    try {
      while (true) {
        try {
          await mkdir(this.#lockDirectory, { mode: 0o700 });
          break;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          if (!waiterPath) {
            waiterPath = await this.#createWaiterMarker();
            await this.#callHook("onLockWait", { waiterPath });
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw localLockError("STATE_LOCK_UNAVAILABLE", "state lock is unavailable");
          }
          await delay(Math.min(LOCK_POLL_MS, remainingMs));
        }
      }
    } finally {
      if (waiterPath) await rm(waiterPath, { force: true }).catch(() => undefined);
    }

    const token = randomUUID();
    await writeFile(this.#ownerPath, JSON.stringify({
      version: 1,
      pid: process.pid,
      token,
      created_at_ms: Date.now(),
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await this.#callHook("afterOwnerWritten", { token, lockDirectory: this.#lockDirectory });
    } catch (operationError) {
      try {
        await this.#releaseLock({ token });
      } catch (releaseError) {
        throw combinedOperationAndReleaseError(operationError, releaseError);
      }
      throw operationError;
    }
    return { token };
  }

  async #createWaiterMarker() {
    const token = randomUUID();
    const waiterPath = `${this.#lockDirectory}.waiter-${process.pid}-${token}.json`;
    await writeFile(waiterPath, JSON.stringify({ pid: process.pid, token }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return waiterPath;
  }

  async #releaseLock({ token }) {
    const owner = await this.#readOwner(this.#lockDirectory);
    if (!owner || owner.token !== token) {
      throw localLockError("STATE_LOCK_OWNERSHIP_CHANGED", "state lock ownership changed during release");
    }

    const releasePath = `${this.#lockDirectory}.release-${token}-${randomUUID()}`;
    await rename(this.#lockDirectory, releasePath);
    const movedOwner = await this.#readOwner(releasePath);
    if (!movedOwner || movedOwner.token !== token) {
      throw localLockError("STATE_LOCK_OWNERSHIP_CHANGED", "state lock ownership changed during release");
    }
    await rm(releasePath, { recursive: true });
  }

  async #readOwner(directory) {
    try {
      return parseOwner(await readFile(path.join(directory, "owner.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
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
