import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class JsonStore {
  #queue = Promise.resolve();

  constructor({ dataDirectory, createInitialState, stateFileName = "state.json" }) {
    if (path.basename(stateFileName) !== stateFileName || !stateFileName.endsWith(".json")) {
      throw new TypeError("stateFileName must be a local .json filename");
    }
    this.dataDirectory = dataDirectory;
    this.createInitialState = createInitialState;
    this.statePath = path.join(dataDirectory, stateFileName);
  }

  async read() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    try {
      return clone(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const initial = this.createInitialState();
      await this.#write(initial);
      return clone(initial);
    }
  }

  async update(mutator) {
    const operation = this.#queue.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.#write(state);
      return clone(result);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #write(state) {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}
