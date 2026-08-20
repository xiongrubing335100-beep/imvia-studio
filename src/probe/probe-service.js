import { DomainError } from "../domain/errors.js";

const FAILURE_MESSAGES = Object.freeze({
  CREDENTIAL_REFERENCE_UNAVAILABLE: "Lovart credential reference is unavailable",
  UPSTREAM_UNREACHABLE: "Lovart upstream is unreachable",
  UPSTREAM_SECURITY_REJECTED: "Lovart upstream security check failed",
  AUTHENTICATION_FAILED: "Lovart authentication was rejected",
  UPSTREAM_RATE_LIMITED: "Lovart upstream rate limit was reached",
  UPSTREAM_UNAVAILABLE: "Lovart upstream is unavailable",
  UPSTREAM_SCHEMA_UNRECOGNIZED: "Lovart upstream response was not recognized",
  STORE_UNAVAILABLE: "Lovart probe state is unavailable",
});

function stableProbeCode(code) {
  return Object.hasOwn(FAILURE_MESSAGES, code) ? code : "UPSTREAM_UNREACHABLE";
}

export function createLovartProbeService({ authorizationService, runner, platform = process.platform }) {
  return {
    authorize: (input) => authorizationService.authorize(input),

    async probe(input) {
      if (platform !== "darwin") {
        throw new DomainError(
          "PLATFORM_UNSUPPORTED",
          "Lovart read-only probe requires macOS Keychain",
          { authenticated: null },
        );
      }

      const claim = await authorizationService.beginProbe(input);
      if (claim.kind === "replay") return claim.result;

      try {
        const result = await runner.run();
        return await authorizationService.completeProbe({ attempt_id: claim.attempt_id, result });
      } catch (error) {
        const code = stableProbeCode(error?.code);
        try {
          await authorizationService.failProbe({ attempt_id: claim.attempt_id, code });
        } catch {
          // Claim consumption remains authoritative even if recording the failure is unavailable.
        }
        throw new DomainError(code, FAILURE_MESSAGES[code], {
          authenticated: code === "AUTHENTICATION_FAILED" ? false : null,
        });
      }
    },
  };
}
