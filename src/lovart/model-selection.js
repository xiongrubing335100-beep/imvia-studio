const LOVART_MODEL_IDS = new Map([
  ["Seedance 2.5", "generate_video_seedance_v2_5"],
  ["Seedance 2.0 VIP", "generate_video_seedance_v2_0"],
  ["Seedance 2.0 Fast", "generate_video_seedance_v2_0_fast"],
  ["Minimax H3", "generate_video_minimax_h3"],
  ["Kling 3.0", "generate_video_kling_v3"],
  ["Kling 3.0 Omni", "generate_video_kling_v3_omni"],
  ["Seedream 4.0", "generate_image_seedream_v4"],
  ["Seedream 3.0", "generate_image_seedream_3_0"],
  ["Image 2", "generate_image_gpt_image_2"],
  ["Nano Banana Pro", "generate_image_nano_banana_pro"],
  ["Nano Banana 2", "generate_image_nano_banana_2"],
  ["Seedream 5.0", "generate_image_seedream_v5_pro"],
  ["Seedream 5.0 Lite", "generate_image_seedream_v5"],
  ["Midjourney", "generate_image_midjourney"],
]);

const WORKBENCH_MODEL_ALIASES = new Map([
  ["I2Image 2", "Image 2"],
]);

export function normalizeWorkbenchModel(value) {
  if (typeof value !== "string") return value;
  const compact = value.replace(/\s+/gu, " ").trim();
  return WORKBENCH_MODEL_ALIASES.get(compact) ?? compact;
}

export function lovartModelPreference({ mode, model } = {}) {
  const providerModel = LOVART_MODEL_IDS.get(model);
  if (!providerModel || !["image", "video"].includes(mode)) return undefined;
  return { [mode.toUpperCase()]: [providerModel] };
}
