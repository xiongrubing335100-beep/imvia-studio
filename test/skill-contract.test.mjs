import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../skills/imvia-studio/SKILL.md", import.meta.url);

test("skill fixes the fixture-only orchestration and cost-confirmation order", async () => {
  const text = await readFile(skillUrl, "utf8");
  for (const phrase of [
    "Milestone 5 fixture-only gate",
    "imvia_list_pending_jobs",
    "imvia_record_cost_decision",
    "imvia_claim_cost_decision",
    "imvia_update_account_status",
    "imvia_import_result",
    "imvia_create_iteration",
    "Never call an installed or real Lovart MCP tool in Milestone 5",
    "Do not treat queued_for_agent as cost approval",
    "mock `lovart_confirm` count must remain zero",
  ]) assert.match(text, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(text.indexOf("imvia_record_cost_decision") < text.indexOf("imvia_claim_cost_decision"));
  assert.ok(text.indexOf("imvia_claim_cost_decision") < text.indexOf("then mock `lovart_confirm` exactly once"));
});

test("skill fixes the Milestone 6 read-only probe authorization boundary", async () => {
  const text = await readFile(skillUrl, "utf8");
  for (const phrase of [
    "Milestone 6 read-only Lovart probe",
    "The user must explicitly request the read-only probe in the current conversation.",
    "General permission, a queued job, earlier approval, or a fixture decision is insufficient.",
    "Call `imvia_authorize_lovart_probe` before `imvia_probe_lovart_capabilities`.",
    "Feature disabled, unsupported platform, invalid, expired, or consumed authorization, or a missing credential reference must produce zero Lovart requests.",
    "An idempotent completed replay must perform zero Keychain reads and zero Lovart requests.",
    "The probe is advisory and must not alter job, draft, artifact, cost, iteration, or execution behavior.",
    "Never upload, generate, confirm, query projects, threads, status, results, or balance; never expose AK/SK; and never call the existing Lovart plugin.",
    "Codex must never run `pnpm run configure:lovart-readonly`, `pnpm run enable:lovart-readonly-probe`, or `pnpm run disable:lovart-readonly-probe` for the user.",
    "If the probe is disabled, stop and ask the user to run the required setup or enable command themselves.",
    "One explicit request in the current conversation permits exactly one fresh authorization and one probe attempt.",
    "After any failure or consumed authorization, never change an idempotency key, re-authorize, or retry; stop and await a new explicit request in the current conversation.",
  ]) assert.ok(text.includes(phrase), `missing exact phrase: ${phrase}`);

  const milestone6 = text.indexOf("## Milestone 6 read-only Lovart probe");
  assert.ok(text.indexOf("## Stop conditions") < milestone6);
  assert.ok(text.indexOf("imvia_authorize_lovart_probe", milestone6) < text.indexOf("imvia_probe_lovart_capabilities", milestone6));
});

test("skill hands a workbench button summary to Codex before any Lovart execution", async () => {
  const text = await readFile(skillUrl, "utf8");
  const normalized = text.replace(/\s+/gu, " ");
  for (const phrase of [
    "submission_cursor",
    "imvia_wait_for_workbench_submission",
    "read and summarize its immutable `snapshot` as the user's message to Codex",
    "imvia_execute_workbench_submission",
    "The workbench button only hands the summarized form to Codex. It never calls Lovart directly.",
    "Never create a second job with `imvia_generate` for the same workbench submission.",
  ]) assert.ok(normalized.includes(phrase), `missing workbench handoff contract: ${phrase}`);
  assert.ok(text.indexOf("imvia_wait_for_workbench_submission") < text.indexOf("imvia_execute_workbench_submission"));
});

test("workbench browser actions only remember project context and queue Codex handoffs", async () => {
  const source = await readFile(new URL("../workbench/dist/assets/imvia-result-workspace.js", import.meta.url), "utf8");
  assert.ok(source.includes("/api/v1/lovart/projects/remember"));
  assert.ok(source.includes("/api/v1/workbench/submissions"));
  assert.ok(source.includes("任务摘要已发送给 Codex，等待 Codex 处理"));
  assert.equal(source.includes("/api/v1/generations"), false);
  assert.equal(source.includes("submitLiveGeneration"), false);
});

test("orchestration code has no real Lovart transport or credential fallback", async () => {
  const urls = [
    new URL("../src/orchestration/policy.js", import.meta.url),
    new URL("./support/fake-lovart-adapter.mjs", import.meta.url),
    new URL("./support/mock-agent-runner.mjs", import.meta.url),
  ];
  for (const url of urls) {
    const source = await readFile(url, "utf8");
    for (const forbidden of ["fetch(", "node:http", "node:https", "StdioClientTransport", "LOVART_AK", "LOVART_SK", "http://", "https://"]) {
      assert.equal(source.includes(forbidden), false, `${url.pathname} contains ${forbidden}`);
    }
  }
});
