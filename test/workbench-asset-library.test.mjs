import assert from "node:assert/strict";
import test from "node:test";

const library = await import("../workbench/dist/assets/imvia-asset-library-v1.js").catch(() => ({}));

test("does not rewrite unchanged bulk-control labels during mutation refreshes", () => {
  assert.equal(typeof library.assignTextIfChanged, "function");
  let writes = 0;
  let current = "多选";
  const node = {
    get textContent() { return current; },
    set textContent(value) { writes += 1; current = value; },
  };

  library.assignTextIfChanged(node, "多选");
  library.assignTextIfChanged(node, "取消多选");
  library.assignTextIfChanged(node, "取消多选");

  assert.equal(writes, 1);
  assert.equal(current, "取消多选");
});

test("routes the persistent multi-select control state independently of replaced toolbar nodes", () => {
  assert.equal(typeof library.selectionAfterBulkControl, "function");
  assert.deepEqual(
    library.selectionAfterBulkControl("toggle-selection", { selectionMode: false, selectedKeys: ["asset:one"] }),
    { selectionMode: true, selectedKeys: ["asset:one"] },
  );
  assert.deepEqual(
    library.selectionAfterBulkControl("toggle-selection", { selectionMode: true, selectedKeys: ["asset:one"] }),
    { selectionMode: false, selectedKeys: [] },
  );
});

test("reinstalls delegated controls when a legacy listener marker is present", () => {
  assert.equal(typeof library.assetLibraryEventsNeedInstall, "function");
  assert.equal(library.assetLibraryEventsNeedInstall("true"), true);
  assert.equal(library.assetLibraryEventsNeedInstall(library.assetLibraryEventsVersion), false);
});

test("finds a bulk control through the event path when the click target is a text node", () => {
  assert.equal(typeof library.bulkActionFromEvent, "function");
  const button = { dataset: { action: "toggle-selection" }, matches: () => true, closest: () => button };
  const textNode = { parentElement: button };
  assert.equal(library.bulkActionFromEvent({ target: textNode, composedPath: () => [textNode, button] }), "toggle-selection");
  assert.equal(library.bulkActionFromEvent({ target: textNode, composedPath: () => [] }), "toggle-selection");
});

test("mounts bulk controls in the toolbar placeholder instead of an overlapping eighth grid cell", () => {
  assert.equal(typeof library.findBulkControlSlot, "function");
  const children = [
    { tagName: "DIV" }, { tagName: "DIV" }, { tagName: "DIV" }, { tagName: "DIV" },
    { tagName: "SPAN" }, { tagName: "BUTTON" }, { tagName: "BUTTON" },
  ];
  assert.equal(library.findBulkControlSlot({ children }), children[4]);
});

test("keeps only image files from a reference or library drop", () => {
  assert.equal(typeof library.droppedImageFiles, "function");
  const image = { name: "portrait.png", type: "image/png" };
  const video = { name: "clip.mp4", type: "video/mp4" };
  const unknown = { name: "README", type: "" };

  assert.deepEqual(library.droppedImageFiles([video, image, unknown]), [image]);
});

test("toggles more than one material without losing earlier selections", () => {
  assert.equal(typeof library.toggleMaterialSelection, "function");

  const first = library.toggleMaterialSelection([], "asset:one");
  const second = library.toggleMaterialSelection(first, "asset:two");
  const third = library.toggleMaterialSelection(second, "asset:one");

  assert.deepEqual(first, ["asset:one"]);
  assert.deepEqual(second, ["asset:one", "asset:two"]);
  assert.deepEqual(third, ["asset:two"]);
});

test("removes selected generated materials or every generated material", () => {
  assert.equal(typeof library.generatedMaterialsAfterDeletion, "function");
  const items = [
    { artifact_id: "generated-one" },
    { artifact_id: "generated-two" },
  ];

  assert.deepEqual(
    library.generatedMaterialsAfterDeletion(items, { artifactIds: ["generated-one"] }),
    [{ artifact_id: "generated-two" }],
  );
  assert.deepEqual(library.generatedMaterialsAfterDeletion(items, { all: true }), []);
});

test("builds one deletion request for local and generated material selections", () => {
  assert.equal(typeof library.materialDeletionRequest, "function");
  assert.deepEqual(
    library.materialDeletionRequest(["asset:asset-one", "artifact:generated-two"]),
    { all: false, assetIds: ["asset-one"], artifactIds: ["generated-two"] },
  );
  assert.deepEqual(
    library.materialDeletionRequest([], { all: true }),
    { all: true, assetIds: [], artifactIds: [] },
  );
});
