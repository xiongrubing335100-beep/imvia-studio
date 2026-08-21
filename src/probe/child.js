import { normalizeLovartCapabilities } from "./capability-normalizer.js";
import { runReadOnlyProbe } from "./child-core.js";
import { readProbeCredentials } from "./keychain-provider.js";
import { requestLovartModeQuery } from "./transport.js";

const FAILURE_MESSAGES = Object.freeze({
  CREDENTIAL_REFERENCE_UNAVAILABLE: "Lovart credential reference is unavailable",
  UPSTREAM_UNREACHABLE: "Lovart upstream is unreachable",
  UPSTREAM_SECURITY_REJECTED: "Lovart upstream security check failed",
  AUTHENTICATION_FAILED: "Lovart authentication was rejected",
  UPSTREAM_RATE_LIMITED: "Lovart upstream rate limit was reached",
  UPSTREAM_UNAVAILABLE: "Lovart upstream is unavailable",
  UPSTREAM_SCHEMA_UNRECOGNIZED: "Lovart upstream response was not recognized",
});

function failureEnvelope(error) {
  const code = Object.hasOwn(FAILURE_MESSAGES, error?.code)
    ? error.code
    : "UPSTREAM_UNREACHABLE";
  return { ok: false, error: { code, message: FAILURE_MESSAGES[code] } };
}

let envelope;
try {
  const result = await runReadOnlyProbe({
    keychainProvider: readProbeCredentials,
    transport: requestLovartModeQuery,
    normalizer: normalizeLovartCapabilities,
  });
  envelope = { ok: true, result };
} catch (error) {
  envelope = failureEnvelope(error);
}

let output;
try {
  output = JSON.stringify(envelope);
} catch {
  output = JSON.stringify(failureEnvelope());
}
process.stdout.write(output);
