const RECORD_TYPES = new Set(["projects", "history"]);
const STORAGE_PREFIX = "imvia.record-management.v1";

function storageKey(type) {
  if (!RECORD_TYPES.has(type)) throw new TypeError(`Unsupported record type: ${type}`);
  return `${STORAGE_PREFIX}.${type}`;
}

export function readDeletedRecordIds(storage, type) {
  const key = storageKey(type);
  try {
    const parsed = JSON.parse(storage?.getItem?.(key) ?? "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id) => typeof id === "string" && id))]
      : [];
  } catch {
    return [];
  }
}

export function rememberDeletedRecord(storage, type, id) {
  if (typeof id !== "string" || !id) throw new TypeError("Record id is required");
  const ids = readDeletedRecordIds(storage, type);
  if (!ids.includes(id)) ids.push(id);
  storage?.setItem?.(storageKey(type), JSON.stringify(ids));
  return ids;
}

export function filterVisibleRecords(storage, type, records) {
  const deleted = new Set(readDeletedRecordIds(storage, type));
  return Array.isArray(records) ? records.filter((record) => !deleted.has(record?.id)) : [];
}

export function recordIdFromTitle(type, title) {
  storageKey(type);
  const normalized = typeof title === "string" ? title.trim() : "";
  if (!normalized) throw new TypeError("Record title is required");
  return `${type}:${normalized}`;
}

export function liveWorkbenchEmptySeedUrl(href) {
  const url = new URL(href);
  if (url.searchParams.get("imvia") === "live" && !url.searchParams.has("empty")) {
    url.searchParams.set("empty", "1");
  }
  return url.href;
}

export function ensureLiveWorkbenchEmptySeed({ location = globalThis.location, history = globalThis.history } = {}) {
  if (!location?.href || !history?.replaceState) return false;
  const nextUrl = liveWorkbenchEmptySeedUrl(location.href);
  if (nextUrl === location.href) return false;
  history.replaceState(null, "", nextUrl);
  return true;
}

function apiUrl(pathname) {
  const url = new URL(pathname, globalThis.location?.origin ?? "http://127.0.0.1");
  const page = new URL(globalThis.location?.href ?? url.href);
  for (const name of ["session", "bridge_token"]) {
    const value = page.searchParams.get(name);
    if (value) url.searchParams.set(name, value);
  }
  return url;
}

async function persistCurrentProjectName(name, fetchImpl = globalThis.fetch) {
  const stateResponse = await fetchImpl(apiUrl("/api/v1/state"));
  const statePayload = await stateResponse.json();
  if (!stateResponse.ok || !statePayload?.ok) throw new Error(statePayload?.error?.message || "Unable to read the local project");
  const projectId = statePayload.data?.project?.id;
  if (!projectId) throw new Error("The active local project is unavailable");
  const response = await fetchImpl(apiUrl(`/api/v1/projects/${encodeURIComponent(projectId)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Unable to rename the local project");
  return payload.data.project;
}

function pageRecordType() {
  const page = globalThis.location?.hash?.slice(1);
  return page === "projects" || page === "history" ? page : null;
}

function recordTitle(row) {
  return row?.querySelector?.("strong")?.textContent?.trim() || "";
}

export function reconcileHomeProjectCards(document, storage) {
  document?.querySelector?.(".imvia-home-projects-empty")?.remove?.();
  const grid = document?.querySelector?.(".project-grid");
  if (!grid) return { hidden: 0, visible: 0 };
  const deleted = new Set(readDeletedRecordIds(storage, "projects"));
  let hidden = 0;
  let visible = 0;
  for (const row of grid.querySelectorAll(":scope > button")) {
    const title = recordTitle(row);
    const isDeleted = title && deleted.has(recordIdFromTitle("projects", title));
    row.hidden = Boolean(isDeleted);
    if (isDeleted) hidden += 1;
    else visible += 1;
  }
  grid.hidden = visible === 0;
  if (visible === 0) {
    const empty = document.createElement("div");
    empty.className = "page-empty imvia-records-empty imvia-home-projects-empty";
    empty.innerHTML = "<strong>还没有项目</strong><p>创建项目后，最近使用的项目会显示在这里</p>";
    grid.after(empty);
  }
  return { hidden, visible };
}

function closeRecordUi(document) {
  document.querySelectorAll(".imvia-record-actions, .imvia-record-confirm").forEach((element) => element.remove());
}

function showToast(document, message) {
  document.querySelector(".imvia-record-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast imvia-record-toast";
  toast.textContent = message;
  document.body.append(toast);
  globalThis.setTimeout?.(() => toast.remove(), 2600);
}

function confirmDelete(document, storage, type, id, title, reconcile) {
  closeRecordUi(document);
  const heading = type === "projects" ? "确认删除项目" : "确认删除任务记录";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop imvia-record-confirm";
  backdrop.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-label="${heading}"><header><strong>${heading}</strong></header><div class="modal-content"><p class="dialog-message">删除“${title.replace(/[&<>"']/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[value])}”后，本地工作台将不再显示这条记录。</p></div><footer><button type="button" class="secondary-button" data-action="cancel">取消</button><button type="button" class="danger-button" data-action="confirm">确认删除</button></footer></section>`;
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest?.('[data-action="cancel"]')) closeRecordUi(document);
    if (event.target.closest?.('[data-action="confirm"]')) {
      rememberDeletedRecord(storage, type, id);
      closeRecordUi(document);
      reconcile();
      showToast(document, type === "projects" ? "项目已删除" : "历史记录已删除");
    }
  });
  document.body.append(backdrop);
}

function openRecordActions(document, storage, type, row, reconcile) {
  closeRecordUi(document);
  const title = recordTitle(row);
  const id = recordIdFromTitle(type, title);
  const label = type === "projects" ? "项目" : "任务记录";
  const menu = document.createElement("div");
  const bounds = row.getBoundingClientRect();
  menu.className = "imvia-record-actions";
  menu.setAttribute("role", "menu");
  menu.style.top = `${Math.min(globalThis.innerHeight - 70, bounds.top + bounds.height / 2)}px`;
  menu.style.left = `${Math.max(12, bounds.right - 154)}px`;
  menu.innerHTML = `<button type="button" role="menuitem">删除${label}</button>`;
  menu.addEventListener("click", () => confirmDelete(document, storage, type, id, title, reconcile));
  document.body.append(menu);
}

function installStyles(document) {
  if (document.getElementById("imvia-record-management-styles")) return;
  const style = document.createElement("style");
  style.id = "imvia-record-management-styles";
  style.textContent = `
    .wide-list { position: relative; }
    .wide-list > button[hidden] { display:none; }
    .wide-list > .imvia-record-menu-trigger { position:absolute;right:0;width:48px;height:48px;padding:0;border:0;background:transparent;z-index:2;cursor:pointer; }
    .wide-list > .imvia-record-menu-trigger:focus-visible { outline:2px solid var(--accent);outline-offset:-5px;border-radius:9px; }
    .imvia-record-actions { position:fixed;z-index:1200;width:142px;padding:6px;border:1px solid #313a3e;border-radius:10px;background:#1b2124;box-shadow:0 16px 44px #0009; }
    .imvia-record-actions button { width:100%;height:38px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:#ef7774;text-align:left;cursor:pointer; }
    .imvia-record-actions button:hover { background:#ffffff0d; }
    .imvia-records-empty { margin-top:18px; }
  `;
  document.head.append(style);
}

export function installRecordManagement({ document = globalThis.document, storage = globalThis.localStorage, fetchImpl = globalThis.fetch } = {}) {
  if (!document || document.documentElement.dataset.imviaRecordManagement === "installed") return;
  document.documentElement.dataset.imviaRecordManagement = "installed";
  installStyles(document);
  let scheduled = false;
  const reconcile = () => {
    scheduled = false;
    const type = pageRecordType();
    document.querySelectorAll(".imvia-record-menu-trigger").forEach((trigger) => trigger.remove());
    document.querySelectorAll(".imvia-records-empty").forEach((empty) => empty.remove());
    if (globalThis.location?.hash?.slice(1) === "home") {
      reconcileHomeProjectCards(document, storage);
      return;
    }
    if (!type) return;
    const list = document.querySelector(".wide-list");
    if (!list) return;
    const rows = [...list.querySelectorAll(":scope > button")];
    let visible = 0;
    for (const row of rows) {
      const title = recordTitle(row);
      if (!title) continue;
      const id = recordIdFromTitle(type, title);
      const deleted = readDeletedRecordIds(storage, type).includes(id);
      row.hidden = deleted;
      if (deleted) continue;
      visible += 1;
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "imvia-record-menu-trigger";
      trigger.setAttribute("aria-label", `${title}的操作菜单`);
      trigger.style.top = `${row.offsetTop + Math.max(0, (row.offsetHeight - 48) / 2)}px`;
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openRecordActions(document, storage, type, row, schedule);
      });
      list.append(trigger);
    }
    list.hidden = visible === 0;
    if (visible === 0) {
      const empty = document.createElement("div");
      empty.className = "page-empty imvia-records-empty";
      empty.innerHTML = `<strong>${type === "projects" ? "还没有项目" : "没有生成记录"}</strong><p>${type === "projects" ? "创建项目，集中管理同一主题的图片和视频" : "完成生成后，任务记录会显示在这里"}</p>`;
      list.after(empty);
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    globalThis.requestAnimationFrame?.(reconcile) ?? globalThis.setTimeout?.(reconcile, 0);
  };
  const observer = new MutationObserver((mutations) => {
    const meaningful = mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some((node) => !node.classList?.contains?.("imvia-record-menu-trigger") && !node.classList?.contains?.("imvia-records-empty")));
    if (meaningful) schedule();
  });
  observer.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
  globalThis.addEventListener?.("hashchange", schedule);
  globalThis.addEventListener?.("resize", schedule);
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".imvia-record-actions, .imvia-record-menu-trigger")) document.querySelector(".imvia-record-actions")?.remove();
  }, true);
  const persistRename = (input) => {
    const name = input?.value?.trim();
    if (!name || new URLSearchParams(globalThis.location?.search ?? "").get("imvia") !== "live") return;
    persistCurrentProjectName(name, fetchImpl).catch(() => showToast(document, "项目名称保存失败，请重试"));
  };
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    const card = button?.closest?.(".modal-card");
    if (button?.textContent?.trim() === "保存" && card?.querySelector("header strong")?.textContent?.trim() === "重命名当前项目") {
      persistRename(card.querySelector("input"));
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    const input = event.target;
    const card = input?.closest?.(".modal-card");
    if (event.key === "Enter" && input?.matches?.("input") && card?.querySelector("header strong")?.textContent?.trim() === "重命名当前项目") persistRename(input);
  }, true);
  schedule();
  return { disconnect: () => observer.disconnect(), reconcile: schedule };
}

const recordManagement = Object.freeze({
  readDeletedRecordIds,
  rememberDeletedRecord,
  filterVisibleRecords,
  recordIdFromTitle,
  liveWorkbenchEmptySeedUrl,
  ensureLiveWorkbenchEmptySeed,
  reconcileHomeProjectCards,
  installRecordManagement,
});

if (typeof globalThis !== "undefined") {
  ensureLiveWorkbenchEmptySeed();
  globalThis.__IMVIA_RECORD_MANAGEMENT__ = recordManagement;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => installRecordManagement(), { once: true });
  else installRecordManagement();
}

export default recordManagement;
