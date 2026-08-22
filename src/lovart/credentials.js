import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHelperClient } from "./helper-client.js";
import { resolveCredentialHelper } from "./helper-manifest.js";

// Kept as deprecated identifiers for callers that imported the old names.
// Personal builds no longer read or write these Keychain coordinates; the
// native helper stores credentials in its private local file instead.
export const LOVART_KEYCHAIN_SERVICE = "ai.imvia.studio.lovart";
export const LOVART_KEYCHAIN_ACCOUNT = "credentials";
export const LOVART_LOCAL_CREDENTIAL_FILE = "lovart-credentials-v1.json";
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const MESSAGES = Object.freeze({
  CONNECTED: "Lovart is connected.",
  SETUP_REQUIRED: "Lovart credentials are not configured.",
  SETUP_CANCELLED: "Lovart connection was cancelled.",
  SETUP_INVALID: "Both Lovart keys are required.",
  HELPER_NOT_PACKAGED: "Lovart connection helper is not packaged correctly.",
  HELPER_LAUNCH_FAILED: "Lovart connection helper could not be started.",
  CREDENTIAL_STORE_DENIED: "The operating-system credential store denied access.",
  PLATFORM_UNSUPPORTED: "Lovart connection is unavailable on this platform.",
  UPSTREAM_SECURITY_REJECTED: "Lovart connection helper failed integrity verification.",
  AUTHENTICATION_FAILED: "Lovart authentication was rejected.",
  UPSTREAM_UNREACHABLE: "Lovart could not be reached for validation.",
});

function messageFor(code) { return MESSAGES[code] || "Lovart connection setup failed."; }

function publicCode(value, fallback = "SETUP_REQUIRED") {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function publicResult(value, now) {
  const status = value?.status === "connected" ? "connected" : "setup_required";
  const code = publicCode(value?.code, status === "connected" ? "CONNECTED" : "SETUP_REQUIRED");
  return {
    status,
    code,
    message: typeof value?.message === "string" && value.message.length <= 256 ? value.message : messageFor(code),
    ...(status === "connected" ? { checked_at: value?.checked_at || new Date(now()).toISOString() } : {}),
  };
}

function errorFor(code) {
  const error = new Error(messageFor(code));
  error.code = code;
  return error;
}

export function createCredentialService({
  helperClient: providedHelperClient,
  pluginRoot = PLUGIN_ROOT,
  platform = process.platform,
  arch = process.arch,
  now = () => Date.now(),
} = {}) {
  const helperClient = providedHelperClient ?? createHelperClient({
    resolveHelper: () => resolveCredentialHelper({ pluginRoot, platform, arch }),
  });

  function unsupported() {
    return { status: "unsupported", code: "PLATFORM_UNSUPPORTED", message: messageFor("PLATFORM_UNSUPPORTED") };
  }

  async function status() {
    if (!((platform === "darwin" || platform === "win32") && (arch === "arm64" || arch === "x64"))) return unsupported();
    try {
      return publicResult(await helperClient.status(), now);
    } catch (error) {
      const code = publicCode(error?.code, "HELPER_NOT_PACKAGED");
      return { status: "setup_required", code, message: messageFor(code) };
    }
  }

  async function getCredentials() {
    if (!((platform === "darwin" || platform === "win32") && (arch === "arm64" || arch === "x64"))) throw errorFor("PLATFORM_UNSUPPORTED");
    try {
      const pair = await helperClient.read();
      if (!pair?.accessKey?.trim() || !pair?.secretKey?.trim()) throw errorFor("SETUP_REQUIRED");
      return { accessKey: pair.accessKey.trim(), secretKey: pair.secretKey.trim() };
    } catch (error) {
      if (error?.code) throw error;
      throw errorFor("SETUP_REQUIRED");
    }
  }

  async function connect({ validate, onState } = {}) {
    if (!((platform === "darwin" || platform === "win32") && (arch === "arm64" || arch === "x64"))) return unsupported();
    if (typeof validate !== "function") throw new TypeError("validate is required");
    try {
      const result = await helperClient.configure({
        onState,
        validate: async (credentials) => {
          const verdict = await validate(credentials);
          if (!verdict || typeof verdict.accepted !== "boolean") return { accepted: false, code: "SETUP_INVALID" };
          return {
            accepted: verdict.accepted,
            code: publicCode(verdict.code, verdict.accepted ? "CONNECTED" : "AUTHENTICATION_FAILED"),
            ...(typeof verdict.message === "string" ? { message: verdict.message } : {}),
          };
        },
      });
      return publicResult(result, now);
    } catch (error) {
      const code = publicCode(error?.code, "HELPER_LAUNCH_FAILED");
      return { status: "setup_required", code, message: messageFor(code) };
    }
  }

  async function clear() {
    if (!((platform === "darwin" || platform === "win32") && (arch === "arm64" || arch === "x64"))) return unsupported();
    try { return publicResult(await helperClient.clear(), now); }
    catch (error) {
      const code = publicCode(error?.code, "CREDENTIAL_STORE_DENIED");
      return { status: "setup_required", code, message: messageFor(code) };
    }
  }

  return Object.freeze({ status, connect, getCredentials, clear });
}
