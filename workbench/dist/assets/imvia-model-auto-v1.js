import { floatingMenuPlacement, generationModelOptions, isFloatingControlVisible } from "./imvia-generation-settings-v1.js";
import { renderModelLogo } from "./imvia-model-logo-v1.js";

const AUTO_OPTION = "Auto";
const OVERLAY_ID = "imvia-model-auto-overlay";
const STYLE_ID = "imvia-model-auto-style";
const MODELS_BY_MODE = Object.freeze({
  video: ["Seedance 2.5", "Seedance 2.0 VIP", "Seedance 2.0 Fast", "Minimax H3", "Kling 3.0", "Kling 3.0 Omni"],
  image: ["Seedream 4.0", "Seedream 3.0", "Seedream 3.0 Fast", "Image 2", "Nano Banana Pro", "Nano Banana 2", "Seedream 5.0", "Seedream 5.0 Lite", "Midjourney"],
});

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function isOverlayTargetVisible(controlRect, clippingRect) {
  return isFloatingControlVisible(controlRect, clippingRect);
}

export function modelMenuPlacement(input) {
  return floatingMenuPlacement(input);
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

function creationMode(root) {
  return normalizedText(root?.querySelector?.(".creation-tabs button.active")?.textContent).includes("视频") ? "video" : "image";
}

export function modelOptionsForProvider({ providerId = "lovart", models = [], mode = "image" } = {}) {
  const providerModels = Array.isArray(models) ? models.map((model) => typeof model === "string" ? model : model?.id).filter(Boolean) : [];
  return providerId === "lovart"
    ? generationModelOptions(MODELS_BY_MODE[mode === "video" ? "video" : "image"])
    : Array.from(new Set(providerModels.filter((model) => model !== AUTO_OPTION)));
}

export function modelForProviderSelectionEvent({ providerId = "lovart", model = null, models = [] } = {}) {
  const ids = (Array.isArray(models) ? models : []).map((candidate) => typeof candidate === "string" ? candidate : candidate?.id).filter((id) => id && (providerId === "lovart" || id !== AUTO_OPTION));
  if (ids.includes(model)) return model;
  return providerId === "lovart" && ids.includes(AUTO_OPTION) ? AUTO_OPTION : ids[0] || "";
}

function modelOptionRecords(providerId, models, mode) {
  const ids = modelOptionsForProvider({ providerId, models, mode });
  const labels = new Map((Array.isArray(models) ? models : []).map((model) => {
    if (typeof model === "string") return [model, model];
    const id = normalizedText(model?.id);
    const name = normalizedText(model?.display_name ?? model?.name) || id;
    return [id, name === id ? id : `${name} (${id})`];
  }));
  return ids.map((id) => ({ id, display_name: labels.get(id) || id }));
}

export function modelOverlayRenderSignature({ providerId = "lovart", models = [], mode = "image" } = {}) {
  return JSON.stringify({
    provider_id: providerId,
    mode: mode === "video" ? "video" : "image",
    options: modelOptionRecords(providerId, models, mode).map((option) => [option.id, option.display_name]),
  });
}

export function modelOverlayNeedsRebuild(currentSignature, input) {
  return currentSignature !== modelOverlayRenderSignature(input);
}

function nativeModelValue(select, options, fallback = AUTO_OPTION) {
  const text = normalizedText(select?.textContent);
  return options.find((value) => text.endsWith(value) || text.includes(value)) || options[0] || fallback;
}

function installStyle(documentRoot) {
  if (documentRoot.getElementById(STYLE_ID)) return;
  const style = documentRoot.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    "#" + OVERLAY_ID + " .imvia-model-trigger{width:100%;height:100%;padding:0 14px;border:1px solid #20262a;border-radius:11px;background:#1a2024;color:#dce4e6;display:flex;align-items:center;justify-content:space-between;font:inherit;font-size:14px;cursor:pointer}",
    "#" + OVERLAY_ID + " .imvia-model-trigger:hover{background:#1d2427}",
    "#" + OVERLAY_ID + " .imvia-model-trigger:focus-visible{outline:0;box-shadow:0 0 0 2px #57d6d842}",
    "#" + OVERLAY_ID + " .imvia-model-leading{display:flex;align-items:center;gap:10px;min-width:max-content}",
    "#" + OVERLAY_ID + " .imvia-model-mark{width:28px;height:28px;flex:0 0 28px;border-radius:8px;display:grid;place-items:center;color:#63e7e8;background:transparent;font-size:11px;font-weight:700;overflow:hidden}",
    "#" + OVERLAY_ID + " .imvia-model-mark img{width:20px;height:20px;object-fit:contain}",
    "#" + OVERLAY_ID + " .imvia-model-value{overflow:visible;text-overflow:clip;white-space:nowrap}",
    "#" + OVERLAY_ID + " .imvia-model-chevron{width:16px;height:16px;flex:0 0 16px}",
    "#" + OVERLAY_ID + " .imvia-model-menu{position:absolute;z-index:1;top:calc(100% + 6px);right:auto;left:0;width:max(100%,320px);max-height:330px;padding:6px;overflow:auto;border-radius:12px;background:#202629;box-shadow:0 18px 42px #0000006b,inset 0 0 0 1px #ffffff0b}",
    "#" + OVERLAY_ID + " .imvia-model-menu[hidden]{display:none}",
    "#" + OVERLAY_ID + " .imvia-model-option{width:100%;min-height:42px;padding:0 10px;border:0;border-radius:8px;display:grid;grid-template-columns:18px 28px max-content;align-items:center;gap:8px;color:#aab1b4;background:transparent;text-align:left;font:inherit;font-size:13px;cursor:pointer}",
    "#" + OVERLAY_ID + " .imvia-model-option:hover,#" + OVERLAY_ID + " .imvia-model-option.selected{color:#e5eeee;background:#293134}",
    "#" + OVERLAY_ID + " .imvia-model-check{width:14px;height:14px}",
    "#" + OVERLAY_ID + " .imvia-model-name{overflow:visible;text-overflow:clip;white-space:nowrap}",
  ].join("");
  documentRoot.head.appendChild(style);
}

export function modelMarkNeedsRefresh(currentValue, nextValue) {
  return normalizedText(currentValue) !== normalizedText(nextValue);
}

function modelMark(documentRoot, value) {
  const mark = documentRoot.createElement("span");
  mark.className = "imvia-model-mark";
  mark.dataset.imviaModelMark = value;
  if (value === AUTO_OPTION) mark.textContent = "A";
  else mark.innerHTML = renderModelLogo(value);
  return mark;
}

function setOpen(overlay, open) {
  overlay.querySelector(".imvia-model-trigger")?.setAttribute("aria-expanded", open ? "true" : "false");
  const menu = overlay.querySelector(".imvia-model-menu");
  if (!menu) return;
  if (!open) { menu.hidden = true; return; }
  menu.hidden = false;
  const rect = overlay.getBoundingClientRect();
  const clip = overlay._imviaClipRect || { top: 0, bottom: overlay._imviaWindow?.innerHeight || 0 };
  const placement = modelMenuPlacement({ triggerTop: rect.top, triggerBottom: rect.bottom, clipTop: clip.top, clipBottom: clip.bottom, menuHeight: Math.min(330, menu.scrollHeight || 330) });
  menu.style.top = placement === "below" ? "calc(100% + 6px)" : "auto";
  menu.style.bottom = placement === "above" ? "calc(100% + 6px)" : "auto";
}

function renderValue(overlay, value) {
  const leading = overlay.querySelector(".imvia-model-leading");
  const currentMark = leading.querySelector(".imvia-model-mark");
  if (modelMarkNeedsRefresh(currentMark?.dataset?.imviaModelMark, value)) {
    const nextMark = modelMark(overlay.ownerDocument, value);
    if (currentMark) currentMark.replaceWith(nextMark);
    else leading.prepend(nextMark);
  }
  const valueNode = overlay.querySelector(".imvia-model-value");
  const label = overlay._imviaModelLabels?.get(value) || value;
  if (valueNode.textContent !== label) valueNode.textContent = label;
  for (const option of overlay.querySelectorAll("[data-imvia-model-value]")) {
    const selected = option.dataset.imviaModelValue === value;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-selected", selected ? "true" : "false");
    option.querySelector(".imvia-model-check").hidden = !selected;
  }
}

function chooseNativeModel(overlay, value) {
  if (value === AUTO_OPTION) return;
  overlay._imviaReactSelect.click();
  overlay._imviaWindow.setTimeout(() => {
    const option = Array.from(overlay._imviaRoot.querySelectorAll(".model-section .dropdown-menu button"))
      .find((button) => normalizedText(button.querySelector(".dropdown-option-content > span:last-child")?.textContent || button.textContent).endsWith(value));
    option?.click();
  }, 0);
}

function selectModel(overlay, value) {
  overlay.ownerDocument.documentElement.dataset.imviaModel = value;
  renderValue(overlay, value);
  setOpen(overlay, false);
  chooseNativeModel(overlay, value);
  overlay.querySelector(".imvia-model-trigger")?.focus();
}

function buildOverlay(overlay, options) {
  overlay.replaceChildren();
  const trigger = overlay.ownerDocument.createElement("button");
  trigger.type = "button";
  trigger.className = "imvia-model-trigger";
  trigger.setAttribute("aria-label", "模型");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const leading = overlay.ownerDocument.createElement("span");
  leading.className = "imvia-model-leading";
  const value = overlay.ownerDocument.createElement("span");
  value.className = "imvia-model-value";
  leading.append(modelMark(overlay.ownerDocument, AUTO_OPTION), value);
  const chevron = overlay.ownerDocument.createElement("img");
  chevron.className = "imvia-model-chevron";
  chevron.src = "/assets/icons/lucide-chevron-down.svg";
  chevron.alt = "";
  trigger.append(leading, chevron);
  const menu = overlay.ownerDocument.createElement("div");
  menu.className = "imvia-model-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "模型");
  menu.hidden = true;
  for (const modelOption of options) {
    const model = modelOption.id;
    const option = overlay.ownerDocument.createElement("button");
    option.type = "button";
    option.className = "imvia-model-option";
    option.dataset.imviaModelValue = model;
    option.setAttribute("role", "option");
    const check = overlay.ownerDocument.createElement("img");
    check.className = "imvia-model-check";
    check.src = "/assets/icons/lucide-check.svg";
    check.alt = "";
    check.hidden = true;
    const name = overlay.ownerDocument.createElement("span");
    name.className = "imvia-model-name";
    name.textContent = modelOption.display_name;
    option.append(check, modelMark(overlay.ownerDocument, model), name);
    option.addEventListener("click", () => selectModel(overlay, model));
    menu.appendChild(option);
  }
  trigger.addEventListener("click", () => setOpen(overlay, trigger.getAttribute("aria-expanded") !== "true"));
  overlay.append(trigger, menu);
}

export function installModelAuto(root = document) {
  const documentRoot = root?.ownerDocument || root;
  const select = root?.querySelector?.(".model-section .select-box");
  let overlay = documentRoot?.getElementById?.(OVERLAY_ID);
  if (!documentRoot || !select) {
    if (overlay) overlay.hidden = true;
    return { installed: false };
  }
  installStyle(documentRoot);
  const mode = creationMode(root);
  if (!overlay) {
    overlay = documentRoot.createElement("div");
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, { position: "fixed", zIndex: "172", margin: "0", padding: "0" });
    documentRoot.body.appendChild(overlay);
    documentRoot.addEventListener("pointerdown", (event) => { if (!overlay.contains(event.target)) setOpen(overlay, false); }, true);
    documentRoot.addEventListener("imvia:provider-selection-changed", (event) => {
      overlay._imviaProviderId = typeof event.detail?.provider_id === "string" ? event.detail.provider_id : "lovart";
      overlay._imviaProviderModels = Array.isArray(event.detail?.models) ? event.detail.models : [];
      documentRoot.documentElement.dataset.imviaModel = modelForProviderSelectionEvent({
        providerId: overlay._imviaProviderId,
        model: event.detail?.model,
        models: overlay._imviaProviderModels,
      });
      installModelAuto(overlay._imviaRoot || documentRoot);
    });
  }
  const optionRecords = modelOptionRecords(overlay._imviaProviderId || "lovart", overlay._imviaProviderModels, mode);
  const options = optionRecords.map((option) => option.id);
  overlay._imviaModelLabels = new Map(optionRecords.map((option) => [option.id, option.display_name]));
  const renderSignature = modelOverlayRenderSignature({ providerId: overlay._imviaProviderId || "lovart", models: overlay._imviaProviderModels, mode });
  if (modelOverlayNeedsRebuild(overlay.dataset.imviaRenderSignature, { providerId: overlay._imviaProviderId || "lovart", models: overlay._imviaProviderModels, mode })) {
    overlay.dataset.imviaMode = mode;
    overlay.dataset.imviaRenderSignature = renderSignature;
    buildOverlay(overlay, optionRecords);
  }
  overlay._imviaRoot = root;
  overlay._imviaReactSelect = select;
  overlay._imviaWindow = documentRoot.defaultView || globalThis.window;
  const remembered = documentRoot.documentElement.dataset.imviaModel;
  const selected = options.includes(remembered) ? remembered : nativeModelValue(select, options, (overlay._imviaProviderId || "lovart") === "lovart" ? AUTO_OPTION : "");
  documentRoot.documentElement.dataset.imviaModel = selected;
  renderValue(overlay, selected);
  const rect = select.getBoundingClientRect();
  const clip = clippingRectFor(select, documentRoot);
  overlay._imviaClipRect = clip;
  const visible = isOverlayTargetVisible(rect, clip);
  overlay.hidden = !visible;
  if (!visible) setOpen(overlay, false);
  if (visible) Object.assign(overlay.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
  return { installed: visible, mode, selected };
}
