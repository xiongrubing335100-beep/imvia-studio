import { DomainError } from "./errors.js";

const M5_SOURCE = /^(imvia|fixture|mock_lovart):[a-z0-9._-]+$/;
const LIVE_SOURCES = new Set([
  "imvia:lovart_project_create",
  "imvia:lovart_project_validate",
  "imvia:lovart_upload",
  "imvia:lovart_submit",
  "imvia:lovart_status",
  "imvia:lovart_import",
  "imvia:lovart_confirm",
]);

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

export function isAllowedLiveSource(source) {
  return typeof source === "string" && LIVE_SOURCES.has(source);
}

export function assertLiveSource(source, { field = "source" } = {}) {
  if (!isAllowedLiveSource(source)) {
    throw new DomainError("VALIDATION_FAILED", "Live IMVIA evidence source is not allowed.", { field, source });
  }
  return source;
}
