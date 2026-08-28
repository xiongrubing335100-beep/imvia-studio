import { spawn as defaultSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const OPERATIONS = new Set(["status", "configure", "read", "clear"]);
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELD_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const PUBLIC_CODES = new Set([
  "CONNECTED", "SETUP_REQUIRED", "SETUP_CANCELLED", "SETUP_INVALID", "HELPER_NOT_PACKAGED",
  "HELPER_LAUNCH_FAILED", "CREDENTIAL_STORE_DENIED", "PLATFORM_UNSUPPORTED",
  "UPSTREAM_SECURITY_REJECTED", "AUTHENTICATION_FAILED", "UPSTREAM_UNREACHABLE",
  "CREDENTIAL_SETUP_FAILED",
]);

const MESSAGES = Object.freeze({
  HELPER_NOT_PACKAGED: "Lovart connection helper is not packaged correctly.",
  HELPER_LAUNCH_FAILED: "Lovart connection helper could not be started.",
  UPSTREAM_SECURITY_REJECTED: "Lovart connection helper returned an invalid response.",
  CREDENTIAL_SETUP_FAILED: "Lovart connection setup failed.",
  VALIDATION_FAILED: "Credential profile options are invalid.",
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
  if (PUBLIC_CODES.has(message.code)) result.code = message.code;
  if (typeof message.checked_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(message.checked_at)) result.checked_at = message.checked_at;
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

function validationFailure() { return stableFailure("VALIDATION_FAILED"); }

function validateProfileOptions(operation, profileId, fields) {
  const dynamic = profileId !== undefined || fields !== undefined;
  if (!dynamic) return { profileId: undefined, fields: undefined };
  if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId) || profileId === "." || profileId === "..") {
    throw validationFailure();
  }
  if (fields === undefined) {
    if (operation === "configure") throw validationFailure();
    return { profileId, fields: undefined };
  }
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 32) throw validationFailure();
  const seen = new Set();
  const normalized = fields.map((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)
      || Object.keys(field).some((key) => !["id", "label", "secret", "required"].includes(key))
      || typeof field.id !== "string" || !FIELD_ID_PATTERN.test(field.id) || seen.has(field.id)
      || typeof field.label !== "string" || !field.label.trim() || field.label.trim().length > 128
      || typeof field.secret !== "boolean" || typeof field.required !== "boolean") {
      throw validationFailure();
    }
    seen.add(field.id);
    return { id: field.id, label: field.label.trim(), secret: field.secret, required: field.required };
  });
  return { profileId, fields: normalized };
}

function dynamicValues(message, fields) {
  const values = message?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw validationFailure();
  const output = {};
  const allowed = fields ? new Map(fields.map((field) => [field.id, field])) : null;
  for (const [key, value] of Object.entries(values)) {
    if (!FIELD_ID_PATTERN.test(key) || (allowed && !allowed.has(key)) || typeof value !== "string") throw validationFailure();
    const trimmed = value.trim();
    if (trimmed) output[key] = trimmed;
  }
  if (allowed) {
    for (const field of fields) if (field.required && !output[field.id]) throw validationFailure();
  }
  if (Object.keys(output).length === 0) throw validationFailure();
  return output;
}

export function createHelperClient({
  resolveHelper,
  spawnImpl = defaultSpawn,
  requestId = randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof resolveHelper !== "function") throw new TypeError("resolveHelper is required");

  async function run(operation, { validate, onState, timeout = timeoutMs, profileId, fields } = {}) {
    if (!OPERATIONS.has(operation)) throw new TypeError("unsupported helper operation");
    const profile = validateProfileOptions(operation, profileId, fields);
    const isDynamic = profile.profileId !== undefined;
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
          let credentials;
          if (isDynamic) {
            try { credentials = dynamicValues(message, profile.fields); } catch { return protocolFailure(); }
          } else {
            const accessKey = typeof message.access_key === "string" ? message.access_key : message.accessKey;
            const secretKey = typeof message.secret_key === "string" ? message.secret_key : message.secretKey;
            if (!accessKey?.trim() || !secretKey?.trim()) return protocolFailure();
            credentials = { accessKey, secretKey };
          }
          try {
            if (typeof onState === "function") onState("validating");
            const verdict = await validate(credentials);
            if (!verdict || typeof verdict.accepted !== "boolean" || typeof verdict.code !== "string") return protocolFailure();
            writeLine(child, {
              v: 1,
              type: "verdict",
              request_id: requestId(),
              accepted: verdict.accepted,
              code: verdict.code,
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
          if (isDynamic) {
            try { finish(null, dynamicValues(message)); } catch { protocolFailure(); }
            return;
          }
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
      // Credential entry is user-driven and may legitimately take longer than
      // the background protocol timeout. Keep the native dialog alive until
      // the user submits or cancels it; status/read/clear remain bounded.
      if (operation !== "configure") {
        timer = setTimeout(() => finish(stableFailure("HELPER_LAUNCH_FAILED")), Math.max(1, Number(timeout) || DEFAULT_TIMEOUT_MS));
      }
      try {
        writeLine(child, {
          v: 1,
          type: "request",
          op: operation,
          request_id: requestId(),
          ...(isDynamic ? { profile_id: profile.profileId } : {}),
          ...(profile.fields ? { fields: profile.fields } : {}),
        });
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
