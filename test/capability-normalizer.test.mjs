import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLovartCapabilities } from "../src/probe/capability-normalizer.js";

const CHECKED_AT_MS = Date.parse("2026-08-20T00:00:00.000Z");

test("normalizer emits every local model with conservative mapped availability", () => {
  const summary = normalizeLovartCapabilities({
    unlimited: true,
    available_models: {
      IMAGE: ["generate_image_nano_banana_pro", "unknown_upstream_model"],
      VIDEO: ["generate_video_seedance_v2_5"],
    },
    detail: { account: "must disappear" },
  }, { checkedAtMs: CHECKED_AT_MS });

  assert.equal(summary.capability_status, "available");
  assert.deepEqual(summary.workbench_models, [
    { name: "Seedance 2.5", mode: "video", availability: "available" },
    { name: "Seedance 2.0 VIP", mode: "video", availability: "unknown" },
    { name: "Seedance 2.0 Fast", mode: "video", availability: "unavailable" },
    { name: "Minimax H3", mode: "video", availability: "unavailable" },
    { name: "Kling 3.0", mode: "video", availability: "unavailable" },
    { name: "Kling 3.0 Omni", mode: "video", availability: "unavailable" },
    { name: "Seedream 4.0", mode: "image", availability: "unavailable" },
    { name: "Seedream 3.0", mode: "image", availability: "unknown" },
    { name: "Seedream 3.0 Fast", mode: "image", availability: "unknown" },
    { name: "Image 2", mode: "image", availability: "unknown" },
    { name: "Nano Banana Pro", mode: "image", availability: "available" },
    { name: "Nano Banana 2", mode: "image", availability: "unavailable" },
    { name: "Seedream 5.0", mode: "image", availability: "unknown" },
    { name: "Seedream 5.0 Lite", mode: "image", availability: "unavailable" },
    { name: "Midjourney", mode: "image", availability: "unavailable" },
  ]);
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

  assert.equal(summary.reachable, true);
  assert.equal(summary.authenticated, true);
  assert.equal(summary.capability_status, "unknown");
  assert.ok(summary.workbench_models.every(({ availability }) => availability === "unknown"));
});

test("invalid root envelope fails closed", () => {
  assert.throws(() => normalizeLovartCapabilities([]), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
  assert.throws(() => normalizeLovartCapabilities({ unlimited: "yes" }), (error) => error.code === "UPSTREAM_SCHEMA_UNRECOGNIZED");
});
