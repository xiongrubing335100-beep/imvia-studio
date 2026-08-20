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
