(() => {
  const CONNECTED_LABEL = "工作台已连接 · Lovart 已连接";
  const NOT_DETECTED_LABEL = "工作台已连接 · Lovart 未检测";
  const PROVIDER_CONNECTED_LABEL = "工作台已连接 · 提供商已连接";
  const isLovartSelection = () => (document.documentElement.dataset.imviaProvider || "lovart") === "lovart";
  const setupIsActive = () => window.__IMVIA_LOVART_SETUP_ACTIVE__ === true
    || ["setup_active", "validating"].includes(window.__IMVIA_LOVART_STATUS__?.state);

  function removeLegacyStatusLayer() {
    if (setupIsActive()) return;
    const root = document.getElementById("root");
    for (const node of document.querySelectorAll(".imvia-lovart-shell, .imvia-lovart-onboarding, .imvia-lovart-settings")) {
      if (root?.contains(node)) continue;
      node.remove();
    }
  }

  function installConnectionLabelStyle() {
    if (document.getElementById("imvia-connection-label-style")) return;
    const style = document.createElement("style");
    style.id = "imvia-connection-label-style";
    style.textContent = `
      .connection.imvia-connection-label{font-size:0}
      .connection.imvia-connection-label::after{content:attr(data-imvia-connection-label);font-size:12px}
      .connection.imvia-connection-label i{font-size:initial}
    `;
    document.head.appendChild(style);
  }

  function setConnectionLabel(label) {
    const connection = document.querySelector(".connection");
    if (!connection) return false;
    connection.classList.add("imvia-connection-label");
    connection.dataset.imviaConnectionLabel = label;
    connection.setAttribute("aria-label", label);
    return true;
  }

  async function refreshConnectionLabel() {
    // While the native credential form is open, status checks are read-only
    // and must not touch the DOM. This keeps the modal's owning process and
    // the workbench document independent until the user finishes.
    const setupActive = setupIsActive();
    if (!setupActive) removeLegacyStatusLayer();
    if (!isLovartSelection()) {
      if (setupActive) return;
      setConnectionLabel(PROVIDER_CONNECTED_LABEL);
      return;
    }
    try {
      const response = await fetch("/api/v1/lovart/status", { cache: "no-store" });
      const payload = await response.json();
      const data = payload?.data ?? payload;
      window.__IMVIA_LOVART_STATUS__ = data;
      if (setupActive && ["setup_active", "validating"].includes(data?.state)) return;
      if (setupActive) window.__IMVIA_LOVART_SETUP_ACTIVE__ = false;
      removeLegacyStatusLayer();
      setConnectionLabel(data?.state === "connected" || data?.status === "connected" ? CONNECTED_LABEL : NOT_DETECTED_LABEL);
    } catch {
      if (setupActive) return;
      setConnectionLabel(NOT_DETECTED_LABEL);
    }
  }

  function start() {
    installConnectionLabelStyle();
    removeLegacyStatusLayer();
    const observer = new MutationObserver(() => {
      if (!setupIsActive()) removeLegacyStatusLayer();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("imvia:provider-selection-changed", () => { void refreshConnectionLabel(); });
    void refreshConnectionLabel();
    window.setInterval(() => void refreshConnectionLabel(), 3000);
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
