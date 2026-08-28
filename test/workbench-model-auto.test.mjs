import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const modelAuto = await import("../workbench/dist/assets/imvia-model-auto-v1.js").catch(() => ({}));
const modelAutoSource = await readFile(new URL("../workbench/dist/assets/imvia-model-auto-v1.js", import.meta.url), "utf8");
const resultWorkspaceSource = await readFile(new URL("../workbench/dist/assets/imvia-result-workspace.js", import.meta.url), "utf8");

test("does not rebuild an unchanged model mark during workbench refreshes", () => {
  assert.equal(typeof modelAuto.modelMarkNeedsRefresh, "function");
  assert.equal(modelAuto.modelMarkNeedsRefresh("Auto", "Auto"), false);
  assert.equal(modelAuto.modelMarkNeedsRefresh("Image 2", "Image 2"), false);
  assert.equal(modelAuto.modelMarkNeedsRefresh("Seedream 4.0", "Image 2"), true);
  assert.equal(modelAuto.modelMarkNeedsRefresh(undefined, "Auto"), true);
});

test("keeps Auto for Lovart while external catalog choices retain their raw API IDs", () => {
  assert.deepEqual(modelAuto.modelOptionsForProvider({ providerId: "lovart", mode: "image" }), [
    "Auto", "Seedream 4.0", "Seedream 3.0", "Seedream 3.0 Fast", "Image 2", "Nano Banana Pro", "Nano Banana 2", "Seedream 5.0", "Seedream 5.0 Lite", "Midjourney",
  ]);
  assert.deepEqual(modelAuto.modelOptionsForProvider({ providerId: "lovart", mode: "video" }), [
    "Auto", "Seedance 2.5", "Seedance 2.0 VIP", "Seedance 2.0 Fast", "Minimax H3", "Kling 3.0", "Kling 3.0 Omni",
  ]);
  assert.deepEqual(modelAuto.modelOptionsForProvider({ providerId: "external-api", models: [{ id: "provider-image", display_name: "Provider Image" }, { id: "unknown-model", display_name: "Unknown model" }], mode: "image" }), ["provider-image", "unknown-model"]);
  assert.equal(modelAuto.modelOptionsForProvider({ providerId: "external-api", models: [{ id: "provider-image" }], mode: "image" }).includes("Auto"), false);
});

test("provider-selection events reset the dataset to an actual external model and retain Lovart Auto", () => {
  assert.equal(typeof modelAuto.modelForProviderSelectionEvent, "function");
  assert.equal(modelAuto.modelForProviderSelectionEvent({
    providerId: "external-api", model: "Auto", models: [{ id: "provider-image", display_name: "Provider Image" }],
  }), "provider-image");
  assert.equal(modelAuto.modelForProviderSelectionEvent({
    providerId: "external-api", model: "provider-image", models: [{ id: "provider-image", display_name: "Provider Image" }],
  }), "provider-image");
  assert.equal(modelAuto.modelForProviderSelectionEvent({
    providerId: "external-api", model: "Auto", models: [{ id: "Auto", display_name: "Provider Auto" }],
  }), "");
  assert.equal(modelAuto.modelForProviderSelectionEvent({
    providerId: "lovart", model: "Auto", models: [{ id: "Auto" }, { id: "Image 2" }],
  }), "Auto");
});

test("keeps the model overlay readable without colored icon tiles", () => {
  assert.match(modelAutoSource, /min-width:max-content/);
  assert.match(modelAutoSource, /background:transparent/);
  assert.match(modelAutoSource, /width:max\(100%,320px\)/);
  assert.match(modelAutoSource, /overflow:visible;text-overflow:clip/);
  assert.doesNotMatch(modelAutoSource, /background:#16363a/);
});

test("hides a floating model control whenever its native control is clipped by the creator scroller", () => {
  assert.equal(typeof modelAuto.isOverlayTargetVisible, "function");
  const clip = { top: 120, right: 560, bottom: 800, left: 100 };
  assert.equal(modelAuto.isOverlayTargetVisible({ top: 140, right: 540, bottom: 180, left: 120, width: 420, height: 40 }, clip), true);
  assert.equal(modelAuto.isOverlayTargetVisible({ top: 100, right: 540, bottom: 140, left: 120, width: 420, height: 40 }, clip), false);
  assert.equal(modelAuto.isOverlayTargetVisible({ top: 780, right: 540, bottom: 820, left: 120, width: 420, height: 40 }, clip), false);
});

test("flips the model menu above its trigger when the visible scroller has insufficient room below", () => {
  assert.equal(typeof modelAuto.modelMenuPlacement, "function");
  assert.equal(modelAuto.modelMenuPlacement({ triggerTop: 140, triggerBottom: 180, clipTop: 120, clipBottom: 800, menuHeight: 330 }), "below");
  assert.equal(modelAuto.modelMenuPlacement({ triggerTop: 700, triggerBottom: 740, clipTop: 120, clipBottom: 800, menuHeight: 330 }), "above");
});

test("keeps an open model menu mounted across an identical provider refresh", () => {
  const input = {
    providerId: "lovart",
    mode: "image",
    models: [{ id: "Auto", display_name: "Auto" }, { id: "Image 2", display_name: "Image 2" }],
  };
  const signature = modelAuto.modelOverlayRenderSignature?.(input);

  assert.equal(typeof signature, "string");
  assert.equal(modelAuto.modelOverlayNeedsRebuild?.(signature, input), false);
  assert.equal(modelAuto.modelOverlayNeedsRebuild?.(signature, { ...input, mode: "video" }), true);
  assert.equal(modelAuto.modelOverlayNeedsRebuild?.(signature, {
    ...input,
    models: [{ id: "Auto", display_name: "Auto" }, { id: "Image 2", display_name: "OpenAI Image 2" }],
  }), true);
});

test("repositions floating workbench controls on every scroll and resize", () => {
  assert.match(resultWorkspaceSource, /installGenerationSettings\(document\);\s*installModelAuto\(document\);/u);
  assert.match(resultWorkspaceSource, /addEventListener\("scroll",\s*reposition,\s*true\)/u);
});
