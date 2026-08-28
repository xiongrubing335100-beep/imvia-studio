import { createHash } from "node:crypto";
import { MEDIA_CAPABILITIES, MODEL_COMPATIBILITIES } from "./constants.js";

const MAX_MODELS = 2_000;
const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 512;
const COMPATIBILITY = new Set(MODEL_COMPATIBILITIES);
const CAPABILITIES = new Set(MEDIA_CAPABILITIES);

// JSON with sorted object keys makes the digest independent of object insertion order.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function deduplicate(entries) {
  const seen = new Set();
  const result = [];
  for (const [rawIndex, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    result.push({ entry, rawIndex });
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}

function normalizeModel(entry, classification = {}, rawIndex = 0) {
  const id = entry.id.trim();
  const displayName = typeof entry.name === "string" && entry.name.trim()
    ? entry.name.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
    : id;
  const capabilities = [...new Set(
    (Array.isArray(classification?.capabilities) ? classification.capabilities : [])
      .filter((capability) => CAPABILITIES.has(capability)),
  )];
  const compatibility = COMPATIBILITY.has(classification?.compatibility)
    ? classification.compatibility
    : "unsupported";
  return { id, display_name: displayName, capabilities, compatibility, source: "api", raw_index: rawIndex };
}

function countModels(models) {
  return Object.freeze({
    total: models.length,
    confirmed: models.filter((model) => model.compatibility === "confirmed").length,
    unconfirmed: models.filter((model) => model.compatibility === "unconfirmed").length,
    unsupported: models.filter((model) => model.compatibility === "unsupported").length,
  });
}

export function modelRecordDigest(model) {
  return createHash("sha256").update(stableJson(model)).digest("hex");
}

export function normalizeModelCatalog({ entries, classify = () => ({}), now = () => new Date().toISOString() } = {}) {
  const models = deduplicate(entries).map(({ entry, rawIndex }) => normalizeModel(entry, classify(entry), rawIndex));
  const revision_input = stableJson(models);
  const digest = createHash("sha256").update(revision_input).digest("hex");
  return deepFreeze({
    revision_input,
    discovered_at: now(),
    digest,
    models,
    counts: countModels(models),
  });
}

export function modelsForMode(models, mode) {
  const list = Array.isArray(models) ? models : [];
  return deepFreeze({
    confirmed: list.filter((model) => model.compatibility === "confirmed" && model.capabilities.includes(mode)),
    unconfirmed: list.filter((model) => model.compatibility === "unconfirmed" && model.capabilities.includes(mode)),
    unsupported: list.filter((model) => !model.capabilities.includes(mode) || model.compatibility === "unsupported"),
  });
}
