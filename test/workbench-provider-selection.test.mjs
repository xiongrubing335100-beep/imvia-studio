import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { createConnectionStore } from "../src/providers/connection-store.js";
import { normalizeModelCatalog } from "../src/providers/model-catalog.js";
import { createProviderRegistry } from "../src/providers/provider-registry.js";

const adapter = Object.fromEntries(["validateConnection", "submit", "poll", "cancel", "importResults"].map((name) => [name, async () => ({})]));
const genericDescriptor = {
  id: "external-api",
  display_name: "Fixture API",
  kind: "discovered",
  capabilities: ["image", "video"],
  models: [],
  credential_fields: [{ id: "api_key", label: "API Key", secret: true, required: true }],
};

async function fixture(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-provider-selection-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const registry = createProviderRegistry({ builtIns: [genericDescriptor], adapters: [{ id: "fixture-adapter", adapter }] });
  const connectionStore = createConnectionStore({ dataDirectory, registry });
  const draft = await connectionStore.createDraft({
    name: "Fixture connection",
    base_url: "https://fixture.example.test",
  });
  const catalog = normalizeModelCatalog({
    entries: [{ id: "fixture-image", name: "Fixture image" }, { id: "unknown-image", name: "Unknown image" }, { id: "fixture-video", name: "Fixture video" }],
    classify: ({ id }) => id === "fixture-image"
      ? { capabilities: ["image"], compatibility: "confirmed" }
      : id === "unknown-image"
        ? { capabilities: ["image"], compatibility: "unconfirmed" }
        : { capabilities: ["video"], compatibility: "confirmed" },
    now: () => "2026-08-25T00:00:00.000Z",
  });
  const connection = await connectionStore.completeDiscovery(draft.connection_id, {
    protocol: "fixture", adapter_id: "fixture-adapter", adapter_version: "1.0.0", provider_label: "Fixture API",
    models_endpoint: "https://fixture.example.test/v1/models", catalog,
  });
  return { dataDirectory, registry, connectionStore, connection, service: createWorkbenchService({ dataDirectory, providerRegistry: registry, connectionStore }) };
}

test("freezes the selected provider connection and its configuration revision into a workbench snapshot", async (context) => {
  const { connection, service } = await fixture(context);
  const submitted = await service.createWorkbenchSubmission({
    snapshot: {
      provider_id: "external-api",
      connection_id: connection.connection_id,
      mode: "image",
      model: "fixture-image",
      prompt: { text: "A provider-specific image", tokens: [] },
      attachments: [],
      settings: {},
    },
    idempotency_key: "provider-freeze-1",
  });
  assert.equal(submitted.job.snapshot.provider_id, "external-api");
  assert.equal(submitted.job.snapshot.connection_id, connection.connection_id);
  assert.equal(submitted.job.snapshot.connection_config_revision, connection.config_revision);
  assert.equal(submitted.job.snapshot.provider_label, "Fixture API");
  assert.deepEqual(submitted.job.snapshot.selected_model, connection.model_catalog.models[0]);
  assert.match(submitted.job.snapshot.selected_model_digest, /^[a-f0-9]{64}$/u);
  assert.equal(submitted.job.snapshot.model_catalog_revision, connection.model_catalog_revision);
  assert.equal(submitted.job.snapshot.model_catalog_digest, connection.model_catalog_digest);
  assert.equal(submitted.job.snapshot.adapter_id, "fixture-adapter");
  assert.equal(submitted.job.snapshot.adapter_version, "1.0.0");
  assert.equal(submitted.job.provider_id, "external-api");
  assert.equal(submitted.job.connection_id, connection.connection_id);
});

test("migrates legacy queued workbench jobs to the isolated Lovart provider", async (context) => {
  const { dataDirectory, service } = await fixture(context);
  const queued = await service.createWorkbenchSubmission({
    snapshot: { mode: "image", prompt: { text: "Legacy provider job", tokens: [] }, attachments: [], settings: {} },
    idempotency_key: "provider-legacy-1",
  });
  const statePath = path.join(dataDirectory, "state.json");
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  const job = stored.jobs.find((item) => item.id === queued.job.id);
  delete job.provider_id;
  delete job.connection_id;
  delete job.snapshot.provider_id;
  delete job.snapshot.connection_id;
  delete job.snapshot.connection_config_revision;
  await writeFile(statePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

  const migrated = await createWorkbenchService({ dataDirectory }).getState({ include: ["jobs"] });
  assert.equal(migrated.jobs[0].provider_id, "lovart");
  assert.equal(migrated.jobs[0].snapshot.provider_id, "lovart");
  assert.equal(migrated.jobs[0].snapshot.connection_id, null);
});

test("rejects provider mode and model combinations that the selected provider does not support", async (context) => {
  const { connection, service } = await fixture(context);
  await assert.rejects(
    service.createWorkbenchSubmission({
      snapshot: { provider_id: "external-api", connection_id: connection.connection_id, mode: "video", model: "fixture-image", prompt: { text: "Wrong mode", tokens: [] }, attachments: [], settings: {} },
      idempotency_key: "provider-mode-reject-1",
    }),
    (error) => error.code === "VALIDATION_FAILED",
  );
});

test("freezes an external provider connection into draft preparation jobs as executable workbench metadata", async (context) => {
  const { connection, service } = await fixture(context);
  const initial = await service.getState();
  await service.patchWorkbench({
    draft_id: initial.draft.id,
    base_revision: initial.draft.revision,
    actor: "user",
    reason: "Select external provider",
    patch: {
      provider_id: "external-api",
      connection_id: connection.connection_id,
      mode: "image",
      model: "fixture-image",
      "prompt.text": "Prepared external provider job",
    },
  });
  const prepared = await service.prepareGeneration({ draft_id: initial.draft.id, expected_revision: 1, idempotency_key: "prepared-provider-1" });
  assert.equal(prepared.job.submission_kind, "workbench_generation");
  assert.equal(prepared.job.activation.source, "workbench_action");
  assert.equal(prepared.job.snapshot.provider_id, "external-api");
  assert.equal(prepared.job.snapshot.connection_id, connection.connection_id);
  assert.equal(prepared.job.snapshot.connection_config_revision, connection.config_revision);
  assert.equal(prepared.job.snapshot.provider_label, "Fixture API");
});

test("strips secret-like snapshot fields before local persistence", async (context) => {
  const { connection, service } = await fixture(context);
  const submitted = await service.createWorkbenchSubmission({
    snapshot: {
      provider_id: "external-api",
      connection_id: connection.connection_id,
      mode: "image",
      model: "fixture-image",
      prompt: { text: "Redacted snapshot", tokens: [] },
      settings: { api_key: "must-not-persist", nested: { authorization: "must-not-persist" } },
      attachments: [],
    },
    idempotency_key: "sanitized-provider-snapshot",
  });
  const serialized = JSON.stringify(submitted.job);
  assert.equal(serialized.includes("must-not-persist"), false);
  assert.equal(Object.hasOwn(submitted.job.snapshot.settings, "api_key"), false);
});

test("rejects an external catalog record literally named Auto before it can be frozen into a job", async (context) => {
  const { connection, connectionStore, service } = await fixture(context);
  const autoCatalog = normalizeModelCatalog({
    entries: [{ id: "Auto", name: "Provider Auto" }],
    classify: () => ({ capabilities: ["image"], compatibility: "confirmed" }),
    now: () => "2026-08-25T00:00:00.000Z",
  });
  const refreshed = await connectionStore.replaceCatalog(connection.connection_id, autoCatalog);
  await assert.rejects(
    service.createWorkbenchSubmission({
      snapshot: { provider_id: "external-api", connection_id: refreshed.connection_id, mode: "image", model: "Auto", prompt: { text: "Do not submit provider Auto", tokens: [] }, attachments: [], settings: {} },
      idempotency_key: "external-auto-reject-1",
    }),
    (error) => error.code === "MODEL_CAPABILITY_UNKNOWN",
  );
});
