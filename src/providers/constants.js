export const MEDIA_CAPABILITIES = Object.freeze(["image", "video"]);
export const MODEL_COMPATIBILITIES = Object.freeze(["confirmed", "unconfirmed", "unsupported"]);
export const DISCOVERY_STATUSES = Object.freeze(["idle", "discovering", "ready", "stale", "failed"]);
export const MODEL_COMPATIBILITY_VALUES = MODEL_COMPATIBILITIES;
export const DISCOVERY_STATUS_VALUES = DISCOVERY_STATUSES;
export const EXTERNAL_PROVIDER_ID = "external-api";
export const PROVIDER_KINDS = Object.freeze(["generic_rest", "adapter", "discovered"]);
export const ADAPTER_METHODS = Object.freeze([
  "validateConnection",
  "submit",
  "poll",
  "cancel",
  "importResults",
]);

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
export const CREDENTIAL_FIELD_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
