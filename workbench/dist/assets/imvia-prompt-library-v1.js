const STORAGE_KEY = "imvia-studio:prompt-library:v1";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/gu, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
}[character]));

export function normalizePromptEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries.flatMap((entry) => {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    if (!id || !text || seen.has(text)) return [];
    seen.add(text);
    return [{ id, text, created_at: typeof entry.created_at === "string" ? entry.created_at : "" }];
  });
}

export function savePromptEntry(entries, text, { id, createdAt } = {}) {
  const normalized = normalizePromptEntries(entries);
  const prompt = String(text ?? "").trim();
  if (!prompt || normalized.some((entry) => entry.text === prompt)) return normalized;
  return [{
    id: id || globalThis.crypto?.randomUUID?.() || `prompt-${Date.now()}`,
    text: prompt,
    created_at: createdAt || new Date().toISOString(),
  }, ...normalized].slice(0, 100);
}

export function deletePromptEntry(entries, id) {
  return normalizePromptEntries(entries).filter((entry) => entry.id !== id);
}

export function applyPromptToTextarea(textarea, text) {
  if (!textarea) return false;
  const view = textarea.ownerDocument?.defaultView || globalThis;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement?.prototype || {}, "value")?.set;
  if (setter) setter.call(textarea, String(text ?? "")); else textarea.value = String(text ?? "");
  const EventConstructor = view.Event || globalThis.Event;
  textarea.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  textarea.focus?.();
  return true;
}

export function renderPromptLibraryEntries(entries) {
  const normalized = normalizePromptEntries(entries);
  if (!normalized.length) return '<div class="imvia-prompt-library-empty">还没有保存的提示词</div>';
  return normalized.map((entry) => `<article class="imvia-prompt-entry" data-prompt-id="${escapeHtml(entry.id)}"><p>${escapeHtml(entry.text)}</p><div><button type="button" data-action="apply">调用</button><button type="button" data-action="delete" aria-label="删除提示词">删除</button></div></article>`).join("");
}

export function renderPromptLibraryDialog({ entries = [], editing = false, draftText = "" } = {}) {
  const controls = editing
    ? `<div class="imvia-prompt-editor"><textarea aria-label="提示词内容" placeholder="填写要保存的提示词" autofocus>${escapeHtml(draftText)}</textarea><div><button type="button" data-action="cancel-add">取消</button><button type="button" data-action="save-add">保存</button></div></div>`
    : '<div class="imvia-prompt-library-toolbar"><span>保存常用提示词，随时调用到创意描述中</span><button type="button" data-action="start-add">添加提示词</button></div>';
  return `<section class="imvia-prompt-library-card" role="dialog" aria-modal="true" aria-label="提示词库"><header><strong>提示词库</strong><button type="button" class="imvia-prompt-library-close" data-action="close" aria-label="关闭">×</button></header>${controls}<div class="imvia-prompt-library-list">${renderPromptLibraryEntries(entries)}</div></section>`;
}

function installPromptLibrary() {
  if (document.documentElement.dataset.imviaPromptLibraryInstalled) return;
  document.documentElement.dataset.imviaPromptLibraryInstalled = "true";
  const style = document.createElement("style");
  style.textContent = `
    .imvia-prompt-assistant-hidden{display:none!important}
    #imvia-prompt-library{position:fixed;z-index:460;inset:0;padding:24px;display:grid;place-items:center;background:#030506b8;backdrop-filter:blur(8px)}
    #imvia-prompt-library .imvia-prompt-library-card{width:min(560px,calc(100vw - 40px));max-height:min(720px,calc(100vh - 48px));overflow:hidden;border-radius:15px;display:flex;flex-direction:column;background:#171c1f;color:#e7eded;box-shadow:0 30px 90px #00000094,inset 0 0 0 1px #ffffff0e}
    #imvia-prompt-library header{height:58px;padding:0 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #252c30}
    #imvia-prompt-library header strong{font-size:14px}#imvia-prompt-library button{border:0;cursor:pointer}
    #imvia-prompt-library .imvia-prompt-library-close{width:32px;height:32px;padding:0;border-radius:9px;background:#21272a;color:#bfc8ca;font-size:20px}
    #imvia-prompt-library .imvia-prompt-library-toolbar{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #252c30;color:#7e888b;font-size:11px}
    #imvia-prompt-library .imvia-prompt-library-toolbar button{height:36px;padding:0 14px;border-radius:9px;background:#3f9095;color:#f2ffff;font-size:11px;font-weight:600}
    #imvia-prompt-library .imvia-prompt-editor{padding:14px 18px;display:grid;gap:10px;border-bottom:1px solid #252c30;background:#13181b}
    #imvia-prompt-library .imvia-prompt-editor textarea{width:100%;min-height:118px;padding:11px 12px;resize:vertical;border:1px solid #30383c;border-radius:10px;outline:0;color:#e4eaeb;background:#0d1214;font-size:11.5px;line-height:1.65}
    #imvia-prompt-library .imvia-prompt-editor textarea:focus{border-color:#57d6d8;box-shadow:0 0 0 2px #57d6d824}
    #imvia-prompt-library .imvia-prompt-editor>div{display:flex;justify-content:flex-end;gap:8px}
    #imvia-prompt-library .imvia-prompt-editor button{height:33px;padding:0 13px;border-radius:8px;background:#252c30;color:#bfc8ca;font-size:10.5px}
    #imvia-prompt-library .imvia-prompt-editor button[data-action="save-add"]{background:#3f9095;color:#f2ffff;font-weight:600}
    #imvia-prompt-library .imvia-prompt-library-list{padding:12px 18px 18px;display:grid;gap:9px;overflow:auto}
    #imvia-prompt-library .imvia-prompt-library-empty{min-height:150px;display:grid;place-items:center;color:#6f797c;font-size:12px}
    #imvia-prompt-library .imvia-prompt-entry{padding:12px;border-radius:11px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;background:#111619}
    #imvia-prompt-library .imvia-prompt-entry p{max-height:66px;margin:0;overflow:hidden;color:#cbd2d4;font-size:11.5px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
    #imvia-prompt-library .imvia-prompt-entry>div{display:flex;gap:7px}
    #imvia-prompt-library .imvia-prompt-entry button{height:31px;padding:0 11px;border-radius:8px;background:#253034;color:#cfe9ea;font-size:10.5px}
    #imvia-prompt-library .imvia-prompt-entry button[data-action="delete"]{background:#2a2022;color:#d8a7ab}
  `;
  document.head.appendChild(style);

  const read = () => {
    try { return normalizePromptEntries(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]")); }
    catch { return []; }
  };
  const write = (entries) => window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePromptEntries(entries)));
  const textarea = () => document.querySelector('.prompt-box textarea[aria-label="创意描述"]');

  function hidePromptAssistant() {
    for (const button of document.querySelectorAll(".prompt-section .field-title .text-action")) {
      if (button.textContent?.replace(/\s+/gu, "") !== "提示词助手") continue;
      button.classList.add("imvia-prompt-assistant-hidden");
      button.setAttribute("aria-hidden", "true");
      button.tabIndex = -1;
    }
  }

  function openLibrary() {
    document.getElementById("imvia-prompt-library")?.remove();
    const modal = document.createElement("div");
    modal.id = "imvia-prompt-library";
    modal.setAttribute("role", "presentation");
    document.body.appendChild(modal);
    let entries = read();
    let editing = false;
    const renderModal = (draftText = "") => {
      modal.innerHTML = renderPromptLibraryDialog({ entries, editing, draftText });
      if (editing) window.requestAnimationFrame(() => modal.querySelector('textarea[aria-label="提示词内容"]')?.focus());
    };
    renderModal();
    const close = () => modal.remove();
    modal.addEventListener("mousedown", (event) => { if (event.target === modal) close(); });
    modal.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "close") { close(); return; }
      if (button.dataset.action === "start-add") { editing = true; renderModal(); return; }
      if (button.dataset.action === "cancel-add") { editing = false; renderModal(); return; }
      if (button.dataset.action === "save-add") {
        const editor = modal.querySelector('textarea[aria-label="提示词内容"]');
        const prompt = editor?.value?.trim() || "";
        if (!prompt) { editor?.focus(); return; }
        entries = savePromptEntry(entries, prompt);
        write(entries);
        editing = false;
        renderModal();
        return;
      }
      const entryElement = button.closest("[data-prompt-id]");
      const entry = entries.find((item) => item.id === entryElement?.dataset.promptId);
      if (!entry) return;
      if (button.dataset.action === "apply") {
        applyPromptToTextarea(textarea(), entry.text);
        close();
        return;
      }
      if (button.dataset.action === "delete") {
        entries = deletePromptEntry(entries, entry.id);
        write(entries);
        renderModal();
      }
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".prompt-tools button");
    if (!button || button.textContent?.replace(/\s+/gu, "") !== "灵感库") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openLibrary();
  }, true);
  new MutationObserver(hidePromptAssistant).observe(document.body, { childList: true, subtree: true });
  hidePromptAssistant();
}

if (typeof document !== "undefined") installPromptLibrary();
