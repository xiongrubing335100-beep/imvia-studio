import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildConnectionFormPayload,
  connectionErrorMessage,
  connectionModelGroups,
  connectionRequestHeaders,
  filterConnectionModels,
  filterProviderModels,
  isSelectableConnection,
  resolveProviderSelection,
  serializeProviderSelection,
} from "../workbench/dist/assets/imvia-provider-connections-v1.js";

const providers = [
  { id: "lovart", display_name: "Lovart", capabilities: ["image", "video"], models: [{ id: "Image 2", display_name: "Image 2", capabilities: ["image"] }, { id: "Seedance", display_name: "Seedance", capabilities: ["video"] }], credential_fields: [{ id: "access_key", secret: true }] },
  { id: "external", display_name: "External", capabilities: ["image"], models: [{ id: "external-image", display_name: "External Image", capabilities: ["image"] }], credential_fields: [{ id: "api_key", secret: true }] },
];

const providerUiSource = await readFile(new URL("../workbench/dist/assets/imvia-provider-connections-v1.js", import.meta.url), "utf8");
const providerUiCss = await readFile(new URL("../workbench/dist/assets/imvia-provider-connections-v1.css", import.meta.url), "utf8");

test("keeps the provider selector and manager visible when catalog loading fails", () => {
  assert.match(providerUiSource, /Promise\.allSettled\(\[loadProviderCatalog\(\{ mode \}\), loadConnections\(\)\]\)/u);
  assert.match(providerUiSource, /setAttribute\("aria-label", "管理连接"\)/u);
});

test("initializes the provider UI once after the workbench DOM is ready", () => {
  assert.match(providerUiSource, /const PROVIDER_INITIALIZATIONS = new WeakMap\(\)/u);
  assert.match(providerUiSource, /DOMContentLoaded/u);
  assert.match(providerUiSource, /imvia:workbench-ready/u);
  assert.match(providerUiSource, /MutationObserver/u);
  assert.equal((providerUiSource.match(/if \(globalThis\.document\) initializeProviderConnections\(\);/gu) || []).length, 1);
  assert.match(providerUiSource, /if \(state\.started\) return state/u);
});

test("renders a borderless custom provider menu that matches the workbench", () => {
  assert.match(providerUiSource, /querySelector\("\.app-header"\)/u);
  assert.match(providerUiSource, /textContent = "管理"/u);
  assert.match(providerUiSource, /className = "imvia-provider-trigger"/u);
  assert.match(providerUiSource, /setAttribute\("role", "listbox"\)/u);
  assert.match(providerUiSource, /manage\.onclick = \(\) => \{ setProviderMenuOpen\(selector, false\)/u);
  assert.doesNotMatch(providerUiSource, /createElement\("select"\)/u);
  assert.match(providerUiCss, /\.app-header \.imvia-provider-selector/u);
  assert.match(providerUiCss, /\.imvia-provider-trigger[^}]*border:0/u);
  assert.match(providerUiCss, /\.imvia-provider-trigger/u);
});

test("keeps provider management focused on adding an API provider", () => {
  assert.match(providerUiSource, /添加 API/u);
  assert.match(providerUiSource, /aria-label="关闭">×/u);
  assert.doesNotMatch(providerUiSource, /导入模板/u);
});

test("modern connections expose only friendly fields", () => {
  assert.match(providerUiSource, /API 名称（可选）/u);
  assert.match(providerUiSource, /aria-label="API 地址"/u);
  assert.match(providerUiSource, /连接并识别/u);
  assert.match(providerUiSource, /正在验证地址/u);
  assert.match(providerUiSource, /正在打开安全密钥窗口/u);
  assert.match(providerUiSource, /正在读取模型/u);
  assert.match(providerUiSource, /已找到.*模型/u);
  assert.match(providerUiSource, /刷新模型/u);
  assert.match(providerUiSource, /更新密钥/u);
  assert.match(providerUiSource, /停用/u);
  assert.match(providerUiSource, /删除/u);
  assert.match(providerUiSource, /旧版连接/u);
  for (const forbidden of ["服务商类型", "生成能力", "接口映射 JSON", "高级设置 JSON", "data-capability", "endpoint_mappings_text", "parseObjectText"]) {
    assert.equal(providerUiSource.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(providerUiSource, /globalThis\.prompt|window\.prompt/u);
  assert.match(providerUiSource, /if \(connection\.legacy\) return; \/\/ Legacy records never enter the modern external credential workflow\./u);
});

test("turns friendly form values into the modern draft payload", () => {
  assert.deepEqual(buildConnectionFormPayload({ name: "External primary", base_url: "https://api.example.test/v1" }), {
    name: "External primary", base_url: "https://api.example.test/v1",
  });
  assert.deepEqual(buildConnectionFormPayload({ name: "   ", base_url: "api.example.test/v1" }), { base_url: "api.example.test/v1" });
});

test("requires an API address with a field-specific visible error", () => {
  assert.throws(() => buildConnectionFormPayload({ name: "External primary", base_url: "" }), (error) => error.code === "INVALID_CONNECTION_FORM" && error.field === "base_url");
});

test("maps discovery failures to friendly actions without exposing internal fields", () => {
  assert.deepEqual(connectionErrorMessage({ code: "VALIDATION_FAILED" }), {
    message: "API 地址格式不正确，请填写完整地址，例如 https://api.example.com/v1。", action: "修改地址", field: "base_url",
  });
  assert.deepEqual(connectionErrorMessage({ code: "AUTHENTICATION_FAILED" }), {
    message: "API Key 无效或没有读取模型的权限。", action: "更新密钥",
  });
  assert.equal(connectionErrorMessage({ code: "UPSTREAM_RATE_LIMITED" }).action, "稍后重试");
  assert.equal(connectionErrorMessage({ code: "UNEXPECTED", message: "base_url bad" }).message.includes("base_url"), false);
});

test("groups safe model catalog entries by compatibility for the active mode", () => {
  const groups = connectionModelGroups({ catalog: { models: [
    { id: "image-confirmed", name: "Image confirmed", capabilities: ["image"], compatibility: "confirmed" },
    { id: "image-unknown", name: "Image unknown", capabilities: [], compatibility: "unconfirmed" },
    { id: "video-only", name: "Video only", capabilities: ["video"], compatibility: "unsupported" },
  ] } }, "image");
  assert.deepEqual(groups.confirmed.map((model) => model.id), ["image-confirmed"]);
  assert.deepEqual(groups.unconfirmed.map((model) => model.id), []);
  assert.deepEqual(groups.unsupported.map((model) => model.id), ["image-unknown", "video-only"]);
});

test("external selection uses only the enabled connection catalog while retaining unsupported entries for details", () => {
  const connection = { provider_id: "external-api", status: "connected", enabled: true, legacy: false, catalog: { models: [
    { id: "provider-image", name: "Provider Image", capabilities: ["image"], compatibility: "confirmed" },
    { id: "unknown-model", name: "Unknown model", capabilities: ["image"], compatibility: "unconfirmed" },
    { id: "video-only", name: "Video only", capabilities: ["video"], compatibility: "confirmed" },
  ] } };
  const filtered = filterConnectionModels({ connection, mode: "image" });
  assert.deepEqual(filtered.selectable.map((model) => model.id), ["provider-image", "unknown-model"]);
  assert.equal(filtered.selectable.some((model) => model.id === "Auto"), false);
  assert.deepEqual(filtered.unsupported.map((model) => model.id), ["video-only"]);
  assert.deepEqual(filterProviderModels({ provider: { id: "external-api", models: [{ id: "descriptor-only", capabilities: ["image"] }] }, connection, mode: "image" }).map((model) => model.id), ["provider-image", "unknown-model"]);
});

test("a raw external API model named Auto stays visible as unsupported and cannot become a selection", () => {
  const connection = { connection_id: "auto-only", provider_id: "external", status: "connected", enabled: true, legacy: false, catalog: { models: [
    { id: "Auto", name: "Provider Auto", capabilities: ["image"], compatibility: "confirmed" },
  ] } };
  const filtered = filterConnectionModels({ connection, mode: "image" });
  assert.deepEqual(filtered.selectable, []);
  assert.deepEqual(filtered.unsupported.map((model) => model.id), ["Auto"]);
  assert.deepEqual(resolveProviderSelection({
    providers,
    connections: [connection],
    rememberedProvider: "external",
    rememberedConnection: "auto-only",
    rememberedModel: "Auto",
    explicitProviderSelection: false,
  }), { provider_id: "lovart", connection_id: null, model: "Auto" });
});

test("provider refreshes have a stable signature so unchanged controls are not rebuilt", () => {
  assert.equal(typeof providerUiSource, "string");
  assert.match(providerUiSource, /providerRenderSignature/u);
  assert.match(providerUiSource, /dataset\.imviaRenderSignature === renderSignature/u);
});

test("provider selection serializes only immutable public IDs and model metadata", () => {
  const snapshot = serializeProviderSelection({ providerId: "external", connectionId: "connection-1", model: "external-image" });
  assert.deepEqual(snapshot, { provider_id: "external", connection_id: "connection-1", model: "external-image" });
  const encoded = JSON.stringify(snapshot);
  for (const forbidden of ["credential", "access_key", "api_key", "secret"]) assert.equal(encoded.includes(forbidden), false);
});

test("provider model choices filter by image and video capability", () => {
  assert.deepEqual(filterProviderModels({ provider: providers[0], mode: "image" }).map((model) => model.id), ["Auto", "Image 2"]);
  assert.deepEqual(filterProviderModels({ provider: providers[0], mode: "video" }).map((model) => model.id), ["Auto", "Seedance"]);
  assert.deepEqual(filterProviderModels({ provider: { id: "lovart", models: [{ id: "Auto", display_name: "由接口映射决定", capabilities: ["image", "video"] }] }, mode: "image" }).map((model) => model.id), ["Auto"]);
});

test("only discovered, enabled external connections can be selected and Lovart defaults safely", () => {
  assert.equal(isSelectableConnection({ providerId: "external", connection: { provider_id: "external", enabled: false } }), false);
  assert.equal(isSelectableConnection({ providerId: "external", connection: { provider_id: "external", enabled: true } }), false);
  assert.equal(isSelectableConnection({ providerId: "external", connection: { provider_id: "external", enabled: true, legacy: false, catalog: { models: [{ id: "provider-image" }] } } }), false);
  assert.equal(isSelectableConnection({ providerId: "external", connection: { provider_id: "external", status: "connected", enabled: true, legacy: false, catalog: { models: [{ id: "provider-image" }] } } }), true);
  assert.deepEqual(serializeProviderSelection({}), { provider_id: "lovart", connection_id: null, model: "Auto" });
});

test("connection mutations carry the current workbench bridge headers", () => {
  assert.deepEqual(connectionRequestHeaders({ method: "PATCH", search: "?session=session-1&bridge_token=token-1" }), {
    "content-type": "application/json", "x-imvia-workbench-session": "session-1", "x-imvia-workbench-token": "token-1",
  });
  assert.deepEqual(connectionRequestHeaders({ method: "GET", search: "?session=session-1&bridge_token=token-1" }), { "content-type": "application/json" });
});

test("stale external selection without an enabled connection falls back to Lovart", () => {
  assert.deepEqual(resolveProviderSelection({ providers, connections: [{ connection_id: "disabled", provider_id: "external", enabled: false }], rememberedProvider: "external", rememberedConnection: "disabled" }), {
    provider_id: "lovart", connection_id: null, model: "Auto",
  });
});

test("a connected one-model external catalog auto-resolves to its model and resets back to Lovart Auto", () => {
  const connections = [{ connection_id: "connection-1", provider_id: "external", status: "connected", enabled: true, legacy: false, catalog: { models: [{ id: "provider-image", name: "Provider Image", capabilities: ["image"], compatibility: "confirmed" }] } }];
  assert.deepEqual(resolveProviderSelection({
    providers,
    connections,
    rememberedProvider: "lovart",
    rememberedConnection: null,
    explicitProviderSelection: false,
  }), {
    provider_id: "external", connection_id: "connection-1", model: "provider-image",
  });
  assert.deepEqual(resolveProviderSelection({
    providers,
    connections,
    rememberedProvider: "lovart",
    rememberedConnection: null,
    explicitProviderSelection: true,
  }), {
    provider_id: "lovart", connection_id: null, model: "Auto",
  });
  assert.match(providerUiSource, /dataset\.imviaModel = selection\.model/u);
  assert.match(providerUiSource, /dispatchProviderSelection\(documentRoot, \{ selection, provider, connection, mode \}\)/u);
});
