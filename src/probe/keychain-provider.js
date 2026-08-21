import { execFile as defaultExecFile } from "node:child_process";

import { DomainError } from "../domain/errors.js";
import {
  KEYCHAIN_ACCESS_ACCOUNT,
  KEYCHAIN_SECRET_ACCOUNT,
  KEYCHAIN_SERVICE,
} from "./constants.js";

const SECURITY_PATH = "/usr/bin/security";
const KEYCHAIN_TIMEOUT_MS = 15_000;
const EXEC_OPTIONS = Object.freeze({
  encoding: "utf8",
  killSignal: "SIGKILL",
  maxBuffer: 4096,
  shell: false,
  timeout: KEYCHAIN_TIMEOUT_MS,
});

function credentialFailure() {
  return new DomainError(
    "CREDENTIAL_REFERENCE_UNAVAILABLE",
    "Lovart credential reference is unavailable",
  );
}

function readAccount(execFile, account) {
  const args = [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    account,
    "-w",
  ];
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let watchdog;
    const finish = (error, value, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (kill) {
        try {
          child?.kill("SIGKILL");
        } catch {
          // The public outcome is the same if a timed-out lookup cannot be killed.
        }
      }
      if (error) {
        reject(credentialFailure());
        return;
      }
      resolve(value);
    };

    try {
      watchdog = setTimeout(() => finish(true, undefined, true), KEYCHAIN_TIMEOUT_MS);
      child = execFile(SECURITY_PATH, args, EXEC_OPTIONS, (error, stdout) => {
        if (error || typeof stdout !== "string") {
          finish(true);
          return;
        }
        const value = stdout.replace(/(?:\r\n|\n)$/, "");
        finish(value.length === 0, value);
      });
    } catch {
      finish(true);
    }
  });
}

export async function readProbeCredentials({
  execFile = defaultExecFile,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") throw credentialFailure();

  try {
    const accessKey = await readAccount(execFile, KEYCHAIN_ACCESS_ACCOUNT);
    const secretKey = await readAccount(execFile, KEYCHAIN_SECRET_ACCOUNT);
    return { accessKey, secretKey };
  } catch {
    throw credentialFailure();
  }
}
