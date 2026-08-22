import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createHelperClient } from "../src/lovart/helper-client.js";

function fakeSpawn(script, { candidate, result = { status: "connected", code: "CONNECTED" }, delay = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = {
    writes: [],
    end() {},
    write(value) {
      this.writes.push(String(value));
      if (script === "configure" && String(value).includes('"type":"request"')) {
        setTimeout(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({
          v: 1,
          type: "candidate",
          access_key: candidate?.accessKey ?? "ak_private",
          secret_key: candidate?.secretKey ?? "sk_private",
        })}\n`)), delay);
      }
      if (script !== "configure" && String(value).includes('"type":"request"')) {
        setTimeout(() => {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({ v: 1, type: "result", ...result })}\n`));
          child.emit("close", 0);
        }, delay);
      }
      if (script === "configure" && String(value).includes('"type":"verdict"')) {
        setTimeout(() => {
          child.stdout.emit("data", Buffer.from(`${JSON.stringify({ v: 1, type: "result", ...result })}\n`));
          child.emit("close", 0);
        }, delay);
      }
    },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCount = 0;
  child.kill = () => { child.killCount += 1; child.emit("close", null); };
  child.destroy = child.kill;
  return child;
}

test("configures through the fixed operation and redacts the public result", async () => {
  const calls = [];
  const states = [];
  const client = createHelperClient({
    resolveHelper: async () => ({ path: "/plugin/native/helper" }),
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      return fakeSpawn(args[0]);
    },
  });
  const result = await client.configure({
    onState: (state) => states.push(state),
    validate: async ({ accessKey, secretKey }) => {
      assert.equal(accessKey, "ak_private");
      assert.equal(secretKey, "sk_private");
      return { accepted: true, code: "CONNECTED" };
    },
  });
  assert.deepEqual(result, { status: "connected", code: "CONNECTED" });
  assert.deepEqual(states, ["validating"]);
  assert.equal(calls[0].file, "/plugin/native/helper");
  assert.deepEqual(calls[0].args, ["configure"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("rejects duplicate candidate messages and terminates the child", async () => {
  const child = fakeSpawn("configure");
  const client = createHelperClient({
    resolveHelper: async () => ({ path: "/plugin/native/helper" }),
    spawnImpl: () => {
      queueMicrotask(() => {
        const message = JSON.stringify({ v: 1, type: "candidate", access_key: "ak", secret_key: "sk" });
        child.stdout.emit("data", Buffer.from(`${message}\n${message}\n`));
      });
      return child;
    },
  });
  await assert.rejects(client.configure({ validate: async () => ({ accepted: true, code: "CONNECTED" }) }), (error) => {
    assert.equal(error.code, "UPSTREAM_SECURITY_REJECTED");
    assert.equal(error.message.includes("ak"), false);
    return true;
  });
  assert.equal(child.killCount, 1);
});

test("terminates a helper that exceeds the protocol line limit", async () => {
  const child = fakeSpawn("status");
  const client = createHelperClient({
    resolveHelper: async () => ({ path: "/plugin/native/helper" }),
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${"x".repeat(16 * 1024 + 1)}\n`)));
      return child;
    },
  });
  await assert.rejects(client.status(), (error) => error.code === "UPSTREAM_SECURITY_REJECTED");
  assert.equal(child.killCount, 1);
});

test("reads only private helper credentials", async () => {
  const child = fakeSpawn("read", { result: { status: "connected", credentials: { access_key: "ak_private", secret_key: "sk_private" } } });
  const client = createHelperClient({
    resolveHelper: async () => ({ path: "/plugin/native/helper" }),
    spawnImpl: () => child,
  });
  const result = await client.read();
  assert.deepEqual(result, { accessKey: "ak_private", secretKey: "sk_private" });
});
