import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("macOS proxy discovery falls back to an enabled network service when scutil is empty", async () => {
  let detectSystemProxy;
  try {
    ({ detectSystemProxy } = await import("../scripts/detect-system-proxy.mjs"));
  } catch {
    detectSystemProxy = undefined;
  }
  assert.equal(typeof detectSystemProxy, "function", "system proxy detector is missing");

  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "/usr/sbin/scutil") return "<dictionary> {\n}\n";
    if (args[0] === "-listallnetworkservices") return "An asterisk (*) denotes that a network service is disabled.\nThunderbolt Bridge\nWi-Fi\n";
    if (args[1] === "Thunderbolt Bridge") return "Enabled: No\nServer: \nPort: 0\n";
    if (args[1] === "Wi-Fi") return "Enabled: Yes\nServer: 127.0.0.1\nPort: 7897\nAuthenticated Proxy Enabled: 0\n";
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  assert.equal(detectSystemProxy({ platform: "darwin", run }), "http://127.0.0.1:7897");
  assert.deepEqual(calls, [
    ["/usr/sbin/scutil", ["--proxy"]],
    ["/usr/sbin/networksetup", ["-listallnetworkservices"]],
    ["/usr/sbin/networksetup", ["-getsecurewebproxy", "Thunderbolt Bridge"]],
    ["/usr/sbin/networksetup", ["-getsecurewebproxy", "Wi-Fi"]],
  ]);
});

test("macOS proxy discovery rejects disabled and malformed network service values", async () => {
  let detectSystemProxy;
  try {
    ({ detectSystemProxy } = await import("../scripts/detect-system-proxy.mjs"));
  } catch {
    detectSystemProxy = undefined;
  }
  assert.equal(typeof detectSystemProxy, "function", "system proxy detector is missing");

  const run = (command, args) => {
    if (command === "/usr/sbin/scutil") return "<dictionary> {\n}\n";
    if (args[0] === "-listallnetworkservices") return "Wi-Fi\nUSB LAN\n";
    if (args[1] === "Wi-Fi") return "Enabled: No\nServer: proxy.invalid\nPort: 8080\n";
    return "Enabled: Yes\nServer: bad/host\nPort: 70000\n";
  };

  assert.equal(detectSystemProxy({ platform: "darwin", run }), "");
});

test("MCP launcher exports the dynamically detected proxy before starting the server", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "imvia-proxy-launcher-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fakeNode = path.join(directory, "node");
  await writeFile(fakeNode, `#!/bin/sh
case "$1" in
  *detect-system-proxy.mjs) printf 'http://proxy.test:4312'; exit 0 ;;
esac
printf '{"node_use":"%s","https":"%s","http":"%s","all":"%s","entry":"%s"}\\n' "$NODE_USE_ENV_PROXY" "$HTTPS_PROXY" "$HTTP_PROXY" "$ALL_PROXY" "$1"
`);
  await chmod(fakeNode, 0o755);

  const result = spawnSync("sh", [path.resolve("scripts/start-mcp.sh")], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      PATH: `${directory}:/usr/bin:/bin:/usr/sbin:/sbin`,
      IMVIA_PROXY_MODE: "system",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(result.stdout);
  assert.deepEqual({ ...environment, entry: undefined }, {
    node_use: "1",
    https: "http://proxy.test:4312",
    http: "http://proxy.test:4312",
    all: "http://proxy.test:4312",
    entry: undefined,
  });
  assert.equal(path.resolve(environment.entry), path.resolve("src/index.js"));
});

test("MCP launcher starts without a global node when IMVIA_NODE_BINARY is provided", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "imvia-node-launcher-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fakeNode = path.join(directory, "codex-node");
  await writeFile(fakeNode, `#!/bin/sh
printf '{"entry":"%s"}\n' "$1"
`);
  await chmod(fakeNode, 0o755);

  const result = spawnSync("sh", [path.resolve("scripts/start-mcp.sh")], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      IMVIA_NODE_BINARY: fakeNode,
      IMVIA_PROXY_MODE: "direct",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const environment = JSON.parse(result.stdout);
  assert.equal(path.resolve(environment.entry), path.resolve("src/index.js"));
});
