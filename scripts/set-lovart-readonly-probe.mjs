import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProbeStore } from "../src/probe/probe-store.js";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1 || !["enable", "disable"].includes(arguments_[0])) {
  console.error("Usage: set-lovart-readonly-probe.mjs enable|disable");
  process.exitCode = 1;
} else {
  const dataDirectory = process.env.IMVIA_DATA_DIR
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.imvia-studio-dev");
  const probeStore = createProbeStore({ dataDirectory });
  await probeStore.update((state) => {
    state.enabled = arguments_[0] === "enable";
    return { enabled: state.enabled };
  });
}
