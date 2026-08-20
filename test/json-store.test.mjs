import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStore } from "../src/persistence/json-store.js";

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
