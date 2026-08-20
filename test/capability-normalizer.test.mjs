import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLovartCapabilities } from "../src/probe/capability-normalizer.js";

const CHECKED_AT_MS = Date.parse("2026-08-20T00:00:00.000Z");

const officialModels = [
  { id: "generate_video_seedance_v2_5", name: "Seedance 2.5", mode: "video" },
  { id: "generate_video_seedance_v2_0_fast", name: "Seedance 2.0 Fast", mode: "video" },
  { id: "generate_video_minimax_h3", name: "Minimax H3", mode: "video" },
  { id: "generate_video_kling_v3", name: "Kling 3.0", mode: "video" },
  { id: "generate_video_kling_v3_omni", name: "Kling 3.0 Omni", mode: "video" },
  { id: "generate_image_seedream_v4", name: "Seedream 4.0", mode: "image" },
  { id: "generate_image_nano_banana_pro", name: "Nano Banana Pro", mode: "image" },
  { id: "generate_image_nano_banana_2", name: "Nano Banana 2", mode: "image" },
  { id: "generate_image_seedream_v5", name: "Seedream 5.0 Lite", mode: "image" },
  { id: "generate_image_midjourney", name: "Midjourney", mode: "image" },
];

const unmappedModels = [
  "Seedance 2.0 VIP",
  "Seedream 3.0",
  "Seedream 3.0 Fast",
  "Image 2",
  "Seedream 5.0",
];

function assertUnknownSummary(summary) {
  assert.equal(summary.reachable, true);
  assert.equal(summary.authenticated, true);
  assert.equal(summary.capability_status, "unknown");
  assert.ok(summary.workbench_models.every(({ availability }) => availability === "unknown"));
}

test("normalizer maps every official ID to its local model and keeps unmapped models unknown", () => {
  const summary = normalizeLovartCapabilities({
    unlimited: true,
    available_models: {
      IMAGE: [...officialModels.filter(({ mode }) => mode === "image").map(({ id }) => id), "unknown_upstream_model"],
      VIDEO: officialModels.filter(({ mode }) => mode === "video").map(({ id }) => id),
    },
    detail: { account: "must disappear" },
  }, { checkedAtMs: CHECKED_AT_MS });

  assert.equal(summary.capability_status, "available");
  for (const expected of officialModels) {
    assert.deepEqual(summary.workbench_models.find(({ name }) => name === expected.name), {
      name: expected.name,
      mode: expected.mode,
      availability: "available",
    });
  }
  for (const name of unmappedModels) {
    assert.equal(summary.workbench_models.find((model) => model.name === name).availability, "unknown");
  }
  assert.deepEqual({
    reachable: summary.reachable,
    authenticated: summary.authenticated,
    service_version: summary.service_version,
    checked_at: summary.checked_at,
    expires_at: summary.expires_at,
    policy_version: summary.policy_version,
  }, {
    reachable: true,
    authenticated: true,
    service_version: null,
    checked_at: "2026-08-20T00:00:00.000Z",
    expires_at: "2026-08-20T00:05:00.000Z",
    policy_version: "lovart-readonly-probe-v1",
  });
  assert.equal(JSON.stringify(summary).includes("unlimited"), false);
  assert.equal(JSON.stringify(summary).includes("account"), false);
  assert.equal(JSON.stringify(summary).includes("unknown_upstream_model"), false);
});

test("valid connectivity with an unrecognized model-list shape is unknown", () => {
  const summary = normalizeLovartCapabilities({
    unlimited: false,
    models: ["generate_video_seedance_v2_5"],
  }, { checkedAtMs: CHECKED_AT_MS });

  assertUnknownSummary(summary);
});

test("malformed IMAGE or VIDEO lists fail closed without fallback scanning", () => {
  const malformedLists = [
    { IMAGE: "generate_image_nano_banana_pro", VIDEO: ["generate_video_seedance_v2_5"] },
    { IMAGE: ["generate_image_nano_banana_pro", 1], VIDEO: ["generate_video_seedance_v2_5"] },
    { IMAGE: ["generate_image_nano_banana_pro"], VIDEO: "generate_video_seedance_v2_5" },
    { IMAGE: ["generate_image_nano_banana_pro"], VIDEO: ["generate_video_seedance_v2_5", 1] },
  ];

  for (const available_models of malformedLists) {
    assertUnknownSummary(normalizeLovartCapabilities({
      unlimited: false,
      available_models,
      models: ["generate_image_nano_banana_pro", "generate_video_seedance_v2_5"],
    }, { checkedAtMs: CHECKED_AT_MS }));
  }
});

test("invalid root envelope fails closed", () => {
  assert.throws(() => normalizeLovartCapabilities([]), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
  assert.throws(() => normalizeLovartCapabilities({ unlimited: "yes" }), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
});
