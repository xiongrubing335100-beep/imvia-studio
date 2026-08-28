# IMVIA Studio Friendly API Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace user-authored REST JSON with a friendly API-name/address/key flow that safely discovers external models, exposes connection-owned model catalogs, and executes only through a matching trusted adapter without Lovart fallback.

**Architecture:** Add a bounded outbound HTTP safety layer, immutable model-catalog normalizer, discovery-adapter registry, OpenAI-compatible discovery/image adapter, and connection lifecycle service beside the existing provider system. New `external-api` connections own their discovered model catalogs and adapter metadata; legacy `custom-rest` profiles remain readable and executable through the existing generic connector. The workbench consumes only redacted connection catalogs, freezes the selected model and adapter metadata into each task, and continues to submit through the current Codex conversation bridge.

**Tech Stack:** Node.js ESM, `node:https`, `node:dns/promises`, `node:crypto`, existing `JsonStore`, existing legacy `fetch` connector, MCP SDK, local HTTP/SSE workbench service, bundled native credential helper, browser DOM modules, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-imvia-friendly-api-auto-discovery-design.md`

## Global Constraints

- New and modernized connection screens expose only optional API name, required API address, and API Key through the existing native secure window; they expose no provider-type, capability, model, endpoint-mapping, or settings JSON inputs.
- API names returned by the provider are displayed as `name` with `id` secondary; an ID-only record displays the original ID. IMVIA does not rename external models.
- Every safely parsed upstream model remains visible in connection details. A model is enabled for generation only when the selected adapter has a reliable route for the current mode.
- OpenAI-compatible discovery is read-only. Discovery must never upload, generate, create projects, confirm costs, or call a status/result endpoint.
- Browser code calls only the local IMVIA HTTP service. It never sends credentials or direct provider requests.
- API Keys remain in the bundled IMVIA private credential helper and never enter browser state, connection JSON, model catalogs, task snapshots, Codex messages, logs, or public errors.
- Provider addresses must resolve to HTTPS targets outside loopback, private, link-local, and cloud-metadata ranges. Every DNS result and redirect target receives the same validation.
- An external task executes only its frozen connection and adapter. Any external error produces zero Lovart calls and no provider/model substitution.
- A catalog-only refresh does not increment `config_revision` or invalidate an existing task. Address, key, or adapter changes do increment `config_revision` and make older pending tasks require resubmission.
- Existing `custom-rest` profiles preserve their IDs, mappings, settings, credential references, and execution behavior. They are marked legacy and never silently rewritten into new connections.
- Do not touch `/Users/a1234/Documents/ChatGPT/lovart插件` or any independent Lovart plugin file.
- Preserve unrelated dirty-worktree changes. Every task commit must name only that task's files.
- Before implementation, capture `git status --short` and `git diff` as the ownership baseline. If a task overlaps a pre-existing dirty file and its new hunks cannot be staged without including pre-existing work, leave the task uncommitted and report that boundary instead of staging user-owned hunks.
- After implementation, run focused and full verification, refresh the plugin cachebuster with the plugin-creator helper, validate the plugin, reinstall `imvia-studio@personal`, and verify the installed cache. A new Codex task is required to prove that reinstalled skills/MCP tools loaded.

## File Map

### New backend modules

- `src/providers/provider-url.js`: user-friendly URL normalization and deterministic discovery candidate construction.
- `src/providers/safe-provider-http.js`: DNS/IP/redirect/timeout/response-size enforcement for discovery and trusted adapters.
- `src/providers/model-catalog.js`: safe model normalization, compatibility metadata, ordering, digests, and mode projections.
- `src/providers/adapter-registry.js`: trusted discovery/execution adapter registration by ID and version.
- `src/providers/provider-discovery.js`: adapter selection and read-only model discovery orchestration.
- `src/providers/adapters/openai-compatible-images.js`: OpenAI-compatible `/models` discovery and standard synchronous image execution.
- `src/providers/provider-connection-service.js`: draft → secure credential prompt → discovery → atomic enable/refresh lifecycle.

### Existing backend modules to modify

- `src/providers/constants.js`: discovery statuses, compatibility values, and external provider ID.
- `src/providers/connector-contract.js`: accept connection-owned external catalogs without making static descriptors authoritative.
- `src/providers/default-providers.js`: register `external-api` while keeping `custom-rest` as legacy.
- `src/providers/connection-store.js`: schema migration, draft/discovery/catalog fields, name fallback, atomic catalog replacement, and legacy preservation.
- `src/providers/provider-execution-router.js`: resolve modern connections by frozen adapter ID/version; retain legacy generic REST routing.
- `src/domain/model-capabilities.js`: validate non-Lovart models against the selected connection catalog.
- `src/domain/workbench-service.js`: freeze catalog/adapter/selected-model metadata and distinguish config changes from catalog refresh.
- `src/http/server.js`: redacted discovery/refresh endpoints, connection catalogs, events, and friendly error surfaces.
- `src/index.js`: construct adapter/discovery/connection services and expose safe MCP metadata.
- `skills/imvia-studio/SKILL.md`: document that modern external submissions use the frozen adapter only and never Lovart.

### Workbench assets to modify

- `workbench/dist/assets/imvia-provider-connections-v1.js`: simplified form, progress states, connection cards, dynamic model catalogs, and legacy labels.
- `workbench/dist/assets/imvia-provider-connections-v1.css`: simplified form/progress/catalog/disabled-model styling.
- `workbench/dist/assets/imvia-model-auto-v1.js`: use connection-owned models and omit external `Auto`.
- `workbench/dist/assets/imvia-result-workspace.js`: freeze the selected external model metadata in the submission.
- `workbench/dist/index.html`: increment local asset query cachebusters after UI changes.

### Tests to create or modify

- Create `test/provider-url-security.test.mjs`.
- Create `test/model-catalog.test.mjs`.
- Create `test/provider-discovery.test.mjs`.
- Create `test/openai-compatible-images.test.mjs`.
- Create `test/provider-connection-service.test.mjs`.
- Modify `test/default-provider-registry.test.mjs`.
- Modify `test/connection-store.test.mjs`.
- Modify `test/provider-http.test.mjs`.
- Modify `test/workbench-provider-ui.test.mjs`.
- Modify `test/workbench-model-auto.test.mjs`.
- Modify `test/workbench-provider-selection.test.mjs`.
- Modify `test/provider-execution-router.test.mjs`.
- Modify `test/provider-e2e.test.mjs`.
- Modify `test/skill-contract.test.mjs`.
- Create `docs/verification/2026-08-25-imvia-friendly-api-auto-discovery.md`.

---

### Task 1: Normalize API URLs and enforce outbound network safety

**Files:**
- Create: `src/providers/provider-url.js`
- Create: `src/providers/safe-provider-http.js`
- Create: `test/provider-url-security.test.mjs`
- Modify: `src/providers/request-template.js`
- Modify: `test/generic-rest-connector.test.mjs`

**Interfaces:**
- Consumes: `DomainError` from `src/domain/errors.js`.
- Produces: `normalizeProviderBaseUrl(value) -> string`.
- Produces: `modelDiscoveryCandidates(baseUrl) -> string[]`.
- Produces: `assertSafeProviderUrl(url, { lookup }) -> Promise<URL>`.
- Produces: `safeProviderJsonRequest({ url, method = "GET", headers, body, transport, lookup, timeout_ms, maximum_bytes, maximum_redirects }) -> Promise<{ status, headers, json }>`.
- Private helpers/constants defined in this task: `REDIRECT_STATUSES`, `fail`, `isForbiddenAddress`, `resolvePublicAddresses`, `requestPinnedHttps`, `readBoundedJson`, and `securityFail`.

- [ ] **Step 1: Write the failing URL and network tests.** Add exact cases for scheme completion, `/v1` candidates, credentials/query/fragment rejection, IPv4/IPv6 private ranges, all DNS answers being checked, cross-host redirect rejection, timeout, and oversized bodies.

```js
test("normalizes a domain and builds bounded OpenAI model candidates", () => {
  assert.equal(normalizeProviderBaseUrl("api.example.test/v1/"), "https://api.example.test/v1");
  assert.deepEqual(modelDiscoveryCandidates("https://api.example.test/v1"), [
    "https://api.example.test/v1/models",
  ]);
  assert.deepEqual(modelDiscoveryCandidates("https://api.example.test"), [
    "https://api.example.test/v1/models",
    "https://api.example.test/models",
  ]);
});

test("rejects every private DNS answer before fetch", async () => {
  let calls = 0;
  await assert.rejects(
    safeProviderJsonRequest({
      url: "https://api.example.test/v1/models",
      lookup: async () => [{ address: "203.0.113.10", family: 4 }, { address: "127.0.0.1", family: 4 }],
      transport: async () => { calls += 1; },
    }),
    (error) => error.code === "UPSTREAM_SECURITY_REJECTED",
  );
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run the new test and verify RED.**

Run: `node --test test/provider-url-security.test.mjs`

Expected: FAIL because `provider-url.js` and `safe-provider-http.js` do not exist.

- [ ] **Step 3: Implement minimal URL normalization and discovery candidates.** Keep candidates on the exact normalized origin; add `https://` only for a domain-like input and reject malformed values with `VALIDATION_FAILED` plus `details.field = "base_url"`.

```js
export function normalizeProviderBaseUrl(value) {
  const input = String(value ?? "").trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(input) ? input : `https://${input}`;
  let url;
  try { url = new URL(candidate); } catch { fail("API 地址格式不正确。", "base_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    fail("API 地址必须是安全的 HTTPS 地址。", "base_url");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}
```

- [ ] **Step 4: Implement safe JSON transport and reuse its host classifier in `request-template.js`.** Resolve and validate every DNS answer before connecting, then use `node:https.request` with a pinned `lookup` callback so the socket cannot perform a second unchecked resolution. Disable automatic redirects, validate every redirect, cap redirects at 2, timeout at 10 seconds by default, and cap discovery bodies at 1 MiB. Preserve the original hostname for TLS SNI/certificate checks. Do not retain a second weaker `privateHost` implementation.

```js
export async function safeProviderJsonRequest(input) {
  let target = await assertSafeProviderUrl(new URL(input.url), { lookup: input.lookup });
  for (let redirects = 0; redirects <= (input.maximum_redirects ?? 2); redirects += 1) {
    const response = await requestPinnedHttps(target, input);
    if (!REDIRECT_STATUSES.has(response.status)) return readBoundedJson(response, input.maximum_bytes ?? 1_000_000);
    const next = new URL(response.headers.get("location"), target);
    if (next.origin !== target.origin) securityFail("Cross-origin redirects are not allowed.");
    target = await assertSafeProviderUrl(next, { lookup: input.lookup });
  }
  securityFail("Too many redirects.");
}
```

- [ ] **Step 5: Run focused tests and commit.**

Run: `node --test test/provider-url-security.test.mjs test/generic-rest-connector.test.mjs`

Expected: PASS, with zero fetch calls for every rejected target.

```bash
git add src/providers/provider-url.js src/providers/safe-provider-http.js src/providers/request-template.js test/provider-url-security.test.mjs test/generic-rest-connector.test.mjs
git commit -m "feat: secure external API discovery URLs"
```

### Task 2: Normalize immutable connection-owned model catalogs

**Files:**
- Create: `src/providers/model-catalog.js`
- Create: `test/model-catalog.test.mjs`
- Modify: `src/providers/constants.js`

**Interfaces:**
- Consumes: raw adapter model entries and optional `classify(model)` callback.
- Produces: `normalizeModelCatalog({ entries, classify, now }) -> { revision_input, digest, models, counts }`.
- Produces: `modelRecordDigest(model) -> sha256 hex string`.
- Produces: `modelsForMode(models, mode) -> { confirmed, unconfirmed, unsupported }`.
- A normalized model is `{ id, display_name, capabilities, compatibility, source: "api", raw_index }`.
- Private helpers defined in this task: `stableJson`, `deepFreeze`, `deduplicate`, `normalizeModel`, and `countModels`.

- [ ] **Step 1: Write failing catalog tests.** Cover `name`/`id` preservation, ID-only models, duplicate IDs, unsafe/oversized fields, stable upstream order, deterministic digest, compatibility groups, and complete visibility of unsupported models.

```js
test("preserves provider names and exposes every normalized model", () => {
  const catalog = normalizeModelCatalog({
    entries: [{ id: "img-1", name: "Image One" }, { id: "unknown-2" }],
    classify: ({ id }) => id === "img-1"
      ? { capabilities: ["image"], compatibility: "confirmed" }
      : { capabilities: [], compatibility: "unsupported" },
    now: () => "2026-08-25T00:00:00.000Z",
  });
  assert.deepEqual(catalog.models.map(({ id, display_name }) => [id, display_name]), [
    ["img-1", "Image One"],
    ["unknown-2", "unknown-2"],
  ]);
  assert.equal(modelsForMode(catalog.models, "image").unsupported[0].id, "unknown-2");
});
```

- [ ] **Step 2: Run the test and verify RED.**

Run: `node --test test/model-catalog.test.mjs`

Expected: FAIL with missing module/export.

- [ ] **Step 3: Implement bounded normalization.** Accept at most 2,000 models; require a stable ID of at most 256 characters; cap display names at 512 characters; deduplicate by ID using the first occurrence; strip all unrecognized raw properties.

```js
const COMPATIBILITY = new Set(["confirmed", "unconfirmed", "unsupported"]);

export function normalizeModelCatalog({ entries, classify = () => ({}), now = () => new Date().toISOString() }) {
  const models = deduplicate(entries).map((entry, raw_index) => normalizeModel(entry, classify(entry), raw_index));
  const digest = createHash("sha256").update(stableJson(models)).digest("hex");
  return Object.freeze({ discovered_at: now(), digest, models: deepFreeze(models), counts: countModels(models) });
}
```

- [ ] **Step 4: Implement mode projections without hiding models.** `confirmed` and `unconfirmed` are selectable only when their capabilities include the requested mode; every other model appears in `unsupported` for connection details.

```js
export function modelsForMode(models, mode) {
  return Object.freeze({
    confirmed: models.filter((model) => model.compatibility === "confirmed" && model.capabilities.includes(mode)),
    unconfirmed: models.filter((model) => model.compatibility === "unconfirmed" && model.capabilities.includes(mode)),
    unsupported: models.filter((model) => !model.capabilities.includes(mode) || model.compatibility === "unsupported"),
  });
}
```

- [ ] **Step 5: Run the catalog test and commit.**

Run: `node --test test/model-catalog.test.mjs`

Expected: PASS.

```bash
git add src/providers/constants.js src/providers/model-catalog.js test/model-catalog.test.mjs
git commit -m "feat: add immutable external model catalogs"
```

### Task 3: Add trusted adapter registration and OpenAI-compatible discovery

**Files:**
- Create: `src/providers/adapter-registry.js`
- Create: `src/providers/provider-discovery.js`
- Create: `src/providers/adapters/openai-compatible-images.js`
- Create: `test/provider-discovery.test.mjs`
- Create: `test/openai-compatible-images.test.mjs`
- Modify: `src/providers/constants.js`
- Modify: `src/providers/connector-contract.js`
- Modify: `src/providers/default-providers.js`
- Modify: `test/provider-contract.test.mjs`
- Modify: `test/default-provider-registry.test.mjs`

**Interfaces:**
- Consumes: `safeProviderJsonRequest`, `modelDiscoveryCandidates`, and `normalizeModelCatalog`.
- Produces: `createAdapterRegistry({ adapters }) -> { list, get, discover }`.
- Produces: `createProviderDiscoveryService({ adapterRegistry, request, now }) -> { discover({ base_url, credential }) }`.
- Produces: `createOpenAiCompatibleImagesAdapter({ request }) -> DiscoveryExecutionAdapter`.
- `discover` returns `{ protocol, adapter_id, adapter_version, provider_label, models_endpoint, catalog }`.
- A trusted adapter exposes `{ id, version, discover, classifyModel, estimateCost, validateConnection, submit, poll, cancel, importResults }`. `estimateCost` is read-only and returns `{ status: "known", amount, unit }` or `{ status: "unknown" }` before any provider submission.
- Private helpers/constants and fixtures defined in this task: `KNOWN_IMAGE_IDS`, `validateDiscoveryAdapter`, `publicAdapterMetadata`, `recoverableMiss`, `normalizeDiscovery`, `notFound`, and the test-local response factory. `recoverableMiss` may continue only after an unrecognized-success response or a not-found candidate; authentication, rate-limit, security, timeout, and upstream-unavailable errors stop discovery immediately.

- [ ] **Step 1: Write failing adapter/discovery tests.** Assert duplicate adapter IDs fail, version lookup is exact, only GET model probes occur, candidates stop at the first recognized response, HTML/unknown JSON are rejected, `401/403/429/5xx` map to stable codes, and no model name is rewritten.

```js
test("discovers OpenAI-compatible models with read-only GET requests", async () => {
  const calls = [];
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async (input) => {
    calls.push([input.method, input.url]);
    return { status: 200, headers: new Headers(), json: { data: [{ id: "gpt-image-1" }, { id: "vendor-model", name: "Vendor Model" }] } };
  }});
  const result = await adapter.discover({ base_url: "https://api.example.test/v1", credential: { api_key: "secret" } });
  assert.deepEqual(calls, [["GET", "https://api.example.test/v1/models"]]);
  assert.deepEqual(result.entries.map((model) => model.id), ["gpt-image-1", "vendor-model"]);
});
```

- [ ] **Step 2: Run discovery tests and verify RED.**

Run: `node --test test/provider-discovery.test.mjs test/openai-compatible-images.test.mjs test/default-provider-registry.test.mjs`

Expected: FAIL because the registry, discovery service, adapter, and `external-api` descriptor are absent.

- [ ] **Step 3: Implement the trusted adapter registry and discovery orchestrator.** Freeze adapter metadata, reject unregistered IDs/versions, pass only `{ base_url, credential }` to discovery, and return normalized catalog data rather than raw upstream JSON.

```js
export function createAdapterRegistry({ adapters = [] } = {}) {
  const entries = new Map(adapters.map((adapter) => [`${adapter.id}@${adapter.version}`, validateDiscoveryAdapter(adapter)]));
  return Object.freeze({
    list: () => [...entries.values()].map(publicAdapterMetadata),
    get: (id, version) => entries.get(`${id}@${version}`) ?? notFound(id, version),
    async discover(input) {
      for (const adapter of entries.values()) {
        const result = await adapter.discover(input).catch(recoverableMiss);
        if (result) return normalizeDiscovery(adapter, result, input);
      }
      throw new DomainError("UPSTREAM_SCHEMA_UNRECOGNIZED", "该 API 暂不支持自动识别。");
    },
  });
}
```

- [ ] **Step 4: Implement OpenAI-compatible discovery classification.** A recognized `/models` response creates an `openai-images` catalog. Known image IDs may be `confirmed`; every other model is `unconfirmed` for image because the adapter has a standard image route. Do not claim video support.

```js
function classifyModel(model) {
  return KNOWN_IMAGE_IDS.has(model.id)
    ? { capabilities: ["image"], compatibility: "confirmed" }
    : { capabilities: ["image"], compatibility: "unconfirmed" };
}
```

Add the provider kind `discovered`. Update production defaults to `lovart`, modern `external-api`, and legacy `custom-rest`; only `external-api` is offered for new automatic connections. The modern descriptor is connection-catalog driven and therefore has no static models or fixed execution adapter:

```js
{
  id: "external-api",
  display_name: "外部 API",
  kind: "discovered",
  adapter_id: null,
  capabilities: ["image", "video"],
  models: [],
  credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }],
}
```

- [ ] **Step 5: Run discovery/default tests and commit.**

Run: `node --test test/provider-discovery.test.mjs test/openai-compatible-images.test.mjs test/provider-contract.test.mjs test/default-provider-registry.test.mjs`

Expected: PASS; every discovery call is GET-only.

```bash
git add src/providers/adapter-registry.js src/providers/provider-discovery.js src/providers/adapters/openai-compatible-images.js src/providers/constants.js src/providers/connector-contract.js src/providers/default-providers.js test/provider-discovery.test.mjs test/openai-compatible-images.test.mjs test/provider-contract.test.mjs test/default-provider-registry.test.mjs
git commit -m "feat: discover OpenAI-compatible provider models"
```

### Task 4: Execute standard OpenAI-compatible image generations

**Files:**
- Modify: `src/providers/adapters/openai-compatible-images.js`
- Modify: `test/openai-compatible-images.test.mjs`

**Interfaces:**
- Consumes: validated modern connection, `{ api_key }`, frozen snapshot, attachments, and progress callback.
- Produces the existing adapter methods `validateConnection`, `submit`, `poll`, `cancel`, and `importResults`.
- `estimateCost` returns `{ status: "unknown" }` without a network request because a generic OpenAI-compatible endpoint does not expose a reliable quote contract.
- `submit` returns `{ synchronous: true, status: "succeeded", result }` for a completed standard image response after the router has recorded cost authorization.
- `importResults` returns `{ artifacts: [{ kind: "image", source_url? , base64? , mime_type, source_artifact_id }] }`.
- Private helpers defined in this task: `joinApiPath`, `compact`, `postImages`, `normalizeImageArtifact`, and `schemaError`.

- [ ] **Step 1: Add failing execution tests.** Cover bearer authorization, exact raw model ID, prompt, result count, optional standard `size`, URL results, `b64_json` results, malformed empty results, auth/rate-limit/server errors, and credential redaction.

```js
test("submits the frozen raw model to the standard image endpoint", async () => {
  const seen = [];
  const adapter = createOpenAiCompatibleImagesAdapter({ request: async (input) => {
    seen.push(input);
    return { status: 200, headers: new Headers(), json: { data: [{ url: "https://cdn.example.test/1.png" }] } };
  }});
  const result = await adapter.submit({
    connection: { base_url: "https://api.example.test/v1" },
    credential: { api_key: "secret" },
    snapshot: { model: "provider-image-v9", prompt: "paint a fox", settings: { count: 1 } },
    attachments: [], onProgress() {},
  });
  assert.equal(seen[0].url, "https://api.example.test/v1/images/generations");
  assert.equal(seen[0].body.model, "provider-image-v9");
  assert.deepEqual(await adapter.estimateCost({ snapshot: { model: "provider-image-v9" } }), { status: "unknown" });
});
```

- [ ] **Step 2: Run the adapter test and verify RED.**

Run: `node --test test/openai-compatible-images.test.mjs`

Expected: FAIL on missing execution behavior.

- [ ] **Step 3: Implement a network-free unknown-cost estimate and standard synchronous image submission.** `estimateCost` must return unknown without a provider call. After the router authorizes that cost state, `submit` uses only trusted fields, passes the exact model ID, translates count to `n`, passes `size` only when already normalized, and emits a fixed `submitted` event before reading results.

```js
async function submit({ connection, credential, snapshot, onProgress }) {
  onProgress({ stage: "submitted", progress: 5 });
  const json = await postImages({
    url: joinApiPath(connection.base_url, "images/generations"),
    apiKey: credential.api_key,
    body: compact({ model: snapshot.model, prompt: snapshot.prompt, n: snapshot.settings?.count, size: snapshot.settings?.size }),
  });
  return { synchronous: true, result: json, known_free: false };
}
```

- [ ] **Step 4: Implement result import and unsupported operations.** Convert every `data` item in order; `poll` returns the synchronous result unchanged, `cancel` returns `{ cancelled: false, unsupported: true }`, and empty/malformed results throw `UPSTREAM_SCHEMA_UNRECOGNIZED`.

```js
async function importResults({ result }) {
  const artifacts = result.data.map((item, index) => normalizeImageArtifact(item, index));
  if (!artifacts.length) throw schemaError("The provider returned no images.");
  return { artifacts };
}
```

- [ ] **Step 5: Run the adapter tests and commit.**

Run: `node --test test/openai-compatible-images.test.mjs test/provider-url-security.test.mjs`

Expected: PASS with secrets absent from thrown errors.

```bash
git add src/providers/adapters/openai-compatible-images.js test/openai-compatible-images.test.mjs
git commit -m "feat: execute OpenAI-compatible image models"
```

### Task 5: Migrate connection persistence and implement the discovery lifecycle

**Files:**
- Modify: `src/providers/connection-store.js`
- Create: `src/providers/provider-connection-service.js`
- Modify: `test/connection-store.test.mjs`
- Create: `test/provider-connection-service.test.mjs`

**Interfaces:**
- Consumes: provider registry, adapter registry, discovery service, and existing credential service.
- Extends `createConnectionStore` with `createDraft`, `completeDiscovery`, `failDiscovery`, `replaceCatalog`, and `markCredentialsChanged` while retaining existing legacy methods.
- Produces: `createProviderConnectionService({ connectionStore, credentialService, discoveryService, adapterRegistry }) -> { createDraft, configureAndDiscover, rediscover, refreshModels, remove }`.
- Modern connection status is `draft | discovering | connected | failed | no_models | disabled`.
- Private helpers/constants and fixtures defined in this task: `API_KEY_FIELDS`, `migrateConnectionsV2`, `requireModernDraft`, `uniqueConnectionName`, `discoveryFixture`, and `catalogFixture`.

- [ ] **Step 1: Write failing migration and lifecycle tests.** Seed `provider-connections-v1` state with a `custom-rest` profile; assert migration creates a private backup, preserves mappings byte-for-byte in the migrated state, marks it `legacy: true`, and never exposes mappings from a modern connection. Test hostname fallback, duplicate suffixing, draft-disabled state, atomic discovery success, failed discovery, catalog-only revision changes, and config revision changes for address/key/adapter updates.

```js
test("catalog refresh does not invalidate the execution config", async () => {
  const draft = await store.createDraft({ name: "", base_url: "api.example.test/v1" });
  const connected = await store.completeDiscovery(draft.connection_id, discoveryFixture({ digest: "a" }));
  const refreshed = await store.replaceCatalog(draft.connection_id, catalogFixture({ digest: "b" }));
  assert.equal(refreshed.config_revision, connected.config_revision);
  assert.equal(refreshed.model_catalog_revision, connected.model_catalog_revision + 1);
});
```

- [ ] **Step 2: Run the store/service tests and verify RED.**

Run: `node --test test/connection-store.test.mjs test/provider-connection-service.test.mjs`

Expected: FAIL on missing schema migration and lifecycle methods.

- [ ] **Step 3: Add a locked `provider-connections-v2` migration in the existing state file.** Use `JsonStore.migrateState`; never create a second competing connection file. Preserve legacy `endpoint_mappings` and `settings` internally, add modern fields only to modern records, and keep the automatic backup produced by `JsonStore`.

```js
const store = new JsonStore({
  dataDirectory,
  stateFileName: CONNECTION_STATE_FILE,
  createInitialState: () => ({ schema_version: "provider-connections-v2", connections: [] }),
  migrateState: (state) => migrateConnectionsV2(state),
});
```

- [ ] **Step 4: Implement the connection lifecycle service.** Create the draft before opening the secure prompt; validate the candidate key by obtaining a recognized protocol response inside `credentialService.configure`; atomically mark a non-empty catalog `connected` and enabled; mark a recognized empty catalog `no_models` and disabled without treating the key as invalid; retain other failed drafts with safe codes; refresh with the stored key; delete the matching private credential when removing a modern draft/connection. On replacement of a previously stored key, increment `config_revision` only after the new key and discovery have succeeded.

```js
async function configureAndDiscover({ connection_id, onState }) {
  const draft = await requireModernDraft(connection_id);
  let recognized;
  await credentialService.configure({
    connection_id: draft.credential_ref,
    fields: API_KEY_FIELDS,
    onState,
    validate: async (credential) => {
      recognized = await discoveryService.discover({ base_url: draft.base_url, credential });
      return { accepted: true, code: recognized.catalog.models.length ? "CONNECTED" : "NO_MODELS" };
    },
  });
  return connectionStore.completeDiscovery(connection_id, recognized);
}
```

- [ ] **Step 5: Run store/service tests and commit.**

Run: `node --test test/connection-store.test.mjs test/provider-connection-service.test.mjs test/provider-credentials.test.mjs`

Expected: PASS; existing credential tests remain unchanged.

```bash
git add src/providers/connection-store.js src/providers/provider-connection-service.js test/connection-store.test.mjs test/provider-connection-service.test.mjs
git commit -m "feat: add automatic provider connection lifecycle"
```

### Task 6: Expose redacted discovery and model-catalog APIs

**Files:**
- Modify: `src/http/server.js`
- Modify: `src/index.js`
- Modify: `test/provider-http.test.mjs`
- Modify: `test/mcp-workbench.test.mjs`

**Interfaces:**
- Consumes: `providerConnectionService`, connection store, adapter registry, and existing workbench mutation validation.
- Produces: `POST /api/v1/connections` with `{ name?, base_url } -> { connection: draft }`.
- Produces: `POST /api/v1/connections/:id/credentials -> { connection, discovery }`.
- Produces: `POST /api/v1/connections/:id/discover -> { connection, discovery }`.
- Produces: `POST /api/v1/connections/:id/models/refresh -> { connection, catalog }`.
- `GET /api/v1/connections` returns safe connection metadata plus normalized model records, never mappings/settings/credential references.
- Private helpers and fixtures defined in this task: `redactCatalog`, the extended `redactProviderConnection`, `mutationHeaders`, and the injected HTTP service harness.

- [ ] **Step 1: Replace the HTTP fixture expectations with failing modern-flow tests.** Assert the create body rejects `provider_id`, capabilities, models, endpoint mappings, settings, and secret keys; the credential endpoint triggers discovery; public models preserve `name` and `id`; SSE emits fixed progress stages; legacy connections are marked but their mappings remain absent from responses.

```js
const created = await json(await fetch(`${server.url}/api/v1/connections`, {
  method: "POST", headers: mutationHeaders,
  body: JSON.stringify({ name: "Mix API", base_url: "api.example.test/v1" }),
}));
assert.equal(created.body.data.connection.enabled, false);
assert.equal(created.body.data.connection.name, "Mix API");
assert.equal(JSON.stringify(created.body).includes("endpoint_mappings"), false);
```

- [ ] **Step 2: Run HTTP/MCP tests and verify RED.**

Run: `node --test test/provider-http.test.mjs test/mcp-workbench.test.mjs`

Expected: FAIL because modern lifecycle endpoints and public catalog fields are absent.

- [ ] **Step 3: Wire services in `src/index.js`.** Construct the safe request, OpenAI adapter, adapter registry, discovery service, connection store, and connection lifecycle service once; inject them into HTTP, workbench, and provider execution services. Preserve all existing Lovart injections.

```js
const adapterRegistry = createAdapterRegistry({ adapters: [createOpenAiCompatibleImagesAdapter({ request: safeRequest })] });
const discoveryService = createProviderDiscoveryService({ adapterRegistry });
const providerConnectionService = createProviderConnectionService({ connectionStore, credentialService: providerCredentialService, discoveryService, adapterRegistry });
```

- [ ] **Step 4: Implement redacted routes and events.** Mutating endpoints must call `validateWorkbenchMutation`; errors must retain stable codes but use Chinese actionable messages. Publish only `{ connection_id, stage, status, code, model_count }`.

```js
const refreshMatch = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)\/models\/refresh$/u);
if (refreshMatch && request.method === "POST") {
  await validateWorkbenchMutation(request, url);
  const result = await providerConnectionService.refreshModels({ connection_id: decodeURIComponent(refreshMatch[1]) });
  return send(response, 200, envelope({ connection: redactProviderConnection(result.connection), catalog: redactCatalog(result.catalog) }));
}
```

- [ ] **Step 5: Update safe MCP metadata and run tests.** `imvia_list_provider_connections` returns connection-owned catalogs, status, protocol, and adapter metadata; it never returns endpoint mappings, settings, or credential references. Keep execution inputs unchanged.

Run: `node --test test/provider-http.test.mjs test/mcp-workbench.test.mjs test/provider-connection-service.test.mjs`

Expected: PASS.

```bash
git add src/http/server.js src/index.js test/provider-http.test.mjs test/mcp-workbench.test.mjs
git commit -m "feat: expose provider discovery and model catalogs"
```

### Task 7: Replace the JSON connection editor with the friendly workflow

**Files:**
- Modify: `workbench/dist/assets/imvia-provider-connections-v1.js`
- Modify: `workbench/dist/assets/imvia-provider-connections-v1.css`
- Modify: `workbench/dist/index.html`
- Modify: `test/workbench-provider-ui.test.mjs`

**Interfaces:**
- Consumes: modern connection HTTP operations and existing bridge headers.
- Produces: `buildConnectionFormPayload({ name, base_url }) -> { name?, base_url }`.
- Produces: `connectionErrorMessage(error) -> { message, action, field? }`.
- Produces: `connectionModelGroups(connection, mode) -> { confirmed, unconfirmed, unsupported }`.
- Dispatches `imvia:provider-connections-changed` after create/discovery/refresh/update.

- [ ] **Step 1: Rewrite UI tests first.** Assert the source contains `API 名称（可选）`, `API 地址`, `连接并识别`, progress stages, model counts, refresh/update/disable/delete actions, and `旧版连接`; assert it does not contain `服务商类型`, `生成能力`, `接口映射 JSON`, `高级设置 JSON`, endpoint/settings parsing, capability checkboxes, or browser-native prompts.

```js
test("modern connections expose only friendly fields", () => {
  assert.match(providerUiSource, /API 名称（可选）/u);
  assert.match(providerUiSource, /aria-label="API 地址"/u);
  assert.match(providerUiSource, /连接并识别/u);
  for (const forbidden of ["接口映射 JSON", "高级设置 JSON", "生成能力", "data-capability", "endpoint_mappings_text"]) {
    assert.equal(providerUiSource.includes(forbidden), false, forbidden);
  }
});
```

- [ ] **Step 2: Run the UI test and verify RED.**

Run: `node --test test/workbench-provider-ui.test.mjs`

Expected: FAIL on old JSON and capability controls.

- [ ] **Step 3: Implement the simplified editor and sequential progress.** Create a disabled draft, call the secure credential endpoint, render status updates, and reload connections after discovery. Leave the user on a retryable draft after cancellation/failure.

```js
export function buildConnectionFormPayload({ name, base_url } = {}) {
  const payload = { base_url: String(base_url ?? "").trim() };
  if (String(name ?? "").trim()) payload.name = String(name).trim();
  if (!payload.base_url) throw formError("请填写 API 地址。", "base_url");
  return payload;
}
```

- [ ] **Step 4: Implement connection cards, catalogs, and friendly errors.** Show name/domain, protocol/provider label, status, counts, last sync time, and all safe model names/IDs. Map format/auth/network/schema/rate-limit/no-model errors to the actions defined by the spec; never display `base_url` as an internal field name.

```js
const CONNECTION_ERRORS = Object.freeze({
  VALIDATION_FAILED: { message: "API 地址格式不正确，请填写完整地址，例如 https://api.example.com/v1。", action: "修改地址", field: "base_url" },
  AUTHENTICATION_FAILED: { message: "API Key 无效或没有读取模型的权限。", action: "更新密钥" },
  UPSTREAM_SCHEMA_UNRECOGNIZED: { message: "该 API 暂不支持自动识别。", action: "修改地址" },
  UPSTREAM_RATE_LIMITED: { message: "API 请求过于频繁，请稍后重试。", action: "稍后重试" },
});
```

- [ ] **Step 5: Update styles/cache query, run tests, and commit.** Preserve keyboard focus, `aria-live` progress, mobile layout, and the current custom provider selector styling.

Run: `node --test test/workbench-provider-ui.test.mjs test/workbench-provider-selection.test.mjs`

Expected: PASS, and static source assertions find no JSON editor.

```bash
git add workbench/dist/assets/imvia-provider-connections-v1.js workbench/dist/assets/imvia-provider-connections-v1.css workbench/dist/index.html test/workbench-provider-ui.test.mjs test/workbench-provider-selection.test.mjs
git commit -m "feat: simplify external API connection setup"
```

### Task 8: Drive model selection and immutable snapshots from connection catalogs

**Files:**
- Modify: `src/domain/model-capabilities.js`
- Modify: `src/domain/workbench-service.js`
- Modify: `workbench/dist/assets/imvia-provider-connections-v1.js`
- Modify: `workbench/dist/assets/imvia-model-auto-v1.js`
- Modify: `workbench/dist/assets/imvia-result-workspace.js`
- Modify: `test/workbench-model-auto.test.mjs`
- Modify: `test/workbench-provider-selection.test.mjs`
- Modify: `test/workbench-provider-ui.test.mjs`

**Interfaces:**
- Consumes: selected enabled connection, its normalized catalog, and `modelRecordDigest` from Task 2.
- Produces: `assertProviderModelCapability({ providerRegistry, connection, provider_id, model, mode }) -> normalized model record` for external connections and existing string result for Lovart.
- Modern task snapshot adds `model_catalog_revision`, `model_catalog_digest`, `adapter_id`, `adapter_version`, `selected_model`, and `selected_model_digest`.
- `filterConnectionModels({ connection, mode }) -> grouped model options`.
- Private helpers defined in this task: `freezeExternalModelSelection` and `serializeSelectedModel`.

- [ ] **Step 1: Add failing selection/snapshot tests.** Assert external choices contain raw API models and no `Auto`; Lovart still contains `Auto`; confirmed/unconfirmed options are selectable; unsupported models are visible only in the full catalog and disabled; snapshots contain all frozen adapter/catalog/model fields and no credentials.

```js
assert.deepEqual(
  filterConnectionModels({ connection, mode: "image" }).selectable.map((model) => model.id),
  ["provider-image", "unknown-model"],
);
assert.equal(filterConnectionModels({ connection, mode: "image" }).selectable.some((model) => model.id === "Auto"), false);
assert.deepEqual(submitted.job.snapshot.selected_model, connection.models[0]);
assert.match(submitted.job.snapshot.selected_model_digest, /^[a-f0-9]{64}$/u);
```

- [ ] **Step 2: Run selection tests and verify RED.**

Run: `node --test test/workbench-model-auto.test.mjs test/workbench-provider-selection.test.mjs test/workbench-provider-ui.test.mjs`

Expected: FAIL because static provider descriptors and unconditional external `Auto` remain authoritative.

- [ ] **Step 3: Move external model validation to the connection catalog.** `freezeProviderSelection` must load the connection first, validate enabled/connected state, select the exact normalized model record, and return its digest and adapter/catalog metadata. Lovart continues to use `MODEL_CAPABILITIES`.

```js
const selectedModel = assertProviderModelCapability({
  providerRegistry, connection, provider_id, model: snapshot.model, mode: snapshot.mode,
});
return {
  provider_id, connection_id, connection_config_revision: connection.config_revision,
  model_catalog_revision: connection.model_catalog_revision,
  model_catalog_digest: connection.model_catalog_digest,
  adapter_id: connection.adapter_id, adapter_version: connection.adapter_version,
  selected_model: selectedModel, selected_model_digest: modelRecordDigest(selectedModel),
};
```

- [ ] **Step 4: Update workbench model events and submission serialization.** Provider/connection changes dispatch the selected connection's catalog groups; external dropdowns use original display names/IDs and omit `Auto`; `readWorkbenchSubmission` submits only public model/provider/connection IDs, while the backend freezes trusted metadata.

```js
documentRoot.dispatchEvent(new CustomEvent("imvia:provider-selection-changed", {
  detail: { provider_id, connection_id, model, models: filterConnectionModels({ connection, mode }).selectable },
}));
```

- [ ] **Step 5: Run selection tests and commit.**

Run: `node --test test/workbench-model-auto.test.mjs test/workbench-provider-selection.test.mjs test/workbench-provider-ui.test.mjs test/workbench-service.test.mjs`

Expected: PASS; serialized public snapshots contain no credential-shaped fields.

```bash
git add src/domain/model-capabilities.js src/domain/workbench-service.js workbench/dist/assets/imvia-provider-connections-v1.js workbench/dist/assets/imvia-model-auto-v1.js workbench/dist/assets/imvia-result-workspace.js test/workbench-model-auto.test.mjs test/workbench-provider-selection.test.mjs test/workbench-provider-ui.test.mjs test/workbench-service.test.mjs
git commit -m "feat: freeze discovered external models in workbench jobs"
```

### Task 9: Route modern adapters exactly and preserve legacy generic REST

**Files:**
- Modify: `src/providers/provider-execution-router.js`
- Modify: `src/domain/workbench-service.js`
- Modify: `src/index.js`
- Modify: `test/provider-execution-router.test.mjs`
- Modify: `test/provider-e2e.test.mjs`
- Modify: `test/connection-store.test.mjs`
- Modify: `test/workbench-service.test.mjs`

**Interfaces:**
- Consumes: `adapterRegistry.get(adapter_id, adapter_version)`, connection store, legacy generic connector factory, frozen task snapshot.
- Produces: unchanged public router methods `executePrepared`, `get`, and `confirm`.
- Modern connections route through the exact trusted adapter version; legacy `custom-rest` routes through the existing generic REST factory.
- Produces: `workbenchService.awaitProviderCostDecision(...)` and `workbenchService.authorizeProviderCostAndResume(...)` so an unknown cost is explicitly accepted before transport.
- Private helpers and fixtures defined in this task: `resolveModernExecutor`, `assertFrozenModel`, `assertModernCostAuthorization`, `modernRouter`, `failingAdapter`, and `frozenExternalJob`.

- [ ] **Step 1: Add failing exact-routing tests.** Cover modern OpenAI success, legacy generic success, catalog refresh after submission, config/key revision change after submission, adapter version mismatch, unsupported mode, upstream auth/model/network failure, and Lovart invocation count fixed at zero for every external case. For unknown cost, assert the job enters `awaiting_cost_confirmation` with zero provider calls; after the exact accepted decision, assert one submit occurs and the authorization cannot be replayed for another attempt.

```js
test("does not call Lovart after a modern adapter failure", async () => {
  let lovartCalls = 0;
  const router = modernRouter({
    adapter: failingAdapter("AUTHENTICATION_FAILED"),
    lovartOrchestrator: { executePrepared: async () => { lovartCalls += 1; } },
  });
  await assert.rejects(router.executePrepared(frozenExternalJob), (error) => error.code === "AUTHENTICATION_FAILED");
  assert.equal(lovartCalls, 0);
});

test("confirms unknown cost before the first provider write", async () => {
  const harness = modernRouter({ estimatedCost: { status: "unknown" } });
  const waiting = await harness.router.executePrepared(frozenExternalJob);
  assert.equal(waiting.job.status, "awaiting_cost_confirmation");
  assert.equal(harness.adapterSubmitCalls(), 0);
  await harness.acceptCurrentCostDecision(waiting.job);
  const completed = await harness.confirmAndResume(waiting.job);
  assert.equal(completed.job.status, "succeeded");
  assert.equal(harness.adapterSubmitCalls(), 1);
});
```

- [ ] **Step 2: Run router/E2E tests and verify RED.**

Run: `node --test test/provider-execution-router.test.mjs test/provider-e2e.test.mjs`

Expected: FAIL because the router resolves only static provider descriptors/generic connectors.

- [ ] **Step 3: Implement the modern resolution and pre-submit cost branch.** Extend `frozenProvider` to read all frozen adapter/catalog/model fields. Validate exact `config_revision` and adapter ID/version; validate `selected_model_digest`; allow a newer current catalog revision; then resolve the frozen adapter. Before `submit`, call the adapter's network-free/read-only `estimateCost`. If the estimate is unknown or non-zero and the current attempt has no matching authorization, move to `awaiting_cost_confirmation` without calling `submit`. `confirm` records the exact accepted fingerprint and decision, returns the job to its pre-submit state, then resumes once. After submission, record any provider-reported cost for audit but never perform a post-charge confirmation loop. Never catch an external error and invoke the Lovart branch.

```js
if (connection.legacy === true) {
  executor = genericConnectorFactory({ descriptor, connection: clone(connection) });
} else {
  if (connection.config_revision !== frozen.connection_config_revision) connectionChanged();
  if (connection.adapter_id !== frozen.adapter_id || connection.adapter_version !== frozen.adapter_version) adapterChanged();
  if (modelRecordDigest(frozen.selected_model) !== frozen.selected_model_digest) invalidSnapshot();
  executor = adapterRegistry.get(frozen.adapter_id, frozen.adapter_version);
}
```

```js
const estimate = await executor.estimateCost(request);
if (!assertModernCostAuthorization(current, estimate)) {
  return workbenchService.awaitProviderCostDecision({
    job_id: current.id,
    attempt: current.attempt,
    estimate,
    resume_status: "uploading",
  });
}
const submitted = await executor.submit(request);
```

- [ ] **Step 4: Extend the E2E fixture through HTTP → bridge → MCP → adapter.** Create a modern connection through the lifecycle fixture, return two provider model names, submit one raw model ID, execute once, import all results, repeat idempotently, and scan HTTP/SSE/MCP/state serialization for the secret and credential-shaped keys.

```js
for (const forbidden of [SECRET, "api_key", "credential_ref", "authorization", "secret_key"]) {
  assert.equal(serializedPublicSurfaces.includes(forbidden), false, forbidden);
}
assert.equal(lovartCalls, 0);
assert.equal(adapterSubmitCalls, 1);
```

- [ ] **Step 5: Run router/E2E/store tests and commit.**

Run: `node --test test/provider-execution-router.test.mjs test/provider-e2e.test.mjs test/connection-store.test.mjs test/workbench-service.test.mjs`

Expected: PASS for modern and legacy paths, with zero Lovart calls for all external fixtures.

```bash
git add src/providers/provider-execution-router.js src/domain/workbench-service.js src/index.js test/provider-execution-router.test.mjs test/provider-e2e.test.mjs test/connection-store.test.mjs test/workbench-service.test.mjs
git commit -m "feat: route discovered providers without Lovart fallback"
```

### Task 10: Lock the user contract, regression gates, and release installation

**Files:**
- Modify: `skills/imvia-studio/SKILL.md`
- Modify: `test/skill-contract.test.mjs`
- Modify: `package.json` to include `test/model-catalog.test.mjs` and `test/openai-compatible-images.test.mjs` in the focused provider gate
- Create: `docs/verification/2026-08-25-imvia-friendly-api-auto-discovery.md`
- Modify: `.codex-plugin/plugin.json` through the cachebuster helper only

**Interfaces:**
- Consumes: all Tasks 1–9 and repository `AGENTS.md` release requirements.
- Produces: a reproducible verification record and a cache-busted installed `imvia-studio@personal` package.

- [ ] **Step 1: Add failing skill/source contract assertions.** Require the skill to say that modern external connections are configured with name/address/key only, the external model ID comes from the discovered catalog, `imvia_execute_workbench_submission` executes the frozen provider adapter, and external failure must never invoke Lovart.

```js
test("skill preserves the friendly external provider boundary", async () => {
  const text = await readFile(skillUrl, "utf8");
  for (const phrase of [
    "API address and API Key",
    "discovered model catalog",
    "frozen provider adapter",
    "Never call or fall back to Lovart for an external provider job",
  ]) assert.ok(text.includes(phrase), phrase);
});
```

- [ ] **Step 2: Run the skill test, update the skill minimally, and re-run.**

Run before edit: `node --test test/skill-contract.test.mjs`

Expected before edit: FAIL on the new phrases.

Run after edit: `node --test test/skill-contract.test.mjs`

Expected after edit: PASS without changing the independent Lovart plugin.

- [ ] **Step 3: Extend and run focused verification.** Set `test:providers` to the existing provider glob/UI/E2E command plus `test/model-catalog.test.mjs test/openai-compatible-images.test.mjs`. Use the configured bundled Node path if `pnpm` cannot resolve `node`; local-loopback HTTP/E2E tests may require the existing scoped test permission.

```json
{
  "test:providers": "node --test test/provider-*.test.mjs test/model-catalog.test.mjs test/openai-compatible-images.test.mjs test/workbench-provider-selection.test.mjs test/workbench-provider-ui.test.mjs test/provider-e2e.test.mjs"
}
```

```bash
pnpm test:providers
node --test test/provider-url-security.test.mjs test/model-catalog.test.mjs test/provider-discovery.test.mjs test/openai-compatible-images.test.mjs test/provider-connection-service.test.mjs test/skill-contract.test.mjs
cargo test --manifest-path native/credential-helper/Cargo.toml
git diff --check
```

Expected: all feature/provider/skill/native tests pass; no real provider, credential store, or Lovart network call occurs.

- [ ] **Step 4: Run the full repository and protected-path gates.** Do not repair unrelated pre-existing failures or touch the Lovart repository; record them precisely if they remain.

```bash
pnpm test
pnpm test:protection
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py '/Users/a1234/Documents/ChatGPT/imvia stuio'
```

Expected: feature tests and plugin validation pass. Any known unrelated baseline failure is documented with its exact test name and evidence.

- [ ] **Step 5: Write the verification record.** Record exact commands, test counts, commit SHA, platform limitations, redaction/no-Lovart evidence, migration evidence, plugin validator output, and any unrelated pre-existing failures. Never record an API Key, authorization header, or raw helper stderr.

```markdown
## Required evidence

- Friendly form contains no JSON controls.
- OpenAI-compatible discovery used GET-only model requests.
- Raw model name/ID survived HTTP, selection, snapshot, and adapter submission.
- Catalog refresh preserved an existing task; config revision changes rejected it.
- Every external failure fixture observed zero Lovart calls.
- Legacy `custom-rest` fixture survived migration and execution.
```

- [ ] **Step 6: Commit feature verification files before changing the cachebuster.** Include only the task files and verification record; preserve unrelated dirty changes.

```bash
git add skills/imvia-studio/SKILL.md test/skill-contract.test.mjs package.json docs/verification/2026-08-25-imvia-friendly-api-auto-discovery.md
git commit -m "test: verify friendly provider discovery"
```

- [ ] **Step 7: Refresh, validate, and reinstall the personal plugin.** Read the marketplace name first, use the default UTC cachebuster, validate again, and reinstall from the returned personal marketplace name.

```bash
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py '/Users/a1234/Documents/ChatGPT/imvia stuio'
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py '/Users/a1234/Documents/ChatGPT/imvia stuio'
codex plugin add imvia-studio@personal
```

Expected: the manifest contains exactly one `+codex.<UTC-cachebuster>` suffix and installation succeeds.

- [ ] **Step 8: Verify installed cache contents and commit only the cachebuster.** Read the manifest version, locate `/Users/a1234/.codex/plugins/cache/personal/imvia-studio/<version>`, and compare the manifest, skill, changed backend modules, and changed workbench assets against the workspace. If `.codex-plugin/plugin.json` contained an unrelated baseline change before execution, do not commit that unrelated hunk; report the staging boundary.

```bash
IMVIA_INSTALLED_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('.codex-plugin/plugin.json','utf8')).version")"
IMVIA_INSTALLED_ROOT="/Users/a1234/.codex/plugins/cache/personal/imvia-studio/${IMVIA_INSTALLED_VERSION}"
test -d "$IMVIA_INSTALLED_ROOT"
diff -q .codex-plugin/plugin.json "$IMVIA_INSTALLED_ROOT/.codex-plugin/plugin.json"
diff -q skills/imvia-studio/SKILL.md "$IMVIA_INSTALLED_ROOT/skills/imvia-studio/SKILL.md"
diff -q src/providers/provider-discovery.js "$IMVIA_INSTALLED_ROOT/src/providers/provider-discovery.js"
diff -q src/providers/model-catalog.js "$IMVIA_INSTALLED_ROOT/src/providers/model-catalog.js"
diff -q workbench/dist/assets/imvia-provider-connections-v1.js "$IMVIA_INSTALLED_ROOT/workbench/dist/assets/imvia-provider-connections-v1.js"
```

```bash
git add .codex-plugin/plugin.json
git commit -m "chore: refresh IMVIA Studio plugin cachebuster"
```

Expected: every compared workspace/cache pair matches. Do not use the current task's pre-reinstall MCP process as proof of the installed package.

- [ ] **Step 9: Hand off the safe reload boundary.** Tell the user the exact installed version and ask them to start a new Codex task. In the new task, open the workbench and verify the simplified API screen and callable MCP surface; do not claim that this current task loaded the new process.

## Plan Self-Review

- Spec coverage: friendly input, URL safety, read-only discovery, raw model names, complete catalog visibility, adapter-gated execution, refresh/version semantics, redaction, Chinese errors, legacy migration, external/Lovart isolation, testing, cachebusting, validation, reinstall, installed-cache verification, and new-task proof each map to a task above.
- Placeholder scan: the plan contains no unresolved placeholder tokens, vague error-handling steps, or undefined follow-up task.
- Type consistency: catalog digests originate in Task 2; adapter identity originates in Task 3; connection catalog revisions are persisted in Task 5; `selected_model` and `selected_model_digest` are frozen in Task 8; Task 9 consumes those exact field names unchanged.
- Isolation: modern `external-api` uses the trusted adapter registry; legacy `custom-rest` remains on the generic connector; Lovart remains on its dedicated orchestrator.
- Scope: all tasks form one end-to-end feature and each ends with an independently testable, reviewable deliverable.
