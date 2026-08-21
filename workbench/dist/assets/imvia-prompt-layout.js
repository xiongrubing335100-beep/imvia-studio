export function resolveVisualCaret({ segments = [], selection_start: selectionStart } = {}) {
  if (!Number.isInteger(selectionStart) || selectionStart < 0) return null;
  let rawIndex = 0;
  for (const segment of segments) {
    const sourceLength = Number.isInteger(segment?.source_length) && segment.source_length >= 0 ? segment.source_length : 0;
    const segmentEnd = rawIndex + sourceLength;
    if (selectionStart <= segmentEnd) {
      if (segment.kind === "token") return selectionStart === rawIndex ? segment.start ?? null : segment.end ?? null;
      const offset = Math.max(0, Math.min(sourceLength, selectionStart - rawIndex));
      return segment.positions?.[offset] ?? null;
    }
    rawIndex = segmentEnd;
  }
  return null;
}

export function visualCaretPhase({ now = Date.now(), last_interaction_at: lastInteractionAt = null, hold_ms: holdMs = 700 } = {}) {
  if (!Number.isFinite(lastInteractionAt)) return "blinking";
  return now - lastInteractionAt <= holdMs ? "engaged" : "blinking";
}
