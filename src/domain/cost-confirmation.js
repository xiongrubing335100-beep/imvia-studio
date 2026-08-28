import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import { assertM5Source } from "./source-policy.js";
import { assertSourceCheckedAt } from "./timestamps.js";

export function createCostFingerprint({ job_id, attempt, amount, unit, checked_at, source, unknown = false, provider_id = null }) {
  assertM5Source(source);
  if (typeof job_id !== "string" || !job_id || !Number.isInteger(attempt) || attempt < 1 || (unknown
    ? amount != null || unit != null
    : !Number.isFinite(amount) || amount < 0 || typeof unit !== "string" || !unit)) {
    throw new DomainError("VALIDATION_FAILED", "A complete sourced cost is required.", { field: "estimated_cost" });
  }
  if (unknown && (typeof provider_id !== "string" || !provider_id)) {
    throw new DomainError("VALIDATION_FAILED", "An unknown cost requires its immutable provider id.", { field: "provider_id" });
  }
  const canonicalCheckedAt = assertSourceCheckedAt(checked_at, { field: "checked_at" });
  const canonical = JSON.stringify(unknown
    ? { job_id, attempt, provider_id, unknown: true, checked_at: canonicalCheckedAt, source }
    : { job_id, attempt, amount, unit, checked_at: canonicalCheckedAt, source });
  return createHash("sha256").update(canonical).digest("hex");
}
