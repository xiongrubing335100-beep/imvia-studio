import { spawn as defaultSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const OPERATIONS = new Set(["status", "configure", "read", "clear"]);

const MESSAGES = Object.freeze({
  HELPER_NOT_PACKAGED: "Lovart connection helper is not packaged correctly.",
  HELPER_LAUNCH_FAILED: "Lovart connection helper could not be started.",
  UPSTREAM_SECURITY_REJECTED: "Lovart connection helper returned an invalid response.",
  CREDENTIAL_SETUP_FAILED: "Lovart connection setup failed.",
});

function stableFailure(code) {
  const error = new Error(MESSAGES[code] ?? MESSAGES.UPSTREAM_SECURITY_REJECTED);
  error.code = code;
  return error;
}

function redactedEnvelope(message) {
  const allowedStatuses = new Set(["connected", "setup_required", "setup_active", "not_connected", "unsupported"]);
  if (!allowedStatuses.has(message.status)) throw stableFailure("UPSTREAM_SECURITY_REJECTED");
  const result = { status: message.status };
  if (typeof message.code === "string" && message.code.length <= 64) result.code = message.code;
  if (typeof message.checked_at === "string" && message.checked_at.length <= 64) result.checked_at = message.checked_at;
  if (typeof message.message === "string" && message.message.length <= 256) result.message = message.message;
  return result;
}

function localeEnvironment() {
  const env = {};
  // Pass only locale and path metadata. The local-file helper needs the
  // selected data directory, but arbitrary environment variables (especially
  // secrets) must never be inherited.
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE"]) {
    if (typeof process.env[name] === "string" && process.env[name].length <= 64) env[name] = process.env[name];
  }
  for (const name of ["HOME", "APPDATA", "USERPROFILE", "IMVIA_DATA_DIR"]) {
    if (typeof process.env[name] === "string" && process.env[name].length <= 1024) env[name] = process.env[name];
  }
  return env;
}

function writeLine(child, message) {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw stableFailure("UPSTREAM_SECURITY_REJECTED");
  try {
    child.stdin.write(line);
  } catch {
    throw stableFailure("HELPER_LAUNCH_FAILED");
  }
}

function terminate(child) {
  try {
    if (typeof child.kill === "function") child.kill();
    else if (typeof child.destroy === "function") child.destroy();
  } catch {
    // The public failure remains stable even if a crashed child cannot be killed.
  }
}

export function createHelperClient({
  resolveHelper,
  spawnImpl = defaultSpawn,
  requestId = randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof resolveHelper !== "function") throw new TypeError("resolveHelper is required");

  async function run(operation, { validate, onState, timeout = timeoutMs } = {}) {
    if (!OPERATIONS.has(operation)) throw new TypeError("unsupported helper operation");
    const helper = await resolveHelper();
    if (!helper?.path || typeof helper.path !== "string") throw stableFailure("HELPER_NOT_PACKAGED");

    let child;
    try {
      child = spawnImpl(helper.path, [operation], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: localeEnvironment(),
      });
    } catch {
      throw stableFailure("HELPER_LAUNCH_FAILED");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let candidateSeen = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) {
          terminate(child);
          reject(error);
        } else {
          resolve(value);
        }
      };
      const protocolFailure = () => finish(stableFailure("UPSTREAM_SECURITY_REJECTED"));
      const handleMessage = async (message) => {
        if (!message || message.v !== 1 || typeof message.type !== "string") return protocolFailure();
        if (message.type === "candidate" && operation === "configure") {
          if (candidateSeen || typeof validate !== "function") return protocolFailure();
          candidateSeen = true;
          const accessKey = typeof message.access_key === "string" ? message.access_key : message.accessKey;
          const secretKey = typeof message.secret_key === "string" ? message.secret_key : message.secretKey;
          if (!accessKey?.trim() || !secretKey?.trim()) return protocolFailure();
          try {
            if (typeof onState === "function") onState("validating");
            const verdict = await validate({ accessKey, secretKey });
            if (!verdict || typeof verdict.accepted !== "boolean" || typeof verdict.code !== "string") return protocolFailure();
            writeLine(child, {
              v: 1,
              type: "verdict",
              request_id: requestId(),
              accepted: verdict.accepted,
              code: verdict.code,
              ...(typeof verdict.message === "string" ? { message: verdict.message.slice(0, 256) } : {}),
            });
          } catch (error) {
            const code = typeof error?.code === "string" && error.code.length <= 64 ? error.code : "CREDENTIAL_SETUP_FAILED";
            try {
              writeLine(child, { v: 1, type: "verdict", request_id: requestId(), accepted: false, code });
            } catch {
              protocolFailure();
            }
          }
          return;
        }
        if (message.type !== "result") return protocolFailure();
        if (operation === "read") {
          const credentials = message.credentials;
          if (!credentials || typeof credentials !== "object") return protocolFailure();
          const accessKey = typeof credentials.access_key === "string" ? credentials.access_key : credentials.accessKey;
          const secretKey = typeof credentials.secret_key === "string" ? credentials.secret_key : credentials.secretKey;
          if (!accessKey?.trim() || !secretKey?.trim()) return protocolFailure();
          finish(null, { accessKey, secretKey });
          return;
        }
        try {
          finish(null, redactedEnvelope(message));
        } catch {
          protocolFailure();
        }
      };
      const consume = (chunk) => {
        if (settled) return;
        buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES && !buffer.includes("\n")) return protocolFailure();
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return protocolFailure();
          let message;
          try { message = JSON.parse(line); } catch { return protocolFailure(); }
          void handleMessage(message);
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", () => {});
      child.once?.("error", () => finish(stableFailure("HELPER_LAUNCH_FAILED")));
      child.once?.("close", (code) => {
        if (!settled && code !== 0) finish(stableFailure("HELPER_LAUNCH_FAILED"));
        else if (!settled && buffer) finish(stableFailure("UPSTREAM_SECURITY_REJECTED"));
      });
      timer = setTimeout(() => finish(stableFailure("HELPER_LAUNCH_FAILED")), Math.max(1, Number(timeout) || DEFAULT_TIMEOUT_MS));
      try {
        writeLine(child, { v: 1, type: "request", op: operation, request_id: requestId() });
      } catch (error) {
        finish(error?.code ? error : stableFailure("HELPER_LAUNCH_FAILED"));
      }
    });
  }

  return Object.freeze({
    status: (options) => run("status", options),
    configure: (options) => run("configure", options),
    read: (options) => run("read", options),
    clear: (options) => run("clear", options),
  });
}

export { MAX_LINE_BYTES };
