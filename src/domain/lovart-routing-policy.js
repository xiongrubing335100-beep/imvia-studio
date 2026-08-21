import { DomainError } from "./errors.js";

export function resolveGenerationProvider({ activation = null } = {}) {
  if (!activation || typeof activation !== "object") return "codex_imagegen";
  if (activation.source === "codex_explicit" || activation.source === "workbench_action") return "lovart";
  if (activation.source === "codex_context_continuation" && (activation.parent_job_id || activation.artifact_id)) return "lovart";
  if (activation.source === "codex_context_continuation") throw new DomainError("INVALID_CONTINUATION_PARENT", "Context continuation requires a parent job or artifact.");
  return "codex_imagegen";
}

export function assertSingleProvider(provider) {
  if (provider !== "lovart" && provider !== "codex_imagegen") throw new DomainError("PROVIDER_SELECTION_INVALID", "A request must select exactly one generation provider.");
  return provider;
}
