import { DomainError } from "./errors.js";

const M5_SOURCE = /^(imvia|fixture|mock_lovart):[a-z0-9._-]+$/;

export function isAllowedM5Source(source, { allowUser = false } = {}) {
  if (allowUser && source === "user:current_session") return true;
  return typeof source === "string" && M5_SOURCE.test(source);
}

export function assertM5Source(source, { allowUser = false, field = "source" } = {}) {
  if (!isAllowedM5Source(source, { allowUser })) {
    throw new DomainError("VALIDATION_FAILED", "Source is not allowed in Milestone 5.", { field, source });
  }
  return source;
}
