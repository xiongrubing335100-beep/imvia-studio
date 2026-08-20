import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProbeStore } from "../src/probe/probe-store.js";

test("probe state starts isolated and disabled", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-probe-store-"));
  const state = await createProbeStore({ dataDirectory }).read();
  assert.deepEqual(state, {
    version: 1,
    enabled: false,
    authorizations: [],
    attempts: [],
    audit_events: [],
  });
});
