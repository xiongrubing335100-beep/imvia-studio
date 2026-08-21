import { DomainError } from "../domain/errors.js";

const FAILURE_MESSAGES = Object.freeze({
  CREDENTIAL_REFERENCE_UNAVAILABLE: "Lovart credential reference is unavailable",
  UPSTREAM_UNREACHABLE: "Lovart upstream is unreachable",
  UPSTREAM_SECURITY_REJECTED: "Lovart upstream security check failed",
  AUTHENTICATION_FAILED: "Lovart authentication was rejected",
  UPSTREAM_RATE_LIMITED: "Lovart upstream rate limit was reached",
  UPSTREAM_UNAVAILABLE: "Lovart upstream is unavailable",
  UPSTREAM_SCHEMA_UNRECOGNIZED: "Lovart upstream response was not recognized",
});

function stableFailure(code) {
  const stableCode = Object.hasOwn(FAILURE_MESSAGES, code) ? code : "UPSTREAM_UNREACHABLE";
  return new DomainError(stableCode, FAILURE_MESSAGES[stableCode]);
}

function credentialsArePresent(value) {
  return value
    && typeof value.accessKey === "string" && value.accessKey.length > 0
    && typeof value.secretKey === "string" && value.secretKey.length > 0;
}

export async function runReadOnlyProbe({
  keychainProvider,
  transport,
  normalizer,
  now = Date.now,
}) {
  let credentials;
  try {
    credentials = await keychainProvider();
    if (!credentialsArePresent(credentials)) throw stableFailure("CREDENTIAL_REFERENCE_UNAVAILABLE");
  } catch {
    credentials = undefined;
    throw stableFailure("CREDENTIAL_REFERENCE_UNAVAILABLE");
  }

  let raw;
  try {
    raw = await transport(credentials);
    credentials = undefined;
    const checkedAtMs = now();
    const summary = normalizer(raw, { checkedAtMs });
    raw = undefined;
    return summary;
  } catch (error) {
    credentials = undefined;
    raw = undefined;
    throw stableFailure(error?.code);
  }
}
