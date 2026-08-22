import { DomainError } from "./errors.js";

const LOVART_CANVAS_ORIGIN = "https://www.lovart.ai";
const LOVART_CANVAS_PATH = "/canvas";

function invalidLocator(locator, reason = "Project locator is invalid.") {
  throw new DomainError("INVALID_LOVART_PROJECT_LOCATOR", reason, { locator });
}

function normalizeProjectId(value, source) {
  if (typeof value !== "string") invalidLocator(value, "Project locator must be a non-empty string.");
  const projectId = value.trim();
  if (!projectId || /[\u0000-\u0020/?#]/u.test(projectId)) {
    invalidLocator(value, "Project id is empty or contains unsafe characters.");
  }
  return { project_id: projectId, source };
}

export function normalizeLovartProjectLocator(locator) {
  if (typeof locator !== "string" || !locator.trim()) {
    invalidLocator(locator, "Project locator must be a non-empty string.");
  }
  const value = locator.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    const { project_id } = normalizeProjectId(value, "id");
    return {
      project_id,
      canvas_url: `${LOVART_CANVAS_ORIGIN}${LOVART_CANVAS_PATH}?projectId=${encodeURIComponent(project_id)}`,
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    invalidLocator(locator, "Project locator URL cannot be parsed.");
  }
  if (
    url.origin !== LOVART_CANVAS_ORIGIN
    || url.pathname !== LOVART_CANVAS_PATH
    || url.username
    || url.password
    || url.hash
  ) {
    invalidLocator(locator, "Project locator must be an official Lovart canvas URL.");
  }
  const projectIds = url.searchParams.getAll("projectId");
  if (projectIds.length !== 1) {
    invalidLocator(locator, "Project locator URL must contain exactly one projectId.");
  }
  const { project_id } = normalizeProjectId(projectIds[0], "url");
  const canonicalUrl = new URL(LOVART_CANVAS_PATH, LOVART_CANVAS_ORIGIN);
  canonicalUrl.searchParams.set("projectId", project_id);
  return { project_id, canvas_url: canonicalUrl.toString() };
}

export function chooseLovartProject({ explicit_project_id = null, active_project_id = null } = {}) {
  if (typeof explicit_project_id === "string" && explicit_project_id.trim()) {
    return { project_id: explicit_project_id.trim(), source: "explicit" };
  }
  if (typeof active_project_id === "string" && active_project_id.trim()) {
    return { project_id: active_project_id.trim(), source: "active" };
  }
  return { project_id: null, source: "auto_create" };
}

export function assertContinuationParent({ activation_source, parent_job_id, artifact_id } = {}) {
  if (typeof activation_source !== "string" || !activation_source.trim()) {
    throw new DomainError("INVALID_CONTINUATION_PARENT", "Activation source is required.");
  }
  const result = { activation_source: activation_source.trim() };
  if (typeof parent_job_id === "string" && parent_job_id.trim()) result.parent_job_id = parent_job_id.trim();
  if (typeof artifact_id === "string" && artifact_id.trim()) result.artifact_id = artifact_id.trim();
  if (result.activation_source === "contextual" && !result.parent_job_id && !result.artifact_id) {
    throw new DomainError("INVALID_CONTINUATION_PARENT", "Contextual Lovart continuation requires a parent job or artifact.");
  }
  if (parent_job_id !== undefined && parent_job_id !== null && !result.parent_job_id) {
    throw new DomainError("INVALID_CONTINUATION_PARENT", "Parent job id must be non-empty when provided.");
  }
  if (artifact_id !== undefined && artifact_id !== null && !result.artifact_id) {
    throw new DomainError("INVALID_CONTINUATION_PARENT", "Artifact id must be non-empty when provided.");
  }
  return result;
}
