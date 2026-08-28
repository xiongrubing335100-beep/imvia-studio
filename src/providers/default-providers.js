import { createProviderRegistry } from "./provider-registry.js";

const lovartAdapter = Object.freeze({
  async validateConnection() { return {}; },
  async submit() { return {}; },
  async poll() { return {}; },
  async cancel() { return {}; },
  async importResults() { return {}; },
});

export const DEFAULT_PROVIDER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: "lovart",
    display_name: "Lovart",
    kind: "adapter",
    adapter_id: "lovart",
    capabilities: ["image", "video"],
    models: [],
    credential_fields: [],
  }),
  Object.freeze({
    id: "external-api",
    display_name: "外部 API",
    kind: "discovered",
    adapter_id: null,
    capabilities: ["image", "video"],
    models: [],
    credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }],
  }),
  Object.freeze({
    id: "custom-rest",
    display_name: "自定义 REST API",
    kind: "generic_rest",
    adapter_id: null,
    capabilities: ["image", "video"],
    models: [{ id: "Auto", display_name: "由接口映射决定", capabilities: ["image", "video"] }],
    credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }],
  }),
]);

export function createDefaultProviderRegistry() {
  return createProviderRegistry({
    builtIns: [
      { ...DEFAULT_PROVIDER_DESCRIPTORS[0], adapter: lovartAdapter },
      DEFAULT_PROVIDER_DESCRIPTORS[1],
      DEFAULT_PROVIDER_DESCRIPTORS[2],
    ],
  });
}
