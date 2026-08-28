const AUTO_OPTION = "Auto";
const OUTPUT_RATIOS = [AUTO_OPTION, "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "21:9"];
const REACT_IMAGE_RATIOS = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]);
const RATIO_OVERLAY_ID = "imvia-image-ratio-overlay";
const RESOLUTION_MENU_MIN_WIDTH = 112;

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function generationSettingOptions({ mode, field }) {
  if (["image", "video"].includes(mode) && field === "ratio") return [...OUTPUT_RATIOS];
  return [];
}

export function resolveGenerationRatio({ mode, value, imageOverride, ratioOverride }) {
  const override = normalizedText(ratioOverride ?? imageOverride);
  const selected = ["image", "video"].includes(mode) && OUTPUT_RATIOS.includes(override)
    ? override
    : normalizedText(value);
  return selected.toLocaleLowerCase("en-US") === "auto" ? null : selected || null;
}

export function resolveGenerationModel({ value, modelOverride }) {
  const selected = normalizedText(modelOverride) || normalizedText(value);
  return selected.toLocaleLowerCase("en-US") === "auto" ? null : selected || null;
}

export function generationModelOptions(values) {
  return [AUTO_OPTION, ...Array.from(values || []).map(normalizedText).filter((value) => value && value !== AUTO_OPTION)];
}

export function resolutionMenuGeometry({ triggerWidth }) {
  const measuredWidth = Number.isFinite(triggerWidth) ? Math.max(0, triggerWidth) : 0;
  return {
    width: Math.max(RESOLUTION_MENU_MIN_WIDTH, measuredWidth),
    minWidth: RESOLUTION_MENU_MIN_WIDTH,
    right: "auto",
  };
}

export function isFloatingControlVisible(controlRect, clippingRect) {
  if (!controlRect || !clippingRect || controlRect.width <= 0 || controlRect.height <= 0) return false;
  const tolerance = 0.5;
  return controlRect.top >= clippingRect.top - tolerance
    && controlRect.right <= clippingRect.right + tolerance
    && controlRect.bottom <= clippingRect.bottom + tolerance
    && controlRect.left >= clippingRect.left - tolerance;
}

export function floatingMenuPlacement({ triggerTop, triggerBottom, clipTop, clipBottom, menuHeight, gap = 6 }) {
  const required = Math.max(0, Number(menuHeight) || 0) + Math.max(0, Number(gap) || 0);
  const below = Math.max(0, Number(clipBottom) - Number(triggerBottom));
  const above = Math.max(0, Number(triggerTop) - Number(clipTop));
  return below >= required || below >= above ? "below" : "above";
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

function settingField(root, name) {
  return Array.from(root?.querySelectorAll?.(".settings-grid label") || [])
    .find((label) => normalizedText(label.querySelector?.(":scope > span")?.textContent) === name) || null;
}

function setOverlayOpen(overlay, open) {
  const trigger = overlay.querySelector(".imvia-ratio-trigger");
  const menu = overlay.querySelector(".imvia-ratio-menu");
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) { menu.hidden = true; return; }
  menu.hidden = false;
  const rect = overlay.getBoundingClientRect();
  const clip = overlay._imviaClipRect || { top: 0, bottom: overlay._imviaWindow?.innerHeight || 0 };
  const placement = floatingMenuPlacement({ triggerTop: rect.top, triggerBottom: rect.bottom, clipTop: clip.top, clipBottom: clip.bottom, menuHeight: Math.min(290, menu.scrollHeight || 290) });
  menu.style.top = placement === "below" ? "calc(100% + 6px)" : "auto";
  menu.style.bottom = placement === "above" ? "calc(100% + 6px)" : "auto";
}

function renderOverlay(overlay, value) {
  const valueNode = overlay.querySelector(".imvia-ratio-value");
  if (valueNode.textContent !== value) valueNode.textContent = value;
  for (const option of overlay.querySelectorAll("[data-imvia-ratio-value]")) {
    const selected = option.dataset.imviaRatioValue === value;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-selected", selected ? "true" : "false");
    option.querySelector(".imvia-ratio-check").hidden = !selected;
  }
}

function publishRatio(overlay, value) {
  overlay._imviaValue = value;
  overlay._imviaDocument.documentElement.dataset.imviaRatio = value;
  overlay._imviaDocument.documentElement.dataset.imviaImageRatio = value;
  renderOverlay(overlay, value);
}

function chooseReactRatio(overlay, value) {
  if (!REACT_IMAGE_RATIOS.has(value)) return;
  overlay._imviaReactSelect.click();
  overlay._imviaWindow.setTimeout(() => {
    const option = Array.from(settingField(overlay._imviaRoot, "比例")?.querySelectorAll?.(".dropdown-menu button") || [])
      .find((button) => normalizedText(button.textContent) === value);
    option?.click();
  }, 0);
}

function selectRatio(overlay, value) {
  publishRatio(overlay, value);
  setOverlayOpen(overlay, false);
  chooseReactRatio(overlay, value);
  overlay.querySelector(".imvia-ratio-trigger").focus();
}

function ensureRatioOverlay(root, reactSelect) {
  const documentRoot = root.ownerDocument || root;
  const windowRoot = documentRoot.defaultView || globalThis.window;
  let overlay = documentRoot.getElementById(RATIO_OVERLAY_ID);
  if (!overlay) {
    overlay = documentRoot.createElement("div");
    overlay.id = RATIO_OVERLAY_ID;
    overlay.innerHTML = `
      <style>
        #${RATIO_OVERLAY_ID} .imvia-ratio-trigger{width:100%;height:100%;padding:0 12px;border:1px solid #20262a;border-radius:9px;background:#1a2024;color:#dce4e6;display:flex;align-items:center;justify-content:space-between;font:inherit;font-size:12px;cursor:pointer}
        #${RATIO_OVERLAY_ID} .imvia-ratio-trigger:hover{background:#1d2427}
        #${RATIO_OVERLAY_ID} .imvia-ratio-trigger:focus-visible{outline:0;box-shadow:0 0 0 2px #57d6d842}
        #${RATIO_OVERLAY_ID} .imvia-ratio-chevron{width:15px;height:15px;flex:0 0 15px}
        #${RATIO_OVERLAY_ID} .imvia-ratio-menu{position:absolute;z-index:1;right:0;top:calc(100% + 6px);bottom:auto;left:0;max-height:290px;padding:5px;overflow:auto;border-radius:10px;background:#202629;box-shadow:0 18px 42px #0000006b,inset 0 0 0 1px #ffffff0b}
        #${RATIO_OVERLAY_ID} .imvia-ratio-menu[hidden]{display:none}
        #${RATIO_OVERLAY_ID} .imvia-ratio-option{width:100%;min-height:34px;padding:0 9px;border:0;border-radius:7px;display:grid;grid-template-columns:16px 1fr;align-items:center;gap:5px;color:#aab1b4;background:transparent;text-align:left;font:inherit;font-size:11px;cursor:pointer}
        #${RATIO_OVERLAY_ID} .imvia-ratio-option:hover,#${RATIO_OVERLAY_ID} .imvia-ratio-option.selected{color:#e5eeee;background:#293134}
        #${RATIO_OVERLAY_ID} .imvia-ratio-check{width:13px;height:13px;grid-column:1;color:#57d6d8}
        #${RATIO_OVERLAY_ID} .imvia-ratio-option span{grid-column:2}
      </style>
      <button type="button" class="imvia-ratio-trigger" aria-label="比例" aria-haspopup="listbox" aria-expanded="false">
        <span class="imvia-ratio-value"></span>
        <img class="imvia-ratio-chevron" src="/assets/icons/lucide-chevron-down.svg" alt="">
      </button>
      <div class="imvia-ratio-menu" role="listbox" aria-label="比例" hidden>
        ${OUTPUT_RATIOS.map((value) => `<button type="button" class="imvia-ratio-option" role="option" data-imvia-ratio-value="${value}"><img class="imvia-ratio-check" src="/assets/icons/lucide-check.svg" alt="" hidden><span>${value}</span></button>`).join("")}
      </div>`;
    Object.assign(overlay.style, { position: "fixed", zIndex: "171", margin: "0", padding: "0" });
    const trigger = overlay.querySelector(".imvia-ratio-trigger");
    trigger.addEventListener("click", () => setOverlayOpen(overlay, trigger.getAttribute("aria-expanded") !== "true"));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOverlayOpen(overlay, true);
        overlay.querySelector(".imvia-ratio-option.selected")?.focus();
      }
    });
    overlay.querySelectorAll("[data-imvia-ratio-value]").forEach((option) => {
      option.addEventListener("click", () => selectRatio(overlay, option.dataset.imviaRatioValue));
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOverlayOpen(overlay, false);
        trigger.focus();
      }
    });
    documentRoot.addEventListener("pointerdown", (event) => {
      if (!overlay.contains(event.target)) setOverlayOpen(overlay, false);
    }, true);
    documentRoot.body.appendChild(overlay);
  }

  overlay._imviaRoot = root;
  overlay._imviaDocument = documentRoot;
  overlay._imviaWindow = windowRoot;
  overlay._imviaReactSelect = reactSelect;
  const value = overlay._imviaValue
    || documentRoot.documentElement.dataset.imviaRatio
    || documentRoot.documentElement.dataset.imviaImageRatio
    || normalizedText(reactSelect.textContent)
    || OUTPUT_RATIOS[1];
  publishRatio(overlay, value);
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

function widenResolutionMenu(root) {
  const field = settingField(root, "分辨率");
  const trigger = field?.querySelector?.(".select-box");
  const menu = field?.querySelector?.(".dropdown-menu");
  if (!trigger || !menu) return false;
  const geometry = resolutionMenuGeometry({ triggerWidth: trigger.getBoundingClientRect().width });
  menu.style.width = `${geometry.width}px`;
  menu.style.minWidth = `${geometry.minWidth}px`;
  menu.style.right = geometry.right;
  return true;
}

export function installGenerationSettings(root = document) {
  const resolutionMenuWidened = widenResolutionMenu(root);
  const documentRoot = root?.ownerDocument || root;
  const existingOverlay = documentRoot?.getElementById?.(RATIO_OVERLAY_ID);
  if (!root) {
    if (existingOverlay) existingOverlay.hidden = true;
    return { ratioInstalled: false, resolutionMenuWidened };
  }
  const field = settingField(root, "比例");
  const reactSelect = field?.querySelector?.(".select-box");
  if (!reactSelect) {
    if (existingOverlay) existingOverlay.hidden = true;
    return { ratioInstalled: false, resolutionMenuWidened };
  }
  ensureRatioOverlay(root, reactSelect);
  return { ratioInstalled: true, resolutionMenuWidened };
}
