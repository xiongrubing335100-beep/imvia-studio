import { DomainError } from "./errors.js";

export const CANONICAL_UTC_TIMESTAMP_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
export const MAX_SOURCE_CLOCK_SKEW_MS = 5 * 60_000;

export function assertCanonicalUtcTimestamp(value, { field = "timestamp" } = {}) {
  const milliseconds = typeof value === "string" && CANONICAL_UTC_TIMESTAMP_PATTERN.test(value)
    ? Date.parse(value)
    : Number.NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new DomainError("VALIDATION_FAILED", "Timestamp must use canonical UTC ISO format with millisecond precision.", { field });
  }
  return value;
}

export function assertSourceCheckedAt(value, { field = "checked_at", now = Date.now() } = {}) {
  const canonical = assertCanonicalUtcTimestamp(value, { field });
  if (Date.parse(canonical) > now + MAX_SOURCE_CLOCK_SKEW_MS) {
    throw new DomainError("VALIDATION_FAILED", "Source checked time cannot be more than five minutes in the future.", { field });
  }
  return canonical;
}

export function assertExpiryAtOrAfterChecked(expiresAt, checkedAt, { field = "expires_at" } = {}) {
  if (expiresAt == null) return null;
  const canonical = assertCanonicalUtcTimestamp(expiresAt, { field });
  if (Date.parse(canonical) < Date.parse(checkedAt)) {
    throw new DomainError("VALIDATION_FAILED", "Expiry cannot be earlier than the checked time.", { field });
  }
  return canonical;
}
