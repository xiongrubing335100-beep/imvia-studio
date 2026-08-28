import { floatingMenuPlacement, isFloatingControlVisible } from "./imvia-generation-settings-v1.js";

export const AUTO_IMAGE_COUNT_LABEL = "Auto";

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function serializeGenerationCount({ mode, value }) {
  const label = normalizedText(value);
  if (mode === "image" && label.toLocaleLowerCase("en-US") === "auto") {
    return { count_mode: "auto", count: null };
  }
  const count = Number.parseInt(label, 10);
  return {
    count_mode: "fixed",
    count: Number.isInteger(count) && count > 0 ? count : 1,
  };
}

function countField(root) {
  return Array.from(root?.querySelectorAll?.(".settings-grid label") || [])
    .find((label) => normalizedText(label.querySelector?.(":scope > span")?.textContent) === "生成数量") || null;
}

function isImageCreation(root) {
  const active = root?.querySelector?.(".creation-tabs button.active");
  return normalizedText(active?.textContent).includes("图片");
}

function clippingRectFor(control, documentRoot) {
  const scroller = control?.closest?.(".creator-scroll");
  const viewport = { top: 0, right: documentRoot.defaultView?.innerWidth || 0, bottom: documentRoot.defaultView?.innerHeight || 0, left: 0 };
  if (!scroller) return viewport;
  const rect = scroller.getBoundingClientRect();
  return {
    top: Math.max(viewport.top, rect.top),
    right: Math.min(viewport.right, rect.right),
    bottom: Math.min(viewport.bottom, rect.bottom),
    left: Math.max(viewport.left, rect.left),
  };
}

let imageCountValue = AUTO_IMAGE_COUNT_LABEL;
const overlayId = "imvia-generation-count-overlay";
const countOptions = [AUTO_IMAGE_COUNT_LABEL, "1个", "2个", "4个"];

function publishValue(root) {
  const documentRoot = root?.ownerDocument || root;
  if (!documentRoot?.documentElement) return;
  documentRoot.documentElement.dataset.imviaGenerationCount = imageCountValue;
}

function chooseReactCount(root, reactSelect, value) {
  reactSelect.click();
  window.setTimeout(() => {
    const option = Array.from(countField(root)?.querySelectorAll?.(".dropdown-menu button") || [])
      .find((button) => Number.parseInt(normalizedText(button.textContent), 10) === Number.parseInt(value, 10));
    option?.click();
  }, 0);
}

function setOverlayOpen(overlay, open) {
  const trigger = overlay.querySelector(".imvia-count-trigger");
  const menu = overlay.querySelector(".imvia-count-menu");
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) { menu.hidden = true; return; }
  menu.hidden = false;
  const rect = overlay.getBoundingClientRect();
  const clip = overlay._imviaClipRect || { top: 0, bottom: overlay._imviaWindow?.innerHeight || 0 };
  const placement = floatingMenuPlacement({ triggerTop: rect.top, triggerBottom: rect.bottom, clipTop: clip.top, clipBottom: clip.bottom, menuHeight: Math.min(230, menu.scrollHeight || 230) });
  menu.style.top = placement === "below" ? "calc(100% + 6px)" : "auto";
  menu.style.bottom = placement === "above" ? "calc(100% + 6px)" : "auto";
}

function renderOverlay(overlay) {
  const valueNode = overlay.querySelector(".imvia-count-value");
  if (valueNode.textContent !== imageCountValue) valueNode.textContent = imageCountValue;
  for (const option of overlay.querySelectorAll("[data-imvia-count-value]")) {
    const selected = option.dataset.imviaCountValue === imageCountValue;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-selected", selected ? "true" : "false");
    option.querySelector(".imvia-count-check").hidden = !selected;
  }
}

function selectCount(overlay, value) {
  imageCountValue = value || AUTO_IMAGE_COUNT_LABEL;
  publishValue(overlay._imviaRoot);
  renderOverlay(overlay);
  setOverlayOpen(overlay, false);
  if (imageCountValue !== AUTO_IMAGE_COUNT_LABEL) {
    chooseReactCount(overlay._imviaRoot, overlay._imviaReactSelect, imageCountValue);
  }
  overlay.querySelector(".imvia-count-trigger").focus();
}

function ensureOverlay(root, reactSelect) {
  const documentRoot = root?.ownerDocument || root;
  const windowRoot = documentRoot.defaultView || globalThis.window;
  let overlay = documentRoot.getElementById(overlayId);
  if (!overlay) {
    overlay = documentRoot.createElement("div");
    overlay.id = overlayId;
    overlay.innerHTML = `
      <style>
        #${overlayId} .imvia-count-trigger{width:100%;height:100%;padding:0 12px;border:0;border-radius:9px;background:#1a2024;color:#dce4e6;display:flex;align-items:center;justify-content:space-between;font:inherit;font-size:12px;cursor:pointer}
        #${overlayId} .imvia-count-trigger:hover{background:#1d2427}
        #${overlayId} .imvia-count-trigger:focus-visible{outline:0;box-shadow:0 0 0 2px #57d6d842}
        #${overlayId} .imvia-count-chevron{width:15px;height:15px;flex:0 0 15px}
        #${overlayId} .imvia-count-menu{position:absolute;z-index:1;right:0;top:calc(100% + 6px);bottom:auto;left:0;max-height:230px;padding:5px;overflow:auto;border-radius:10px;background:#202629;box-shadow:0 18px 42px #0000006b,inset 0 0 0 1px #ffffff0b}
        #${overlayId} .imvia-count-menu[hidden]{display:none}
        #${overlayId} .imvia-count-option{width:100%;min-height:34px;padding:0 9px;border:0;border-radius:7px;display:grid;grid-template-columns:16px 1fr;align-items:center;gap:5px;color:#aab1b4;background:transparent;text-align:left;font:inherit;font-size:11px;cursor:pointer}
        #${overlayId} .imvia-count-option:hover,#${overlayId} .imvia-count-option.selected{color:#e5eeee;background:#293134}
        #${overlayId} .imvia-count-check{width:13px;height:13px;grid-column:1;color:#57d6d8}
        #${overlayId} .imvia-count-option span{grid-column:2}
      </style>
      <button type="button" class="imvia-count-trigger" aria-label="生成数量" aria-haspopup="listbox" aria-expanded="false">
        <span class="imvia-count-value"></span>
        <img class="imvia-count-chevron" src="/assets/icons/lucide-chevron-down.svg" alt="">
      </button>
      <div class="imvia-count-menu" role="listbox" aria-label="生成数量" hidden>
        ${countOptions.map((value) => `<button type="button" class="imvia-count-option" role="option" data-imvia-count-value="${value}"><img class="imvia-count-check" src="/assets/icons/lucide-check.svg" alt="" hidden><span>${value}</span></button>`).join("")}
      </div>`;
    Object.assign(overlay.style, { position: "fixed", zIndex: "170", margin: "0", padding: "0" });
    const trigger = overlay.querySelector(".imvia-count-trigger");
    trigger.addEventListener("click", () => {
      setOverlayOpen(overlay, trigger.getAttribute("aria-expanded") !== "true");
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOverlayOpen(overlay, true);
        overlay.querySelector(".imvia-count-option.selected")?.focus();
      }
    });
    overlay.querySelectorAll("[data-imvia-count-value]").forEach((option) => {
      option.addEventListener("click", () => selectCount(overlay, option.dataset.imviaCountValue));
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { setOverlayOpen(overlay, false); trigger.focus(); }
    });
    documentRoot.addEventListener("pointerdown", (event) => {
      if (!overlay.contains(event.target)) setOverlayOpen(overlay, false);
    }, true);
    documentRoot.body.appendChild(overlay);
  }

  overlay._imviaRoot = root;
  overlay._imviaReactSelect = reactSelect;
  overlay._imviaWindow = windowRoot;
  renderOverlay(overlay);
  const rect = reactSelect.getBoundingClientRect();
  const clip = clippingRectFor(reactSelect, documentRoot);
  overlay._imviaClipRect = clip;
  const visible = isFloatingControlVisible(rect, clip);
  overlay.hidden = !visible;
  if (!visible) setOverlayOpen(overlay, false);
  if (visible) Object.assign(overlay.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  return overlay;
}

export function installImageCountAuto(root = document) {
  const documentRoot = root?.ownerDocument || root;
  const existingOverlay = documentRoot?.getElementById?.(overlayId);
  if (!root || !isImageCreation(root)) {
    if (existingOverlay) existingOverlay.hidden = true;
    return false;
  }
  const field = countField(root);
  const reactSelect = field?.querySelector?.(".select-box");
  if (!field || !reactSelect) return false;
  publishValue(root);
  ensureOverlay(root, reactSelect);
  return true;
}
