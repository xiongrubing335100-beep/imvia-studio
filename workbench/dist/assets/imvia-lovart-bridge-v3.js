(() => {
  const initial = window.__IMVIA_LOVART_STATUS__ || { state: "setup_required", code: "SETUP_REQUIRED" };
  const AUTO_START_KEY = "imvia-lovart-onboarding-started-v1";
  async function post(pathname) {
    await fetch(pathname, { method: "POST" });
  }
  function claimAutoStart() {
    try {
      if (window.localStorage.getItem(AUTO_START_KEY) === "1") return false;
      window.localStorage.setItem(AUTO_START_KEY, "1");
    } catch {
      // If storage is unavailable, the server-side onboarding state still
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
