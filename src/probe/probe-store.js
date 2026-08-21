import { JsonStore } from "../persistence/json-store.js";
import { PROBE_STATE_FILE } from "./constants.js";
import { copyValidatedProbeState, probeStoreUnavailable } from "./probe-state-validator.js";

export function createInitialProbeState() {
  return { version: 1, enabled: false, authorizations: [], attempts: [], audit_events: [] };
}

export function createProbeStore({ dataDirectory }) {
  const store = new JsonStore({
    dataDirectory,
    stateFileName: PROBE_STATE_FILE,
    createInitialState: createInitialProbeState,
  });
  return {
    dataDirectory: store.dataDirectory,
    statePath: store.statePath,

    async read() {
      try {
        return copyValidatedProbeState(await store.read());
      } catch {
        throw probeStoreUnavailable();
      }
    },

    async update(mutator) {
      let mutatorFailure;
      try {
        return await store.update(async (state) => {
          copyValidatedProbeState(state);
          let result;
          try {
            result = await mutator(state);
          } catch (error) {
            mutatorFailure = error;
            throw error;
          }
          copyValidatedProbeState(state);
          return result;
        });
      } catch (error) {
        if (mutatorFailure !== undefined && error === mutatorFailure) throw error;
        throw probeStoreUnavailable();
      }
    },
  };
}
