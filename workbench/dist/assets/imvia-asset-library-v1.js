const GENERATED_LIBRARY_STORAGE_KEY = "imvia-studio:generated-library:v1";
const ASSET_LIBRARY_EVENTS_VERSION = "bulk-controls-v2";

export function droppedImageFiles(files) {
  return Array.from(files || []).filter((file) => String(file?.type || "").toLowerCase().startsWith("image/"));
}

export function toggleMaterialSelection(selectedKeys, key) {
  const selected = Array.from(selectedKeys || []).filter(Boolean);
  if (!key) return selected;
  return selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key];
}

export function generatedMaterialsAfterDeletion(items, { artifactIds = [], all = false } = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  if (all) return [];
  const removed = new Set(Array.from(artifactIds || []).filter(Boolean));
  return safeItems.filter((item) => !removed.has(item?.artifact_id));
}

export function materialDeletionRequest(selectedKeys, { all = false } = {}) {
  const request = { all: Boolean(all), assetIds: [], artifactIds: [] };
  for (const key of Array.from(selectedKeys || [])) {
    if (typeof key !== "string") continue;
    if (key.startsWith("asset:")) request.assetIds.push(key.slice("asset:".length));
    if (key.startsWith("artifact:")) request.artifactIds.push(key.slice("artifact:".length));
  }
  return request;
}

export const generatedLibraryStorageKey = GENERATED_LIBRARY_STORAGE_KEY;
export const assetLibraryEventsVersion = ASSET_LIBRARY_EVENTS_VERSION;

export function assetLibraryEventsNeedInstall(marker) {
  return marker !== ASSET_LIBRARY_EVENTS_VERSION;
}

export function assignTextIfChanged(node, value) {
  if (!node) return false;
  const next = String(value ?? "");
  if (node.textContent === next) return false;
  node.textContent = next;
  return true;
}

export function selectionAfterBulkControl(action, state = {}) {
  const currentMode = Boolean(state.selectionMode);
  const currentKeys = Array.from(state.selectedKeys || []);
  if (action !== "toggle-selection") return { selectionMode: currentMode, selectedKeys: currentKeys };
  const nextMode = !currentMode;
  return { selectionMode: nextMode, selectedKeys: nextMode ? currentKeys : [] };
}

export function bulkActionFromEvent(event) {
  const selector = "#imvia-asset-bulk-controls [data-action]";
  for (const node of event?.composedPath?.() || []) {
    if (node?.matches?.(selector)) return node.dataset?.action || null;
  }
  const target = event?.target;
  return target?.closest?.(selector)?.dataset?.action
    || target?.parentElement?.closest?.(selector)?.dataset?.action
    || null;
}

export function findBulkControlSlot(toolbar) {
  return Array.from(toolbar?.children || []).find((child) => child?.tagName === "SPAN") || null;
}

let selectedKeys = [];
let selectionMode = false;
let deleting = false;

function compactText(node) {
  return String(node?.textContent || "").replace(/\s+/gu, " ").trim();
}

function cardKey(card) {
  const artifactId = card?.dataset?.artifactId;
  if (artifactId) return "artifact:" + artifactId;
  const source = card?.querySelector?.("img,video")?.getAttribute?.("src") || "";
  const name = compactText(card?.querySelector?.("strong"));
  return source || name ? "asset:" + encodeURIComponent(source + "|" + name) : null;
}

function generatedLibrary(windowRoot) {
  try {
    const parsed = JSON.parse(windowRoot.localStorage.getItem(GENERATED_LIBRARY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function showToast(documentRoot, message, error = false) {
  let toast = documentRoot.getElementById("imvia-workbench-toast");
  if (!toast) {
    toast = documentRoot.createElement("div");
    toast.id = "imvia-workbench-toast";
    documentRoot.body.appendChild(toast);
  }
  toast.className = error ? "error" : "";
  toast.textContent = message;
}

function installStyle(documentRoot) {
  if (documentRoot.getElementById("imvia-asset-library-style")) return;
  const style = documentRoot.createElement("style");
  style.id = "imvia-asset-library-style";
  style.textContent = [
    "#imvia-asset-bulk-controls{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-left:auto}",
    "#imvia-asset-bulk-controls button{height:32px;padding:0 12px;border:1px solid #30383c;border-radius:9px;color:#cfd7d9;background:#1a2024;font:inherit;font-size:11px;cursor:pointer}",
    "#imvia-asset-bulk-controls button:hover{border-color:#57d6d8;color:#efffff}",
    "#imvia-asset-bulk-controls button.danger{border-color:#69383b;color:#f0a4a7;background:#251719}",
    "#imvia-asset-bulk-controls button[hidden]{display:none}",
    "#imvia-asset-bulk-controls span{min-width:54px;color:#8d989b;font-size:10px;text-align:right}",
    ".library-toolbar>.imvia-asset-bulk-slot{min-width:0;display:flex;align-items:center;justify-content:flex-end}",
    ".assets-page.imvia-bulk-selecting .asset-card{cursor:copy}",
    ".assets-page .asset-card.imvia-material-selected{outline:2px solid #57d6d8;outline-offset:-2px;position:relative}",
    ".assets-page .asset-card.imvia-material-selected::after{content:'✓';position:absolute;z-index:4;top:9px;right:9px;width:23px;height:23px;border-radius:50%;display:grid;place-items:center;color:#071113;background:#57d6d8;font-size:13px;font-weight:800}",
    ".assets-page.imvia-image-drag-active{outline:2px dashed #57d6d8;outline-offset:-8px;background:#57d6d80a}",
    "#imvia-material-delete-dialog{position:fixed;z-index:510;inset:0;display:grid;place-items:center;background:#000a}",
    "#imvia-material-delete-dialog .imvia-delete-card{width:min(420px,calc(100vw - 40px));padding:22px;border:1px solid #343d41;border-radius:15px;color:#e9eeee;background:#151a1d;box-shadow:0 24px 70px #000b}",
    "#imvia-material-delete-dialog strong{display:block;margin-bottom:10px;font-size:16px}",
    "#imvia-material-delete-dialog p{margin:0;color:#9ba5a8;font-size:12px;line-height:1.6}",
    "#imvia-material-delete-dialog footer{margin-top:20px;display:flex;justify-content:flex-end;gap:9px}",
    "#imvia-material-delete-dialog button{height:36px;padding:0 15px;border:1px solid #30383c;border-radius:9px;color:#d9e0e1;background:#202629;cursor:pointer}",
    "#imvia-material-delete-dialog button.danger{border-color:#743f43;color:#ffd6d8;background:#421f23}",
  ].join("");
  documentRoot.head.appendChild(style);
}

function controls(documentRoot) {
  let element = documentRoot.getElementById("imvia-asset-bulk-controls");
  if (element) return element;
  element = documentRoot.createElement("div");
  element.id = "imvia-asset-bulk-controls";
  const count = documentRoot.createElement("span");
  count.className = "imvia-selected-count";
  const select = documentRoot.createElement("button");
  select.type = "button";
  select.dataset.action = "toggle-selection";
  select.textContent = "多选";
  const remove = documentRoot.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.dataset.action = "delete-selected";
  remove.textContent = "删除所选";
  remove.hidden = true;
  const removeAll = documentRoot.createElement("button");
  removeAll.type = "button";
  removeAll.className = "danger";
  removeAll.dataset.action = "delete-all";
  removeAll.textContent = "删除全部";
  element.append(count, select, remove, removeAll);
  return element;
}

function refresh(documentRoot) {
  const page = documentRoot.querySelector(".assets-page");
  const toolbar = page?.querySelector(".library-toolbar");
  if (!page || !toolbar) return;
  const actionBar = controls(documentRoot);
  const slot = findBulkControlSlot(toolbar);
  if (slot) {
    slot.classList.add("imvia-asset-bulk-slot");
    if (!slot.contains(actionBar)) slot.appendChild(actionBar);
  } else if (!toolbar.contains(actionBar)) {
    toolbar.appendChild(actionBar);
  }
  page.classList.toggle("imvia-bulk-selecting", selectionMode);
  const available = new Set();
  for (const card of page.querySelectorAll(".asset-card")) {
    const key = cardKey(card);
    if (key) available.add(key);
    card.classList.toggle("imvia-material-selected", Boolean(key && selectedKeys.includes(key)));
  }
  selectedKeys = selectedKeys.filter((key) => available.has(key));
  assignTextIfChanged(actionBar.querySelector('[data-action="toggle-selection"]'), selectionMode ? "取消多选" : "多选");
  actionBar.querySelector('[data-action="delete-selected"]').hidden = !selectionMode || selectedKeys.length === 0;
  actionBar.querySelector('[data-action="delete-all"]').hidden = page.querySelectorAll(".asset-card").length === 0;
  assignTextIfChanged(actionBar.querySelector(".imvia-selected-count"), selectionMode ? "已选 " + selectedKeys.length + " 项" : "");
}

function waitFor(documentRoot, selector, timeout = 1800) {
  return new Promise((resolve, reject) => {
    const existing = documentRoot.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    const observer = new MutationObserver(() => {
      const element = documentRoot.querySelector(selector);
      if (!element) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(element);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("素材删除控件未能及时打开"));
    }, timeout);
    observer.observe(documentRoot.body, { childList: true, subtree: true });
  });
}

function nextPaint(windowRoot) {
  return new Promise((resolve) => windowRoot.requestAnimationFrame(() => windowRoot.requestAnimationFrame(resolve)));
}

function baseCardByIdentity(documentRoot, identity) {
  return Array.from(documentRoot.querySelectorAll(".assets-page .asset-card:not(.imvia-generated-library-card)"))
    .find((card) => cardKey(card) === "asset:" + identity) || null;
}

async function deleteBaseCard(documentRoot, card) {
  card.click();
  const remove = await waitFor(documentRoot, ".asset-detail .detail-bottom button.danger");
  remove.click();
  const confirm = await waitFor(documentRoot, ".modal-card .danger-button");
  confirm.click();
  await nextPaint(documentRoot.defaultView);
}

function clearLibraryFilters(documentRoot) {
  const search = documentRoot.querySelector('.assets-page input[aria-label="搜索素材"]');
  if (search) {
    const setter = Object.getOwnPropertyDescriptor(documentRoot.defaultView.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(search, ""); else search.value = "";
    search.dispatchEvent(new documentRoot.defaultView.Event("input", { bubbles: true }));
  }
  Array.from(documentRoot.querySelectorAll(".assets-page .filter-tabs button")).find((button) => compactText(button) === "全部")?.click();
  Array.from(documentRoot.querySelectorAll(".assets-page .asset-categories button")).find((button) => compactText(button).startsWith("全部素材"))?.click();
}

async function deleteBaseMaterials(documentRoot, request) {
  const windowRoot = documentRoot.defaultView;
  if (request.all) {
    clearLibraryFilters(documentRoot);
    await nextPaint(windowRoot);
    for (let index = 0; index < 500; index += 1) {
      const card = documentRoot.querySelector(".assets-page .asset-card:not(.imvia-generated-library-card)");
      if (!card) break;
      await deleteBaseCard(documentRoot, card);
    }
    return;
  }
  for (const identity of request.assetIds) {
    const card = baseCardByIdentity(documentRoot, identity);
    if (card) await deleteBaseCard(documentRoot, card);
  }
}

async function performDeletion(documentRoot, request) {
  if (deleting) return;
  deleting = true;
  selectionMode = false;
  try {
    const windowRoot = documentRoot.defaultView;
    const generated = generatedMaterialsAfterDeletion(generatedLibrary(windowRoot), request);
    windowRoot.localStorage.setItem(GENERATED_LIBRARY_STORAGE_KEY, JSON.stringify(generated));
    for (const card of documentRoot.querySelectorAll(".imvia-generated-library-card")) {
      if (request.all || request.artifactIds.includes(card.dataset.artifactId)) card.remove();
    }
    await deleteBaseMaterials(documentRoot, request);
    selectedKeys = [];
    showToast(documentRoot, request.all ? "素材库已全部清空" : "已删除所选素材");
  } catch (error) {
    showToast(documentRoot, error.message || "素材删除失败，请重试", true);
  } finally {
    deleting = false;
    refresh(documentRoot);
  }
}

function openDeleteDialog(documentRoot, all) {
  if (!all && selectedKeys.length === 0) return;
  documentRoot.getElementById("imvia-material-delete-dialog")?.remove();
  const request = materialDeletionRequest(selectedKeys, { all });
  const dialog = documentRoot.createElement("div");
  dialog.id = "imvia-material-delete-dialog";
  const card = documentRoot.createElement("section");
  card.className = "imvia-delete-card";
  const title = documentRoot.createElement("strong");
  title.textContent = all ? "删除全部素材？" : "删除所选素材？";
  const message = documentRoot.createElement("p");
  message.textContent = all ? "素材库中的所有本地素材和已加入的生成结果都会被删除。" : "将删除当前选择的 " + selectedKeys.length + " 个素材。";
  const footer = documentRoot.createElement("footer");
  const cancel = documentRoot.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  const confirm = documentRoot.createElement("button");
  confirm.type = "button";
  confirm.className = "danger";
  confirm.textContent = "确认删除";
  cancel.addEventListener("click", () => dialog.remove());
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    confirm.textContent = "正在删除…";
    await performDeletion(documentRoot, request);
    dialog.remove();
  });
  footer.append(cancel, confirm);
  card.append(title, message, footer);
  dialog.appendChild(card);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.remove(); });
  documentRoot.body.appendChild(dialog);
}

function dispatchImagesToLibrary(documentRoot, files) {
  const images = droppedImageFiles(files);
  if (!images.length) {
    showToast(documentRoot, "请拖入图片文件", true);
    return false;
  }
  const input = documentRoot.querySelector('.assets-page input[type="file"]');
  const DataTransferConstructor = documentRoot.defaultView.DataTransfer;
  if (!input || typeof DataTransferConstructor !== "function") {
    showToast(documentRoot, "当前工作台无法接收拖拽文件", true);
    return false;
  }
  const transfer = new DataTransferConstructor();
  images.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new documentRoot.defaultView.Event("change", { bubbles: true }));
  showToast(documentRoot, "已添加 " + images.length + " 张图片到素材库");
  return true;
}

function installDocumentEvents(documentRoot) {
  if (!assetLibraryEventsNeedInstall(documentRoot.documentElement.dataset.imviaAssetLibraryEvents)) return;
  documentRoot.documentElement.dataset.imviaAssetLibraryEvents = ASSET_LIBRARY_EVENTS_VERSION;
  documentRoot.addEventListener("click", (event) => {
    const action = bulkActionFromEvent(event);
    if (action) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "toggle-selection") {
        ({ selectionMode, selectedKeys } = selectionAfterBulkControl(action, { selectionMode, selectedKeys }));
        refresh(documentRoot);
      } else if (action === "delete-selected") {
        openDeleteDialog(documentRoot, false);
      } else if (action === "delete-all") {
        openDeleteDialog(documentRoot, true);
      }
      return;
    }
    if (!selectionMode) return;
    const card = event.target?.closest?.(".assets-page .asset-card");
    if (!card) return;
    const key = cardKey(card);
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectedKeys = toggleMaterialSelection(selectedKeys, key);
    refresh(documentRoot);
  }, true);
  documentRoot.addEventListener("dragenter", (event) => {
    const page = event.target?.closest?.(".assets-page");
    if (!page || !event.dataTransfer?.types?.includes?.("Files")) return;
    event.preventDefault();
    page.classList.add("imvia-image-drag-active");
  }, true);
  documentRoot.addEventListener("dragover", (event) => {
    const page = event.target?.closest?.(".assets-page");
    if (!page || !event.dataTransfer?.types?.includes?.("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    page.classList.add("imvia-image-drag-active");
  }, true);
  documentRoot.addEventListener("dragleave", (event) => {
    const page = event.target?.closest?.(".assets-page");
    if (page && !page.contains(event.relatedTarget)) page.classList.remove("imvia-image-drag-active");
  }, true);
  documentRoot.addEventListener("drop", (event) => {
    const page = event.target?.closest?.(".assets-page");
    if (!page) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    page.classList.remove("imvia-image-drag-active");
    dispatchImagesToLibrary(documentRoot, event.dataTransfer?.files);
  }, true);
}

export function installAssetLibraryEnhancements(root = document) {
  const documentRoot = root?.ownerDocument || root;
  if (!documentRoot?.documentElement) return { installed: false };
  installStyle(documentRoot);
  installDocumentEvents(documentRoot);
  const page = documentRoot.querySelector(".assets-page");
  if (!page) return { installed: false };
  refresh(documentRoot);
  return { installed: true, selectionMode, selectedCount: selectedKeys.length };
}
