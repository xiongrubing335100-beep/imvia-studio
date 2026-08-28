import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let cachedBundle;

function escapeInlineScript(source) {
  return source.replaceAll("</script", "<\\/script").replaceAll("</SCRIPT", "<\\/SCRIPT");
}

function mcpAppsBundle() {
  if (cachedBundle) return cachedBundle;
  const source = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const exportStart = source.lastIndexOf("export{");
  if (exportStart < 0) throw new Error("MCP Apps browser bundle is missing its export block.");
  const exportBlock = source.slice(exportStart).match(/^export\{([^}]+)\};?\s*$/s);
  if (!exportBlock) throw new Error("Unable to parse the MCP Apps browser bundle.");
  const exportMap = new Map();
  for (const rawEntry of exportBlock[1].split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split(/\s+as\s+/);
    exportMap.set((parts[1] || parts[0]).trim(), parts[0].trim());
  }
  const required = ["App", "applyDocumentTheme", "applyHostFonts", "applyHostStyleVariables"];
  for (const name of required) if (!exportMap.has(name)) throw new Error(`MCP Apps bundle is missing ${name}.`);
  cachedBundle = [
    source.slice(0, exportStart),
    `;globalThis.__IMVIA_MCP_APPS__={${required.map((name) => `${JSON.stringify(name)}:${exportMap.get(name)}`).join(",")}};`,
  ].join("");
  return cachedBundle;
}

function bridgeScript() {
  return `(() => {
  // ext-apps App.sendMessage() is the MCP Apps ui/message (role=user) host request.
  const apps = globalThis.__IMVIA_MCP_APPS__;
  const bridgeId = (globalThis.crypto?.randomUUID?.() || ('bridge-' + Date.now() + '-' + Math.random().toString(16).slice(2)));
  const status = (text) => { const node = document.querySelector('[data-bridge-status]'); if (node) node.textContent = text; };
  if (!apps || typeof apps.App !== 'function') { status('会话桥接运行库未挂载，请从当前 Codex 会话重新打开工作台'); return; }
  let app;
  let closed = false;
  let lastDispatchId = null;
  let sessionId = null;
  let openToken = '';
  let started = false;
  let startPromise = null;
  const call = (name, args) => app.callServerTool({ name, arguments: args });
  function toolData(output) {
    const result = output || {};
    return result?.data || result?.structuredContent?.data || result?.structuredContent || result || {};
  }
  function acceptToolOutput(output) {
    const data = toolData(output);
    const nextSessionId = data.workbench_session_id || data.workbenchSessionId;
    if (!nextSessionId) return false;
    sessionId = nextSessionId;
    openToken = data.open_token || data.openToken || '';
    return true;
  }
  async function register() {
    await call('imvia_register_conversation_bridge', { session_id: sessionId, open_token: openToken, bridge_id: bridgeId });
    status('会话桥接已就绪，等待工作台任务');
  }
  async function heartbeat() {
    try { await call('imvia_heartbeat_conversation_bridge', { session_id: sessionId, bridge_id: bridgeId }); }
    catch (error) { status('会话桥接已失联，正在重连'); throw error; }
  }
  async function deliver() {
    const claimed = await call('imvia_claim_next_workbench_dispatch', { session_id: sessionId, bridge_id: bridgeId });
    const item = claimed?.structuredContent?.data || claimed?.structuredContent || claimed?.data || {};
    const dispatch = item.dispatch;
    if (!dispatch || dispatch.id === lastDispatchId) return;
    lastDispatchId = dispatch.id;
    status('正在把工作台任务发送到当前 Codex 会话');
    try {
      await app.sendMessage({ role: 'user', content: [{ type: 'text', text: dispatch.message }] });
      await call('imvia_mark_dispatch_host_accepted', {
        dispatch_id: dispatch.dispatch_id || dispatch.id,
        session_id: sessionId,
        bridge_id: bridgeId,
        claim_token: dispatch.claim_token,
      });
      status('工作台任务已进入当前 Codex 会话，等待处理');
    } catch (error) {
      await call('imvia_release_dispatch_claim', {
        dispatch_id: dispatch.dispatch_id || dispatch.id,
        session_id: sessionId,
        bridge_id: bridgeId,
        claim_token: dispatch.claim_token,
        error: { code: 'HOST_MESSAGE_FAILED', message: String(error?.message || error) },
      }).catch(() => undefined);
      lastDispatchId = null;
      status('发送失败，正在等待重试');
    }
  }
  async function startBridge() {
    if (started) return;
    if (startPromise) return startPromise;
    if (!sessionId) { status('等待当前 Codex 会话提供工作台绑定'); return; }
    if (!app?.getHostCapabilities?.()?.message) {
      status('当前 Codex 会话不支持 ui/message，任务不会伪装成已送达');
      return;
    }
    startPromise = (async () => {
      app = app || new apps.App({ name: 'imvia-studio-conversation-bridge', version: '1.0.0' }, {}, { autoResize: true });
      await register();
      started = true;
      setInterval(() => { if (!closed) heartbeat().catch(() => undefined); }, 5000);
      setInterval(() => { if (!closed) deliver().catch(() => status('会话桥接暂时不可用，正在重试')); }, 1000);
      await deliver();
    })().catch((error) => {
      status('会话桥接启动失败，请重新打开工作台');
      console.error(error);
      throw error;
    }).finally(() => { startPromise = null; });
    return startPromise;
  }
  async function run() {
    try {
      app = new apps.App({ name: 'imvia-studio-conversation-bridge', version: '1.0.0' }, {}, { autoResize: true });
      // MCP Apps delivers the result that instantiated this resource through
      // ui/notifications/tool-result. Reading window.openai.toolOutput here
      // is an OpenAI Apps SDK compatibility path only; it is not reliable in
      // an MCP Apps host and previously made the bridge stop before register.
      app.ontoolresult = (output) => {
        if (acceptToolOutput(output)) startBridge().catch(() => undefined);
      };
      await app.connect();
      // Keep compatibility with hosts that expose the initial tool result on
      // the OpenAI Apps SDK global, but do not treat its absence as failure.
      if (acceptToolOutput(globalThis.openai?.toolOutput)) await startBridge();
      else status('已挂载会话桥，等待当前 Codex 会话绑定');
    } catch (error) { status('会话桥接启动失败，请重新打开工作台'); console.error(error); }
  }
  globalThis.addEventListener('beforeunload', () => { closed = true; });
  run();
})();`;
}

export function buildConversationBridgeHtml() {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IMVIA Studio 会话桥</title><style>html,body{margin:0;min-height:100%;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#eee}body{padding:16px;box-sizing:border-box}.card{border:1px solid #2e3a3d;border-radius:14px;padding:16px;background:#161b1d}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#f0cc47;margin-right:8px}.label{color:#aeb8ba;line-height:1.5}</style></head><body><div class="card"><div><span class="dot"></span><span data-bridge-status>正在挂载会话桥接</span></div><div class="label">工作台任务会通过当前 Codex 会话交给 IMVIA Studio MCP 执行。</div></div><script>${escapeInlineScript(mcpAppsBundle())}</script><script>${escapeInlineScript(bridgeScript())}</script></body></html>`;
  return body;
}
