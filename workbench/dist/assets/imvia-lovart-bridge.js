(() => {
  const panel = document.createElement("aside");
  panel.setAttribute("aria-label", "Lovart connection");
  panel.innerHTML = `<span class="imvia-lovart-status" data-status="unknown">Lovart 未连接</span><button type="button" class="imvia-lovart-connect">连接 Lovart</button>`;
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
  const button = panel.querySelector(".imvia-lovart-connect");
  Object.assign(button.style, { border: "0", borderRadius: "8px", padding: "7px 11px", background: "#e4f16b", color: "#16191b", font: "600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif", cursor: "pointer" });
  const setStatus = (value, connected = false) => {
    status.textContent = value;
    status.dataset.status = connected ? "connected" : "unknown";
    button.textContent = connected ? "重新连接" : "连接 Lovart";
  };
  const read = (url, options) => fetch(url, options).then(async (response) => {
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || "Lovart 连接失败");
    return payload.data;
  });
  const refresh = () => read("/api/v1/lovart/status").then((data) => setStatus(data.status === "connected" ? "Lovart 已连接" : "Lovart 未连接", data.status === "connected")).catch(() => setStatus("Lovart 未连接"));
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.style.opacity = ".65";
    setStatus("正在打开安全输入框…");
    try {
      const data = await read("/api/v1/lovart/connect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setStatus(data.status === "connected" ? "Lovart 已连接" : "Lovart 未连接", data.status === "connected");
    } catch (error) {
      setStatus(error.message || "Lovart 未连接");
    } finally {
      button.disabled = false;
      button.style.opacity = "1";
    }
  });
  document.body.append(panel);
  refresh();
})();
