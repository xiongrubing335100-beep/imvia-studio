(() => {
  const initial = window.__IMVIA_LOVART_STATUS__ || { state: "setup_required", code: "SETUP_REQUIRED" };
  const AUTO_START_KEY = "imvia-lovart-onboarding-completed-v2";
  async function post(pathname) {
    const response = await fetch(pathname, { method: "POST" });
    try {
      const payload = await response.json();
      return payload?.data ?? payload;
    } catch {
      return null;
    }
  }
  function hasCompletedSetup() {
    try {
      const cookie = document.cookie.split(";").some((entry) => entry.trim() === `${AUTO_START_KEY}=1`);
      if (cookie) return true;
    } catch {
      // Fall through to localStorage when the embedded browser disallows cookies.
    }
    try {
      return window.localStorage.getItem(AUTO_START_KEY) === "1";
    } catch {
      return false;
    }
  }
  function rememberCompletedSetup() {
    try {
      document.cookie = `${AUTO_START_KEY}=1; Max-Age=31536000; Path=/; SameSite=Lax`;
      if (document.cookie.split(";").some((entry) => entry.trim() === `${AUTO_START_KEY}=1`)) return;
    } catch {
      // Fall through to localStorage when the embedded browser disallows cookies.
    }
    try { window.localStorage.setItem(AUTO_START_KEY, "1"); } catch { /* best effort */ }
  }
  function startFirstOpen() {
    if (initial?.state !== "setup_required" || hasCompletedSetup()) return;
    void post("/api/v1/lovart/connect").then((result) => {
      const state = result?.state || (result?.status === "connected" ? "connected" : null);
      if (state === "connected") rememberCompletedSetup();
    });
  }
  // The first workbench open must launch the native key form immediately;
  // the workbench itself remains the only visible status surface.
  startFirstOpen();
})();
