export const MODEL_CAPABILITIES = new Map([
  ["Seedance 2.5", { mode: "video", durations: [5, 10, 15, 30] }],
  ["Seedance 2.0 VIP", { mode: "video", durations: [5, 10, 15] }],
  ["Seedance 2.0 Fast", { mode: "video", durations: [5, 10, 15] }],
  ["Minimax H3", { mode: "video", durations: [5, 10, 15] }],
  ["Kling 3.0", { mode: "video", durations: [5, 10, 15] }],
  ["Kling 3.0 Omni", { mode: "video", durations: [5, 10, 15] }],
  ["Seedream 4.0", { mode: "image" }],
  ["Seedream 3.0", { mode: "image" }],
  ["Seedream 3.0 Fast", { mode: "image" }],
  ["Image 2", { mode: "image" }],
  ["Nano Banana Pro", { mode: "image" }],
  ["Nano Banana 2", { mode: "image" }],
  ["Seedream 5.0", { mode: "image" }],
  ["Seedream 5.0 Lite", { mode: "image" }],
  ["Midjourney", { mode: "image" }],
]);

/**
 * Keep Lovart's legacy model table as the compatibility boundary, while each
 * enabled external connection owns the catalog authoritative for its jobs.
 */
function externalCatalogModels(connection) {
  const models = connection?.model_catalog?.models ?? connection?.catalog?.models ?? connection?.models;
  return Array.isArray(models) ? models : [];
}

function normalizedExternalModel(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const display_name = typeof candidate.display_name === "string" && candidate.display_name.trim()
    ? candidate.display_name.trim()
    : id;
  const capabilities = Array.isArray(candidate.capabilities)
    ? [...new Set(candidate.capabilities.filter((capability) => capability === "image" || capability === "video"))]
    : [];
  const compatibility = ["confirmed", "unconfirmed", "unsupported"].includes(candidate.compatibility)
    ? candidate.compatibility
    : "unsupported";
  if (!id) return null;
  return {
    id,
    display_name,
    capabilities,
    compatibility,
    source: "api",
    raw_index: Number.isInteger(candidate.raw_index) && candidate.raw_index >= 0 ? candidate.raw_index : 0,
  };
}

export function assertProviderModelCapability({ providerRegistry = null, connection = null, provider_id = "lovart", model, mode, field = "model" } = {}) {
  if (model == null) return null;
  if (typeof model !== "string" || !model.trim()) {
    const error = new Error("Workbench model must be a non-empty string.");
    error.code = "VALIDATION_FAILED";
    error.details = { field };
    throw error;
  }
  if (provider_id === "lovart") {
    const capability = MODEL_CAPABILITIES.get(model);
    if (!capability) {
      const error = new Error("The selected Lovart model is absent from the local capability table.");
      error.code = "MODEL_CAPABILITY_UNKNOWN";
      error.details = { field, model };
      throw error;
    }
    if (capability.mode !== mode) {
      const error = new Error("The selected Lovart model does not support this creation mode.");
      error.code = "VALIDATION_FAILED";
      error.details = { field, model, mode, supported_mode: capability.mode };
      throw error;
    }
    return model;
  }
  if (!providerRegistry || typeof providerRegistry.get !== "function") {
    const error = new Error("A provider registry is required for non-Lovart model selection.");
    error.code = "VALIDATION_FAILED";
    error.details = { field: "provider_id", provider_id };
    throw error;
  }
  const descriptor = providerRegistry.get(provider_id);
  if (!descriptor.capabilities.includes(mode)) {
    const error = new Error("The selected provider does not support this creation mode.");
    error.code = "VALIDATION_FAILED";
    error.details = { field: "mode", provider_id, mode };
    throw error;
  }
  if (!connection || connection.provider_id !== provider_id || connection.enabled !== true) {
    const error = new Error("The selected provider connection is unavailable.");
    error.code = "CONNECTION_UNAVAILABLE";
    error.details = { field: "connection_id", provider_id };
    throw error;
  }
  if (model === "Auto") {
    const error = new Error("Auto is available only for Lovart model selection.");
    error.code = "MODEL_CAPABILITY_UNKNOWN";
    error.details = { field, provider_id, model };
    throw error;
  }
  const selected = externalCatalogModels(connection)
    .map(normalizedExternalModel)
    .find((candidate) => candidate?.id === model);
  if (!selected) {
    const error = new Error("The selected model is absent from the provider connection catalog.");
    error.code = "MODEL_CAPABILITY_UNKNOWN";
    error.details = { field, provider_id, model };
    throw error;
  }
  if (selected.compatibility === "unsupported" || !selected.capabilities.includes(mode)) {
    const error = new Error("The selected provider model does not support this creation mode.");
    error.code = "VALIDATION_FAILED";
    error.details = { field, provider_id, model, mode };
    throw error;
  }
  return selected;
}
