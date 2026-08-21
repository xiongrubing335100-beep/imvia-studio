import { execFile as defaultExecFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const LOVART_KEYCHAIN_SERVICE = "ai.imvia.studio.lovart";
export const LOVART_ACCESS_ACCOUNT = "access-key";
export const LOVART_SECRET_ACCOUNT = "secret-key";

const HELPER_PATH = fileURLToPath(new URL("../../scripts/configure-lovart.swift", import.meta.url));
const execFile = promisify(defaultExecFile);

const MESSAGES = Object.freeze({
  CREDENTIAL_SETUP_CANCELLED: "Lovart connection was cancelled.",
  CREDENTIAL_SETUP_INVALID: "Both Lovart keys are required.",
  CREDENTIAL_SETUP_FAILED: "Lovart connection setup failed.",
  CREDENTIAL_REFERENCE_UNAVAILABLE: "Lovart credentials are not configured.",
  PLATFORM_UNSUPPORTED: "Lovart connection setup requires macOS.",
});

function messageFor(code) {
  return MESSAGES[code] || MESSAGES.CREDENTIAL_SETUP_FAILED;
}

function isCredentialPair(value) {
  return Boolean(
    value
      && typeof value === "object"
      && typeof value.accessKey === "string"
      && value.accessKey.trim()
      && typeof value.secretKey === "string"
      && value.secretKey.trim(),
  );
}

async function runNativeHelper({ mode = "configure", exec = execFile, helperPath = HELPER_PATH } = {}) {
  try {
    const result = await exec("swift", [helperPath, mode], {
      encoding: "utf8",
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(result.stdout ?? result).trim();
  } catch (error) {
    const output = String(error?.stdout ?? "").trim();
    if (output) return output;
    throw error;
  }
}

async function defaultRunHelper() {
  const output = await runNativeHelper({ mode: "configure" });
  if (output === "Lovart credentials saved.") return { configured: true };
  if (output === "Lovart connection cancelled.") {
    return { configured: false, code: "CREDENTIAL_SETUP_CANCELLED" };
  }
  if (output === "Lovart keys are required.") {
    return { configured: false, code: "CREDENTIAL_SETUP_INVALID" };
  }
  return { configured: false, code: "CREDENTIAL_SETUP_FAILED" };
}

async function defaultReadKeychain() {
  const output = await runNativeHelper({ mode: "read" });
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    return { accessKey: "", secretKey: "" };
  }
  return {
    accessKey: typeof payload.accessKey === "string" ? payload.accessKey : "",
    secretKey: typeof payload.secretKey === "string" ? payload.secretKey : "",
  };
}

export function createCredentialService({
  platform = process.platform,
  runHelper = defaultRunHelper,
  readKeychain = defaultReadKeychain,
  now = () => Date.now(),
} = {}) {
  const unsupported = () => ({
    status: "unsupported",
    code: "PLATFORM_UNSUPPORTED",
    message: messageFor("PLATFORM_UNSUPPORTED"),
  });

  async function getCredentials() {
    if (platform !== "darwin") {
      const error = new Error(messageFor("PLATFORM_UNSUPPORTED"));
      error.code = "PLATFORM_UNSUPPORTED";
      throw error;
    }
    let credentials;
    try {
      credentials = await readKeychain();
    } catch {
      const error = new Error(messageFor("CREDENTIAL_REFERENCE_UNAVAILABLE"));
      error.code = "CREDENTIAL_REFERENCE_UNAVAILABLE";
      throw error;
    }
    if (!isCredentialPair(credentials)) {
      const error = new Error(messageFor("CREDENTIAL_REFERENCE_UNAVAILABLE"));
      error.code = "CREDENTIAL_REFERENCE_UNAVAILABLE";
      throw error;
    }
    return {
      accessKey: credentials.accessKey.trim(),
      secretKey: credentials.secretKey.trim(),
    };
  }

  async function status() {
    if (platform !== "darwin") return unsupported();
    try {
      await getCredentials();
      return { status: "connected", checked_at: new Date(now()).toISOString() };
    } catch (error) {
      const code = error?.code === "PLATFORM_UNSUPPORTED"
        ? "PLATFORM_UNSUPPORTED"
        : "CREDENTIAL_REFERENCE_UNAVAILABLE";
      return { status: "not_connected", code, message: messageFor(code) };
    }
  }

  async function connect() {
    if (platform !== "darwin") return unsupported();
    let setup;
    try {
      setup = await runHelper();
    } catch {
      return {
        status: "not_connected",
        code: "CREDENTIAL_SETUP_FAILED",
        message: messageFor("CREDENTIAL_SETUP_FAILED"),
      };
    }
    if (!setup?.configured) {
      const code = ["CREDENTIAL_SETUP_CANCELLED", "CREDENTIAL_SETUP_INVALID", "CREDENTIAL_SETUP_FAILED"].includes(setup?.code)
        ? setup.code
        : "CREDENTIAL_SETUP_INVALID";
      return { status: "not_connected", code, message: messageFor(code) };
    }
    return status();
  }

  return Object.freeze({ connect, status, getCredentials });
}

export function credentialHelperPath() {
  return path.resolve(HELPER_PATH);
}
