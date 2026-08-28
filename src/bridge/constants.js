export const BRIDGE_PROTOCOL_VERSION = "imvia.conversation-bridge.v1";
export const BRIDGE_STATE_FILE = "conversation-bridge.json";
export const BRIDGE_HEARTBEAT_INTERVAL_MS = 5_000;
export const BRIDGE_STALE_AFTER_MS = 20_000;
export const DISPATCH_LEASE_MS = 30_000;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export const DELIVERY_STATES = Object.freeze([
  "pending_bridge",
  "claimed",
  "host_accepted",
  "codex_received",
  "delivery_failed",
  "delivery_uncertain",
  "cancelled",
]);
