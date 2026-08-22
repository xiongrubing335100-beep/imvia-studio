#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function proxyUrl({ enabled, host, port }) {
  if (enabled !== "1" && enabled.toLowerCase() !== "yes") return "";
  if (!/^[a-z0-9._-]+$/i.test(host)) return "";
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || String(numericPort) !== port || numericPort < 1 || numericPort > 65535) return "";
  return `http://${host}:${numericPort}`;
}

function parseScutil(output) {
  const value = (key) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, "m"))?.[1] || "";
  return proxyUrl({ enabled: value("HTTPSEnable"), host: value("HTTPSProxy"), port: value("HTTPSPort") });
}

function parseNetworkService(output) {
  const value = (key) => output.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"))?.[1] || "";
  return proxyUrl({ enabled: value("Enabled"), host: value("Server"), port: value("Port") });
}

function defaultRun(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function detectSystemProxy({ platform = process.platform, run = defaultRun } = {}) {
  if (platform !== "darwin") return "";
  const safeRun = (command, args) => {
    try { return String(run(command, args) || ""); } catch { return ""; }
  };
  const scutilProxy = parseScutil(safeRun("/usr/sbin/scutil", ["--proxy"]));
  if (scutilProxy) return scutilProxy;

  const services = safeRun("/usr/sbin/networksetup", ["-listallnetworkservices"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("An asterisk") && !line.startsWith("*"));
  for (const service of services) {
    const candidate = parseNetworkService(safeRun("/usr/sbin/networksetup", ["-getsecurewebproxy", service]));
    if (candidate) return candidate;
  }
  return "";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(detectSystemProxy());
}
