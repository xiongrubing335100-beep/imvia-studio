import assert from "node:assert/strict";
import test from "node:test";

const settingsUi = await import("../workbench/dist/assets/imvia-generation-settings-v1.js").catch(() => ({}));

test("offers Auto and the complete aspect-ratio list for image and video", () => {
  assert.equal(typeof settingsUi.generationSettingOptions, "function");
  const expected = [
    "Auto",
    "16:9",
    "4:3",
    "3:2",
    "1:1",
    "2:3",
    "3:4",
    "9:16",
    "21:9",
  ];
  assert.deepEqual(settingsUi.generationSettingOptions({ mode: "image", field: "ratio" }), expected);
  assert.deepEqual(settingsUi.generationSettingOptions({ mode: "video", field: "ratio" }), expected);
});

test("serializes an Auto ratio as no Lovart ratio constraint", () => {
  assert.equal(typeof settingsUi.resolveGenerationRatio, "function");
  assert.equal(settingsUi.resolveGenerationRatio({ mode: "image", value: "16:9", ratioOverride: "Auto" }), null);
  assert.equal(settingsUi.resolveGenerationRatio({ mode: "video", value: "16:9", ratioOverride: "Auto" }), null);
  assert.equal(settingsUi.resolveGenerationRatio({ mode: "image", value: "16:9", imageOverride: "2:3" }), "2:3");
  assert.equal(settingsUi.resolveGenerationRatio({ mode: "video", value: "16:9", ratioOverride: "3:2" }), "3:2");
});

test("serializes an Auto model as no Lovart model preference", () => {
  assert.equal(typeof settingsUi.resolveGenerationModel, "function");
  assert.equal(settingsUi.resolveGenerationModel({ value: "Seedream 4.0", modelOverride: "Auto" }), null);
  assert.equal(settingsUi.resolveGenerationModel({ value: "Seedance 2.5", modelOverride: "Auto" }), null);
  assert.equal(settingsUi.resolveGenerationModel({ value: "Seedream 4.0", modelOverride: "Image 2" }), "Image 2");
});

test("prepends Auto once to every image or video model list", () => {
  assert.equal(typeof settingsUi.generationModelOptions, "function");
  assert.deepEqual(settingsUi.generationModelOptions(["Seedance 2.5", "Kling 3.0"]), ["Auto", "Seedance 2.5", "Kling 3.0"]);
  assert.deepEqual(settingsUi.generationModelOptions(["Auto", "Image 2"]), ["Auto", "Image 2"]);
});

test("widens a narrow resolution menu enough to display every resolution label", () => {
  assert.equal(typeof settingsUi.resolutionMenuGeometry, "function");
  assert.deepEqual(settingsUi.resolutionMenuGeometry({ triggerWidth: 70 }), {
    width: 112,
    minWidth: 112,
    right: "auto",
  });
  assert.deepEqual(settingsUi.resolutionMenuGeometry({ triggerWidth: 148 }), {
    width: 148,
    minWidth: 112,
    right: "auto",
  });
});
