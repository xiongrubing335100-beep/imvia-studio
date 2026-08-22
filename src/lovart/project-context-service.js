import { DomainError } from "../domain/errors.js";
import { chooseLovartProject, normalizeLovartProjectLocator } from "../domain/lovart-project-context.js";

function upstreamProjectError(projectId) {
  return new DomainError("INVALID_LOVART_PROJECT", "The Lovart project could not be validated.", { project_id: projectId });
}

export function createProjectContextService({ workbenchService, generationService }) {
  if (!workbenchService?.getLovartProjects || !workbenchService?.setLovartProject || !workbenchService?.recordLovartProject) {
    throw new TypeError("workbenchService project operations are required");
  }
  if (!generationService?.validateProject || !generationService?.createProject) {
    throw new TypeError("generationService project operations are required");
  }

  async function list() {
    return workbenchService.getLovartProjects();
  }

  async function select({ locator, source = "user_selected" } = {}) {
    const normalized = normalizeLovartProjectLocator(locator);
    let validation;
    try {
      validation = await generationService.validateProject({ project_id: normalized.project_id });
    } catch (error) {
      if (error?.code === "INVALID_LOVART_PROJECT") throw error;
      throw error;
    }
    if (validation?.valid !== true) throw upstreamProjectError(normalized.project_id);
    const result = await workbenchService.setLovartProject({
      project_id: normalized.project_id,
      canvas_url: normalized.canvas_url,
      name: validation.project_name || null,
      source,
    });
    return result.active_project;
  }

  async function remember({ locator, source = "user_selected" } = {}) {
    const normalized = normalizeLovartProjectLocator(locator);
    const result = await workbenchService.setLovartProject({
      project_id: normalized.project_id,
      canvas_url: normalized.canvas_url,
      name: null,
      source,
    });
    return result.active_project;
  }

  async function create({ name = null, source = "auto_created" } = {}) {
    const created = await generationService.createProject({
      ...(typeof name === "string" && name.trim() ? { project_name: name.trim() } : {}),
    });
    const normalized = normalizeLovartProjectLocator(created?.project_id);
    let validation = null;
    try {
      validation = await generationService.validateProject({ project_id: normalized.project_id });
    } catch (error) {
      throw error?.code === "INVALID_LOVART_PROJECT" ? error : upstreamProjectError(normalized.project_id);
    }
    if (validation?.valid !== true) throw upstreamProjectError(normalized.project_id);
    const result = await workbenchService.setLovartProject({
      project_id: normalized.project_id,
      canvas_url: normalized.canvas_url,
      name: validation.project_name || created.project_name || name || null,
      source,
    });
    return result.active_project;
  }

  async function resolve({ explicit_locator = null, select_explicit = false } = {}) {
    const current = await list();
    const choice = chooseLovartProject({
      explicit_project_id: explicit_locator ? normalizeLovartProjectLocator(explicit_locator).project_id : null,
      active_project_id: current.active_lovart_project_id,
    });
    if (choice.source === "explicit") {
      const normalized = normalizeLovartProjectLocator(explicit_locator);
      const validation = await generationService.validateProject({ project_id: normalized.project_id });
      if (validation?.valid !== true) throw upstreamProjectError(normalized.project_id);
      if (select_explicit) {
        await workbenchService.setLovartProject({ project_id: normalized.project_id, canvas_url: normalized.canvas_url, name: validation.project_name || null, source: "explicit" });
      } else {
        await workbenchService.recordLovartProject({ project_id: normalized.project_id, canvas_url: normalized.canvas_url, name: validation.project_name || null, source: "explicit" });
      }
      return choice;
    }
    if (choice.source === "active") return choice;
    const created = await create({ source: "auto_created" });
    return { project_id: created.project_id, source: "auto_create" };
  }

  return Object.freeze({ list, remember, select, create, resolve });
}
