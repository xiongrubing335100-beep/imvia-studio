import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const logos = await import("../workbench/dist/assets/imvia-model-logo-v1.js").catch(() => ({}));
const logoCss = await readFile(new URL("../workbench/dist/assets/imvia-model-logo-v1.css", import.meta.url), "utf8");

const expectedModels = [
  ["Seedance 2.5", "seed", "/assets/models/seed-brand-v2.png"],
  ["Seedance 2.0 VIP", "seed", "/assets/models/seed-brand-v2.png"],
  ["Seedance 2.0 Fast", "seed", "/assets/models/seed-brand-v2.png"],
  ["Minimax H3", "minimax", "/assets/models/minimax-brand.png"],
  ["Kling 3.0", "kling", "/assets/models/kling-brand.png"],
  ["Kling 3.0 Omni", "kling", "/assets/models/kling-brand.png"],
  ["Seedream 4.0", "seed", "/assets/models/seed-brand-v2.png"],
  ["Seedream 3.0", "seed", "/assets/models/seed-brand-v2.png"],
  ["Seedream 3.0 Fast", "seed", "/assets/models/seed-brand-v2.png"],
  ["Image 2", "openai", "/assets/models/openai-brand.svg"],
  ["Nano Banana Pro", "gemini", "/assets/models/gemini-brand.png"],
  ["Nano Banana 2", "gemini", "/assets/models/gemini-brand.png"],
  ["Seedream 5.0", "seed", "/assets/models/seed-brand-v2.png"],
  ["Seedream 5.0 Lite", "seed", "/assets/models/seed-brand-v2.png"],
  ["Midjourney", "midjourney", "/assets/models/midjourney-brand.svg"],
];

test("maps every workbench image and video model to its official provider logo", () => {
  assert.equal(typeof logos.modelLogoFor, "function");

  for (const [model, provider, src] of expectedModels) {
    assert.deepEqual(logos.modelLogoFor(model), { provider, src });
  }
});

test("does not fall back to letter glyphs for unknown models", () => {
  assert.equal(logos.modelLogoFor?.("Unknown Model"), null);
});

test("renders accessible local logo markup without provider initials", () => {
  const html = logos.renderModelLogo?.("Image 2") ?? "";

  assert.match(html, /<img/u);
  assert.match(html, /src="\/assets\/models\/openai-brand\.svg"/u);
  assert.match(html, /alt="OpenAI"/u);
  assert.doesNotMatch(html, />I2</u);
});

test("decorates a model icon without replacing React-owned children", () => {
  assert.equal(typeof logos.decorateModelIcon, "function");
  const originalChild = { id: "react-owned-glyph" };
  const classes = new Set(["model-icon", "model-image"]);
  const attributes = new Map();
  const properties = new Map();
  let replaceChildrenCalls = 0;
  const icon = {
    childNodes: [originalChild],
    dataset: {},
    classList: {
      [Symbol.iterator]: () => classes.values(),
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
    },
    style: { setProperty: (name, value) => properties.set(name, value) },
    setAttribute: (name, value) => attributes.set(name, value),
    replaceChildren: () => { replaceChildrenCalls += 1; },
  };

  assert.equal(logos.decorateModelIcon(icon, "Image 2"), true);
  assert.equal(replaceChildrenCalls, 0);
  assert.deepEqual(icon.childNodes, [originalChild]);
  assert.equal(icon.dataset.imviaModelLogo, "Image 2");
  assert.equal(properties.get("--imvia-model-logo"), 'url("/assets/models/openai-brand.svg")');
  assert.equal(attributes.get("aria-label"), "OpenAI");
  assert.equal(classes.has("imvia-provider-openai"), true);
});

test("reads the selected model name without the React glyph prefix", () => {
  assert.equal(typeof logos.modelNameForIcon, "function");
  const selectedName = { textContent: "Image 2" };
  const select = {
    textContent: "I2Image 2",
  };
  const icon = {
    parentElement: { childNodes: [] },
    closest: (selector) => selector === ".select-box" ? select : null,
  };
  icon.parentElement.childNodes = [icon, selectedName];

  assert.equal(logos.modelNameForIcon(icon), "Image 2");
});

test("keeps model names readable and removes model icon tile backgrounds", () => {
  assert.match(logoCss, /\.model-section \.dropdown-menu\s*\{[^}]*width: max\(100%, 320px\)/u);
  assert.match(logoCss, /overflow: visible;\s*text-overflow: clip;\s*white-space: nowrap/u);
  assert.doesNotMatch(logoCss, /background-color:\s*#(?:20262a|101820|eb176d|000|22282c|13191e|f3f5f6)/u);
  assert.doesNotMatch(logoCss, /background:\s*transparent\s*!important/u);
  assert.match(logoCss, /background-image:\s*var\(--imvia-model-logo\)/u);
});
