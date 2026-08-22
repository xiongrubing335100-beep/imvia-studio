const TERMINAL_CODES = new Set(["SETUP_CANCELLED", "CREDENTIAL_SETUP_CANCELLED"]);

function snapshotFor(value) {
  const state = value?.state || (value?.status === "connected" ? "connected" : "setup_required");
  const snapshot = { state };
  if (typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)) snapshot.code = value.code;
  if (typeof value?.checked_at === "string") snapshot.checked_at = value.checked_at;
  return Object.freeze(snapshot);
}

export function createOnboardingService({ credentialService, connect, now = () => Date.now() } = {}) {
  if (!credentialService?.status || typeof connect !== "function") throw new TypeError("credentialService and connect are required");
  const clearCredentials = typeof credentialService.clear === "function"
    ? () => credentialService.clear()
    : async () => ({ status: "setup_required", code: "SETUP_REQUIRED" });
  let snapshot = Object.freeze({ state: "setup_required" });
  let activePromise = null;
  const listeners = new Set();

  function publish(value) {
    snapshot = snapshotFor({ ...value, checked_at: value?.checked_at || (value?.state === "connected" ? new Date(now()).toISOString() : undefined) });
    const event = Object.freeze({ type: "lovart.onboarding", data: snapshot });
    for (const listener of listeners) {
      try { listener(event); } catch { /* one subscriber cannot stop the state machine */ }
    }
    return snapshot;
  }

  async function complete(result) {
    if (result?.status === "connected") return publish({ state: "connected", code: "CONNECTED", checked_at: result.checked_at });
    const code = typeof result?.code === "string" ? result.code : "SETUP_REQUIRED";
    if (TERMINAL_CODES.has(code)) return publish({ state: "cancelled", code: "SETUP_CANCELLED" });
    return publish({ state: "failed", code });
  }

  function start() {
    if (activePromise) return activePromise;
    publish({ state: "setup_active", code: "SETUP_ACTIVE" });
    activePromise = Promise.resolve()
      .then(() => connect({ onState: (state) => publish({ state }) }))
      .then(complete, (error) => publish({ state: "failed", code: typeof error?.code === "string" ? error.code : "HELPER_LAUNCH_FAILED" }))
      .finally(() => { activePromise = null; });
    return activePromise;
  }

  async function status() {
    if (activePromise) return snapshot;
    if (snapshot.state === "connected") return snapshot;
    try {
      const current = await credentialService.status();
      if (current?.status === "connected") return publish({ state: "connected", code: "CONNECTED", checked_at: current.checked_at });
      if (snapshot.state === "connected" && current?.status !== "connected") return publish({ state: "setup_required", code: current?.code || "SETUP_REQUIRED" });
      if (current?.status === "unsupported") return publish({ state: "failed", code: "PLATFORM_UNSUPPORTED" });
      if (snapshot.state === "failed" || snapshot.state === "cancelled" || snapshot.state === "setup_required") return snapshot;
      return publish({ state: "setup_required", code: current?.code || "SETUP_REQUIRED" });
    } catch (error) {
      return publish({ state: "failed", code: typeof error?.code === "string" ? error.code : "HELPER_NOT_PACKAGED" });
    }
  }

  async function ensureStarted() {
    if (activePromise) return snapshot;
    const current = await status();
    if (current.state === "connected" || current.state === "failed" && current.code === "PLATFORM_UNSUPPORTED") return current;
    start();
    return snapshot;
  }

  async function retry() { return activePromise ? snapshot : ensureStarted(); }
  async function replace() { if (activePromise) return snapshot; start(); return snapshot; }
  async function disconnect() {
    if (activePromise) await activePromise;
    const result = await clearCredentials();
    if (result?.status === "unsupported") return publish({ state: "failed", code: "PLATFORM_UNSUPPORTED" });
    return publish({ state: "setup_required", code: result?.code || "SETUP_REQUIRED" });
  }

  return Object.freeze({
    status: () => (activePromise ? snapshot : status()),
    ensureStarted,
    retry,
    replace,
    disconnect,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("listener is required");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
