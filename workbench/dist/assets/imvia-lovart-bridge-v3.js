(() => {
  const initial = window.__IMVIA_LOVART_STATUS__ || { state: "setup_required", code: "SETUP_REQUIRED" };
  const AUTO_START_KEY = "imvia-lovart-onboarding-started-v1";
  const messages = {
    setup_required: "首次打开会自动弹出 Lovart 密钥填写框。",
    setup_active: "正在打开安全输入框…",
    validating: "正在验证 Lovart 连接…",
    cancelled: "连接设置已取消，可以稍后重试。",
    failed: "连接设置未完成，请检查状态后重试。",
  };
  const codeMessages = {
    AUTHENTICATION_FAILED: "Lovart 密钥无效，请重试。",
    HELPER_NOT_PACKAGED: "连接组件不完整，请修复插件后重试。",
    PLATFORM_UNSUPPORTED: "当前系统暂不支持 Lovart 连接。",
    CREDENTIAL_STORE_DENIED: "系统凭据存储拒绝了访问，请检查权限。",
    UPSTREAM_UNREACHABLE: "暂时无法访问 Lovart，请稍后重试。",
    UPSTREAM_SECURITY_REJECTED: "连接组件完整性校验失败。",
  };
  const root = document.createElement("div");
  root.className = "imvia-lovart-shell";
  root.innerHTML = `
    <aside data-imvia-lovart-onboarding aria-live="polite" hidden>
      <p class="imvia-lovart-onboarding-title"></p>
      <p class="imvia-lovart-onboarding-detail"></p>
      <button type="button" data-imvia-lovart-retry>重试连接</button>
    </aside>
    <span data-imvia-lovart-connected class="imvia-lovart-connected" hidden>Lovart 已连接</span>
    <details class="imvia-lovart-settings">
      <summary>Lovart 设置</summary>
      <button type="button" data-imvia-lovart-replace>更换密钥</button>
      <button type="button" data-imvia-lovart-disconnect>断开连接</button>
    </details>`;
  document.body.append(root);
  const onboarding = root.querySelector("[data-imvia-lovart-onboarding]");
  const title = root.querySelector(".imvia-lovart-onboarding-title");
  const detail = root.querySelector(".imvia-lovart-onboarding-detail");
  const connected = root.querySelector("[data-imvia-lovart-connected]");
  const retry = root.querySelector("[data-imvia-lovart-retry]");
  const settings = root.querySelector(".imvia-lovart-settings");

  function stateOf(value) {
    if (value?.state) return value;
    return value?.status === "connected" ? { state: "connected", code: "CONNECTED" } : { state: "setup_required", code: value?.code };
  }
  function render(value) {
    const current = stateOf(value);
    const isConnected = current.state === "connected";
    connected.hidden = !isConnected;
    settings.hidden = !isConnected;
    onboarding.hidden = isConnected;
    if (isConnected) return;
    title.textContent = messages[current.state] || messages.failed;
    detail.textContent = codeMessages[current.code] || "不会执行生成、上传或扣费操作。";
    retry.hidden = current.state === "setup_active" || current.state === "validating";
  }
  async function post(pathname) {
    await fetch(pathname, { method: "POST" });
  }
  function claimAutoStart() {
    try {
      if (window.sessionStorage.getItem(AUTO_START_KEY) === "1") return false;
      window.sessionStorage.setItem(AUTO_START_KEY, "1");
    } catch {
      // Private browsing may deny sessionStorage; still honor this one page
      // load and let the server-side onboarding state prevent duplicates.
    }
    return true;
  }
  function startFirstOpen() {
    if (stateOf(initial).state !== "setup_required" || !claimAutoStart()) return;
    retry.disabled = true;
    void post("/api/v1/lovart/connect").finally(() => { retry.disabled = false; });
  }
  retry.addEventListener("click", () => { retry.disabled = true; void post("/api/v1/lovart/connect").finally(() => { retry.disabled = false; }); });
  root.querySelector("[data-imvia-lovart-replace]").addEventListener("click", () => { void post("/api/v1/lovart/connect"); });
  root.querySelector("[data-imvia-lovart-disconnect]").addEventListener("click", () => {
    if (window.confirm("确定断开 IMVIA Studio 的 Lovart 连接吗？")) void post("/api/v1/lovart/disconnect");
  });
  render(initial);
  // The first workbench open must launch the native key form immediately;
  // users should not have to discover a secondary retry button first.
  startFirstOpen();

  let poll;
  const events = new EventSource("/api/v1/events");
  events.addEventListener("lovart.onboarding", (event) => {
    try { render(JSON.parse(event.data)); } catch { /* ignore malformed UI event */ }
  });
  events.addEventListener("error", () => {
    events.close();
    if (!poll) poll = window.setInterval(async () => {
      try { const response = await fetch("/api/v1/lovart/status", { cache: "no-store" }); render((await response.json()).data); } catch { /* retry on next interval */ }
    }, 5000);
  });
})();
