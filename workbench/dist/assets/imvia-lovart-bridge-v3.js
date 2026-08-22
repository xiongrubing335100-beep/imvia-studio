(() => {
  const initial = window.__IMVIA_LOVART_STATUS__ || { state: "setup_required", code: "SETUP_REQUIRED" };
  const AUTO_START_KEY = "imvia-lovart-onboarding-started-v1";
  async function post(pathname) {
    await fetch(pathname, { method: "POST" });
  }
  function claimAutoStart() {
    try {
      const cookie = document.cookie.split(";").some((entry) => entry.trim() === `${AUTO_START_KEY}=1`);
      if (cookie) return false;
      // Cookies are intentionally used in addition to localStorage because
      // the local workbench port may change between launches; cookies remain
      // scoped to this machine/host without being tied to a port.
      document.cookie = `${AUTO_START_KEY}=1; Max-Age=31536000; Path=/; SameSite=Lax`;
      if (document.cookie.split(";").some((entry) => entry.trim() === `${AUTO_START_KEY}=1`)) return true;
    } catch {
      // Fall through to localStorage when the embedded browser disallows cookies.
    }
    try {
      if (window.localStorage.getItem(AUTO_START_KEY) === "1") return false;
      window.localStorage.setItem(AUTO_START_KEY, "1");
    } catch {
      // If both stores are unavailable, the server-side onboarding state still
      // prevents duplicate prompts while this page remains open.
    }
    return true;
  }
  function startFirstOpen() {
    if (initial?.state !== "setup_required" || !claimAutoStart()) return;
    void post("/api/v1/lovart/connect");
  }
  // The first workbench open must launch the native key form immediately;
  // the workbench itself remains the only visible status surface.
  startFirstOpen();
})();
