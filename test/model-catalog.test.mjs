import test from "node:test";
import assert from "node:assert/strict";
import { modelRecordDigest, modelsForMode, normalizeModelCatalog } from "../src/providers/model-catalog.js";

test("preserves provider names and exposes every normalized model", () => {
  const catalog = normalizeModelCatalog({
    entries: [{ id: "img-1", name: "Image One" }, { id: "unknown-2" }],
    classify: ({ id }) => id === "img-1"
      ? { capabilities: ["image"], compatibility: "confirmed" }
      : { capabilities: [], compatibility: "unsupported" },
    now: () => "2026-08-25T00:00:00.000Z",
  });
  assert.deepEqual(catalog.models.map(({ id, display_name }) => [id, display_name]), [["img-1", "Image One"], ["unknown-2", "unknown-2"]]);
  assert.equal(modelsForMode(catalog.models, "image").unsupported[0].id, "unknown-2");
});

test("normalizes bounds, strips raw fields, deduplicates, and preserves source order", () => {
  const long = "x".repeat(700);
  const catalog = normalizeModelCatalog({
    entries: [{ id: "a", name: long, secret: "no" }, { id: "a", name: "later" }, { id: "b" }, { id: "" }, { id: "x".repeat(257) }],
    classify: () => ({ capabilities: ["image", "image", "audio"], compatibility: "unconfirmed" }),
  });
  assert.deepEqual(catalog.models.map((model) => model.id), ["a", "b"]);
  assert.equal(catalog.models[0].display_name.length, 512);
  assert.deepEqual(Object.keys(catalog.models[0]).sort(), ["capabilities", "compatibility", "display_name", "id", "raw_index", "source"]);
  assert.equal(catalog.models[1].raw_index, 2);
});

test("digest is deterministic and compatibility projections retain unsupported models", () => {
  const input = [{ id: "v" }, { id: "u" }, { id: "n" }];
  const make = () => normalizeModelCatalog({ entries: input, classify: ({ id }) => ({ capabilities: id === "v" ? ["video"] : id === "u" ? ["image"] : [], compatibility: id === "n" ? "unsupported" : id === "u" ? "unconfirmed" : "confirmed" }), now: () => "fixed" });
  const a = make(); const b = make();
  assert.equal(a.digest, b.digest);
  assert.equal(modelRecordDigest(a.models[0]), modelRecordDigest(b.models[0]));
  assert.deepEqual(modelsForMode(a.models, "image").unconfirmed.map((m) => m.id), ["u"]);
  assert.deepEqual(modelsForMode(a.models, "image").unsupported.map((m) => m.id), ["v", "n"]);
});
