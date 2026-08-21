(() => {
  const parameters = new URLSearchParams(window.location.search);
  const redirectedStatus = parameters.get("lovart");
  const redirectedCode = parameters.get("code");
  const bootstrapped = window.__IMVIA_LOVART_STATUS__ || { status: "not_connected" };
  const connection = redirectedStatus === "connected" || redirectedStatus === "not_connected"
    ? { status: redirectedStatus, code: redirectedCode }
    : bootstrapped;
  const labels = {
    AUTHENTICATION_FAILED: "Lovart 密钥无效",
    CONNECTION_UNAVAILABLE: "Lovart 连接服务不可用",
    UPSTREAM_RATE_LIMITED: "Lovart 请求过于频繁",
    UPSTREAM_SECURITY_REJECTED: "Lovart 安全校验失败",
    UPSTREAM_UNAVAILABLE: "Lovart 服务暂时不可用",
    UPSTREAM_UNREACHABLE: "Lovart 网络不可达",
  };
  const panel = document.createElement("aside");
  panel.setAttribute("aria-label", "Lovart connection");
  panel.innerHTML = `<span class="imvia-lovart-status"></span><form method="post" action="/workbench/lovart/connect"><button type="submit" class="imvia-lovart-connect"></button></form>`;
  Object.assign(panel.style, {
    position: "fixed",
    top: "14px",
    right: "18px",
    zIndex: "9999",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px 8px 12px",
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: "12px",
    background: "rgba(22,25,27,.94)",
    color: "#dce4e5",
    font: "12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    boxShadow: "0 8px 24px rgba(0,0,0,.22)",
  });
  const status = panel.querySelector(".imvia-lovart-status");
  const form = panel.querySelector("form");
  const button = panel.querySelector(".imvia-lovart-connect");
  Object.assign(form.style, { margin: "0" });
  Object.assign(button.style, { border: "0", borderRadius: "8px", padding: "7px 11px", background: "#e4f16b", color: "#16191b", font: "600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif", cursor: "pointer" });
  const connected = connection.status === "connected";
  status.textContent = connected ? "Lovart 已连接" : (labels[connection.code] || "Lovart 未连接");
  status.dataset.status = connected ? "connected" : "not_connected";
  button.textContent = connected ? "重新连接" : "连接 Lovart";
  form.addEventListener("submit", () => {
    status.textContent = "正在打开安全输入框…";
    button.disabled = true;
    button.style.opacity = ".65";
  });
  document.body.append(panel);
})();
