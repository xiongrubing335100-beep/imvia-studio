import { DomainError } from "../domain/errors.js";
import { MODEL_CAPABILITIES } from "../domain/model-capabilities.js";
import { PROBE_POLICY_VERSION, PROBE_RESULT_TTL_MS } from "./constants.js";

export const OFFICIAL_MODEL_IDS = Object.freeze({
  "Seedance 2.5": "generate_video_seedance_v2_5",
  "Seedance 2.0 VIP": null,
  "Seedance 2.0 Fast": "generate_video_seedance_v2_0_fast",
  "Minimax H3": "generate_video_minimax_h3",
  "Kling 3.0": "generate_video_kling_v3",
  "Kling 3.0 Omni": "generate_video_kling_v3_omni",
  "Seedream 4.0": "generate_image_seedream_v4",
  "Seedream 3.0": null,
  "Seedream 3.0 Fast": null,
  "Image 2": null,
  "Nano Banana Pro": "generate_image_nano_banana_pro",
  "Nano Banana 2": "generate_image_nano_banana_2",
  "Seedream 5.0": null,
  "Seedream 5.0 Lite": "generate_image_seedream_v5",
  Midjourney: "generate_image_midjourney",
});

function recognizedAvailableModels(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  if (!["IMAGE", "VIDEO"].every((key) => value[key] === undefined ||
    (Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")))) {
    return null;
  }
  return new Set([...(value.IMAGE ?? []), ...(value.VIDEO ?? [])]);
}

export function normalizeLovartCapabilities(root, { checkedAtMs = Date.now() } = {}) {
  if (!root || Array.isArray(root) || typeof root !== "object" || typeof root.unlimited !== "boolean") {
    throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "Lovart response envelope was not recognized");
  }

  const available = recognizedAvailableModels(root.available_models);
  const checkedAt = new Date(checkedAtMs).toISOString();

  return {
    reachable: true,
    authenticated: true,
    service_version: null,
    capability_status: available ? "available" : "unknown",
    workbench_models: [...MODEL_CAPABILITIES].map(([name, capability]) => ({
      name,
      mode: capability.mode,
      availability: !available || !OFFICIAL_MODEL_IDS[name]
        ? "unknown"
        : available.has(OFFICIAL_MODEL_IDS[name]) ? "available" : "unavailable",
    })),
    checked_at: checkedAt,
    expires_at: new Date(checkedAtMs + PROBE_RESULT_TTL_MS).toISOString(),
    policy_version: PROBE_POLICY_VERSION,
  };
}
