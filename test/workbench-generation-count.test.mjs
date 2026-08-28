import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const countUi = await import("../workbench/dist/assets/imvia-generation-count-v1.js").catch(() => ({}));
const countUiSource = await readFile(new URL("../workbench/dist/assets/imvia-generation-count-v1.js", import.meta.url), "utf8");
const resultWorkspaceSource = await readFile(new URL("../workbench/dist/assets/imvia-result-workspace.js", import.meta.url), "utf8");

test("serializes image Auto without a numeric fallback", () => {
  assert.equal(typeof countUi.serializeGenerationCount, "function");
  assert.deepEqual(countUi.serializeGenerationCount({ mode: "image", value: "Auto" }), {
    count_mode: "auto",
    count: null,
  });
});

test("serializes explicit and legacy numeric image counts as fixed", () => {
  assert.equal(typeof countUi.serializeGenerationCount, "function");
  assert.deepEqual(countUi.serializeGenerationCount({ mode: "image", value: "4个" }), {
    count_mode: "fixed",
    count: 4,
  });
  assert.deepEqual(countUi.serializeGenerationCount({ mode: "image", value: "2" }), {
    count_mode: "fixed",
    count: 2,
  });
});

test("keeps video generation on a fixed numeric count", () => {
  assert.equal(typeof countUi.serializeGenerationCount, "function");
  assert.deepEqual(countUi.serializeGenerationCount({ mode: "video", value: "1个" }), {
    count_mode: "fixed",
    count: 1,
  });
});

test("keeps the Auto control outside React-owned dropdown DOM", () => {
  assert.doesNotMatch(countUiSource, /firstOption\.cloneNode/u);
  assert.doesNotMatch(countUiSource, /menu\.(?:prepend|append|appendChild|insertBefore|replaceChildren)/u);
  assert.doesNotMatch(countUiSource, /setDisplayedValue\(select/u);
  assert.match(countUiSource, /documentRoot\.body\.appendChild\(overlay\)/u);
});

test("renders Auto with the workbench custom dropdown instead of the native select UI", () => {
  assert.doesNotMatch(countUiSource, /<select\b/u);
  assert.match(countUiSource, /aria-haspopup="listbox"/u);
  assert.match(countUiSource, /role="listbox"/u);
  assert.match(countUiSource, /role="option"/u);
  assert.match(countUiSource, /background:#202629/u);
  assert.match(countUiSource, /border-radius:10px/u);
});

test("does not retrigger the workbench MutationObserver when the displayed count is unchanged", () => {
  assert.match(countUiSource, /if \(valueNode\.textContent !== imageCountValue\) valueNode\.textContent = imageCountValue;/u);
});

test("clips and repositions the floating image-count control with the creator scroller", () => {
  assert.match(countUiSource, /isFloatingControlVisible/u);
  assert.match(countUiSource, /floatingMenuPlacement/u);
  assert.match(resultWorkspaceSource, /installImageCountAuto\(document\);\s*installGenerationSettings\(document\);\s*installModelAuto\(document\);/u);
});
