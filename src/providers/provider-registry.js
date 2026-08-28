import { DomainError } from "../domain/errors.js";
import { createProviderDescriptor, validateAdapter } from "./connector-contract.js";
import { PROVIDER_ID_PATTERN } from "./constants.js";

const unknown = (id) => { throw new DomainError("NOT_FOUND", `Unknown provider: ${id}.`, { provider_id: id }); };

export function createProviderRegistry({ builtIns = [], adapters = [] } = {}) {
  const descriptors = new Map();
  const adapterMap = new Map();
  for (const entry of adapters) {
    const id = entry?.id ?? entry?.adapter_id;
    const adapter = entry?.adapter ?? entry;
    if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) throw new DomainError("VALIDATION_FAILED", "Adapter id is invalid.", { field: "adapter_id" });
    if (adapterMap.has(id)) throw new DomainError("VALIDATION_FAILED", "Adapter is already registered.", { field: "adapter_id", adapter_id: id });
    adapterMap.set(id, validateAdapter(adapter, `adapters.${id}`));
  }
  const register = (input) => {
    const descriptorInput = input?.descriptor ?? input;
    const descriptor = createProviderDescriptor(descriptorInput);
    if (descriptor.kind === "generic_rest" && input?.adapter !== undefined) throw new DomainError("VALIDATION_FAILED", "generic_rest providers cannot include an inline adapter.", { field: "adapter" });
    if (descriptors.has(descriptor.id)) throw new DomainError("VALIDATION_FAILED", "Provider is already registered.", { field: "id", provider_id: descriptor.id });
    if (descriptor.kind === "adapter") {
      const adapter = input?.adapter ?? adapterMap.get(descriptor.adapter_id);
      if (!adapter) validateAdapter(adapter, `provider.${descriptor.id}.adapter`);
      if (input?.adapter && adapterMap.has(descriptor.adapter_id)) throw new DomainError("VALIDATION_FAILED", "Adapter is already registered.", { field: "adapter_id", adapter_id: descriptor.adapter_id });
    }
    descriptors.set(descriptor.id, descriptor);
    if (input?.adapter) adapterMap.set(descriptor.adapter_id, validateAdapter(input.adapter, `provider.${descriptor.id}.adapter`));
    return descriptor;
  };
  builtIns.forEach(register);
  return Object.freeze({
    register,
    get(id) { return descriptors.get(id) ?? unknown(id); },
    list() { return Object.freeze([...descriptors.values()]); },
    modelsFor(id, filter = {}) {
      const descriptor = descriptors.get(id) ?? unknown(id);
      const capability = typeof filter === "string" ? filter : filter.capability ?? filter.mode;
      return Object.freeze(descriptor.models.filter((model) => !capability || model.capabilities.includes(capability)));
    },
    resolve(id) {
      const descriptor = descriptors.get(id) ?? unknown(id);
      return Object.freeze({ descriptor, adapter: descriptor.adapter_id ? adapterMap.get(descriptor.adapter_id) : undefined });
    },
  });
}
