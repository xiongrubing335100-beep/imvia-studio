import { execFile as defaultExecFile } from "node:child_process";

import { DomainError } from "../domain/errors.js";
import {
  KEYCHAIN_ACCESS_ACCOUNT,
  KEYCHAIN_SECRET_ACCOUNT,
  KEYCHAIN_SERVICE,
} from "./constants.js";

const SECURITY_PATH = "/usr/bin/security";
const EXEC_OPTIONS = Object.freeze({ encoding: "utf8", maxBuffer: 4096, shell: false });

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
    execFile(SECURITY_PATH, args, EXEC_OPTIONS, (error, stdout) => {
      if (error) {
        reject(credentialFailure());
        return;
      }
      if (typeof stdout !== "string") {
        reject(credentialFailure());
        return;
      }
      const value = stdout.replace(/(?:\r\n|\n)$/, "");
      if (value.length === 0) {
        reject(credentialFailure());
        return;
      }
      resolve(value);
    });
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
