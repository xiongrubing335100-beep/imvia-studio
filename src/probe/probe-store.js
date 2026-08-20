import { JsonStore } from "../persistence/json-store.js";
import { PROBE_STATE_FILE } from "./constants.js";

export function createInitialProbeState() {
  return { version: 1, enabled: false, authorizations: [], attempts: [], audit_events: [] };
}

export function createProbeStore({ dataDirectory }) {
  return new JsonStore({ dataDirectory, stateFileName: PROBE_STATE_FILE, createInitialState: createInitialProbeState });
}
