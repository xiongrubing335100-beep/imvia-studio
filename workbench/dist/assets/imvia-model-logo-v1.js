const MODEL_LOGOS = Object.freeze({
  "Seedance 2.5": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  "Seedance 2.0 VIP": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  "Seedance 2.0 Fast": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  "Minimax H3": { provider: "minimax", src: "/assets/models/minimax-brand.png" },
  "Kling 3.0": { provider: "kling", src: "/assets/models/kling-brand.png" },
  "Kling 3.0 Omni": { provider: "kling", src: "/assets/models/kling-brand.png" },
  "Seedream 4.0": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  "Seedream 3.0": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  "Seedream 3.0 Fast": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  "Image 2": { provider: "openai", src: "/assets/models/openai-brand.svg" },
  "Nano Banana Pro": { provider: "gemini", src: "/assets/models/gemini-brand.png" },
  "Nano Banana 2": { provider: "gemini", src: "/assets/models/gemini-brand.png" },
  "Seedream 5.0": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  "Seedream 5.0 Lite": { provider: "seed", src: "/assets/models/seed-brand-v2.png" },
  Midjourney: { provider: "midjourney", src: "/assets/models/midjourney-brand.svg" },
});

const PROVIDER_LABELS = Object.freeze({
  seed: "ByteDance Seed",
  minimax: "MiniMax",
  kling: "Kling AI",
  openai: "OpenAI",
  gemini: "Google Gemini",
  midjourney: "Midjourney",
});

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function modelLogoFor(model) {
  const logo = MODEL_LOGOS[String(model ?? "").trim()];
  return logo ? { ...logo } : null;
}

export function renderModelLogo(model) {
  const logo = modelLogoFor(model);
  if (!logo) return "";
  const label = PROVIDER_LABELS[logo.provider];
  return `<img class="imvia-model-logo" src="${escapeAttribute(logo.src)}" alt="${escapeAttribute(label)}" />`;
}

export function decorateModelIcon(icon, model) {
  const logo = modelLogoFor(model);
  if (!icon || !logo) return false;
  for (const className of [...icon.classList]) {
    if (className.startsWith("imvia-provider-")) icon.classList.remove(className);
  }
  icon.classList.add(`imvia-provider-${logo.provider}`);
  icon.dataset.imviaModelLogo = String(model).trim();
  icon.style.setProperty("--imvia-model-logo", `url("${logo.src}")`);
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", PROVIDER_LABELS[logo.provider]);
  return true;
}

export function modelNameForIcon(icon) {
  const option = icon.closest?.('[role="option"]');
  const optionName = option?.querySelector?.(".dropdown-option-content > span:last-child")?.textContent;
  if (optionName?.trim()) return optionName.trim();

  const select = icon.closest?.(".select-box");
  const selectedName = Array.from(icon.parentElement?.childNodes ?? [])
    .filter((node) => node !== icon)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
  if (selectedName) return selectedName;
  return select?.textContent?.trim() || "";
}

export function enhanceModelLogos(root = document) {
  const icons = root.querySelectorAll?.(".model-icon") ?? [];
  for (const icon of icons) {
    const model = modelNameForIcon(icon);
    const logo = modelLogoFor(model);
    if (!logo || icon.dataset.imviaModelLogo === model) continue;
    decorateModelIcon(icon, model);
  }
}

function startModelLogoEnhancer() {
  enhanceModelLogos(document);
  const observer = new MutationObserver(() => enhanceModelLogos(document));
  observer.observe(document.body, { childList: true, subtree: true });
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startModelLogoEnhancer, { once: true });
  } else {
    startModelLogoEnhancer();
  }
}
