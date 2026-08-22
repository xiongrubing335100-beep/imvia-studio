import assert from "node:assert/strict";
import test from "node:test";

test("visual caret stays after the final character when a reference chip is wider than its raw tag", async () => {
  const { resolveVisualCaret } = await import("../workbench/dist/assets/imvia-prompt-layout.js");
  const point = (left) => ({ left, top: 80, height: 20 });
  const segments = [
    { kind: "plain", source_length: 3, positions: [point(100), point(110), point(120), point(130)] },
    { kind: "token", source_length: 4, start: point(130), end: point(210) },
    { kind: "plain", source_length: 9, positions: [point(210), point(221), point(232), point(243), point(254), point(265), point(276), point(287), point(298), point(309)] },
  ];

  assert.deepEqual(resolveVisualCaret({ segments, selection_start: 7 }), point(210));
  assert.deepEqual(resolveVisualCaret({ segments, selection_start: 16 }), point(309));
});

test("a fresh pointer or keyboard interaction holds the visual caret before blinking", async () => {
  const { visualCaretPhase } = await import("../workbench/dist/assets/imvia-prompt-layout.js");
  assert.equal(visualCaretPhase({ now: 1_500, last_interaction_at: 1_000, hold_ms: 700 }), "engaged");
  assert.equal(visualCaretPhase({ now: 1_701, last_interaction_at: 1_000, hold_ms: 700 }), "blinking");
  assert.equal(visualCaretPhase({ now: 1_500, last_interaction_at: null, hold_ms: 700 }), "blinking");
});
