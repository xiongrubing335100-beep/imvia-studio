import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

import { DomainError } from "../domain/errors.js";
import { copyValidatedProbeSummary } from "./summary-validator.js";

const DEFAULT_CHILD_PATH = fileURLToPath(new URL("./child.js", import.meta.url));
const CHILD_TIMEOUT_MS = 40_000;
const MAX_STDOUT_BYTES = 65_536;
const MAX_STDERR_BYTES = 4_096;
const FAILURE_MESSAGES = Object.freeze({
  CREDENTIAL_REFERENCE_UNAVAILABLE: "Lovart credential reference is unavailable",
  UPSTREAM_UNREACHABLE: "Lovart upstream is unreachable",
  UPSTREAM_SECURITY_REJECTED: "Lovart upstream security check failed",
  AUTHENTICATION_FAILED: "Lovart authentication was rejected",
  UPSTREAM_RATE_LIMITED: "Lovart upstream rate limit was reached",
  UPSTREAM_UNAVAILABLE: "Lovart upstream is unavailable",
  UPSTREAM_SCHEMA_UNRECOGNIZED: "Lovart upstream response was not recognized",
});

function stableFailure(code = "UPSTREAM_UNREACHABLE") {
  return new DomainError(code, FAILURE_MESSAGES[code]);
}

function hasExactKeys(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseEnvelope(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(bytes));
  const envelope = JSON.parse(text);
  if (envelope?.ok === true && hasExactKeys(envelope, ["ok", "result"])) {
    return { kind: "success", result: copyValidatedProbeSummary(envelope.result) };
  }
  if (envelope?.ok === false && hasExactKeys(envelope, ["error", "ok"])
    && hasExactKeys(envelope.error, ["code", "message"])
    && Object.hasOwn(FAILURE_MESSAGES, envelope.error.code)
    && envelope.error.message === FAILURE_MESSAGES[envelope.error.code]) {
    return { kind: "error", code: envelope.error.code };
  }
  throw new Error("invalid child envelope");
}

export function createProbeChildRunner({
  nodePath = process.execPath,
  childPath = DEFAULT_CHILD_PATH,
  spawnProcess = spawn,
} = {}) {
  if (!isAbsolute(nodePath) || !isAbsolute(childPath)) {
    throw new TypeError("probe child executable paths must be absolute");
  }

  return {
    run() {
      return new Promise((resolve, reject) => {
        let child;
        let settled = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdout = [];
        let watchdog;

        const clearWatchdog = () => {
          if (watchdog === undefined) return;
          clearTimeout(watchdog);
          watchdog = undefined;
        };
        const settleRejected = (code = "UPSTREAM_UNREACHABLE", kill = false) => {
          if (settled) return;
          settled = true;
          clearWatchdog();
          if (kill) {
            try {
              child?.kill("SIGKILL");
            } catch {
              // The public outcome is the same if an already-failed child cannot be killed.
            }
          }
          reject(stableFailure(code));
        };
        const rejectRedacted = () => settleRejected();
        const killAndReject = () => settleRejected("UPSTREAM_UNREACHABLE", true);

        try {
          watchdog = setTimeout(killAndReject, CHILD_TIMEOUT_MS);
          child = spawnProcess(nodePath, [childPath], {
            shell: false,
            env: { LANG: "C", LC_ALL: "C" },
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          rejectRedacted();
          return;
        }

        if (!child?.stdout?.on || !child?.stderr?.on || !child?.on) {
          killAndReject();
          return;
        }

        child.stdout.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stdoutBytes += bytes.byteLength;
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            killAndReject();
            return;
          }
          stdout.push(bytes);
        });
        child.stderr.on("data", (chunk) => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stderrBytes += bytes.byteLength;
          if (stderrBytes > MAX_STDERR_BYTES) killAndReject();
        });
        child.stdout.on("error", killAndReject);
        child.stderr.on("error", killAndReject);
        child.on("error", killAndReject);
        child.once("close", (code, signal) => {
          if (settled) return;
          if (code !== 0 || signal !== null || stderrBytes !== 0) {
            rejectRedacted();
            return;
          }
          let parsed;
          try {
            parsed = parseEnvelope(stdout);
          } catch {
            rejectRedacted();
            return;
          }
          if (parsed.kind === "error") {
            settleRejected(parsed.code);
            return;
          }
          settled = true;
          clearWatchdog();
          resolve(parsed.result);
        });
      });
    },
  };
}
