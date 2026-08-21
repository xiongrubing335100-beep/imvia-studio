import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/index.js";

async function connect(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-lovart-"));
  const credentialService = {
    async status() { return { status: "connected", checked_at: "2026-08-21T00:00:00.000Z" }; },
  };
  const generationService = {
    async connect() { return { status: "connected", checked_at: "2026-08-21T00:00:00.000Z", lovart: { reachable: true } }; },
    async generate(input) { return { final_status: "done", thread_id: "thread-1", project_id: input.project_id || null, items: [] }; },
    async confirm(input) { return { final_status: "done", thread_id: input.thread_id, items: [] }; },
  };
  const server = createServer({ service: {}, probeService: { async authorize() {}, async probe() {} }, credentialService, generationService, dataDirectory });
  const client = new Client({ name: "imvia-lovart-contract-test", version: "0.3.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return client;
}

test("MCP exposes the four no-terminal Lovart workbench tools", async (context) => {
  const client = await connect(context);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["imvia_connect_lovart", "imvia_lovart_status", "imvia_generate", "imvia_confirm_generation"]) {
    assert.ok(names.includes(name), name);
  }
});

test("connection and status return redacted status envelopes", async (context) => {
  const client = await connect(context);
  const connected = await client.callTool({ name: "imvia_connect_lovart", arguments: {} });
  assert.deepEqual(connected.structuredContent, {
    api_version: "1",
    ok: true,
    data: { status: "connected", checked_at: "2026-08-21T00:00:00.000Z", lovart: { reachable: true } },
  });
  const status = await client.callTool({ name: "imvia_lovart_status", arguments: {} });
  assert.deepEqual(status.structuredContent.data, { status: "connected", checked_at: "2026-08-21T00:00:00.000Z" });
});

test("generation and confirmation use strict inputs and preserve explicit confirmation", async (context) => {
  const client = await connect(context);
  const generated = await client.callTool({ name: "imvia_generate", arguments: { prompt: "A red apple", project_id: "project-1" } });
  assert.equal(generated.structuredContent.data.final_status, "done");
  assert.equal(generated.structuredContent.data.thread_id, "thread-1");

  const confirmed = await client.callTool({ name: "imvia_confirm_generation", arguments: { thread_id: "thread-cost" } });
  assert.equal(confirmed.structuredContent.data.final_status, "done");
  assert.equal(confirmed.structuredContent.data.thread_id, "thread-cost");

  const rejected = await client.callTool({ name: "imvia_generate", arguments: { prompt: "A red apple", access_key: "ak_private" } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Unrecognized key/);
});

test("activation-aware generation requires explicit Lovart context and exposes no credential fields", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-activation-"));
  const orchestrator = {
    async submit(input) { return { job: { id: "job-1", status: "succeeded", activation: input.activation }, result: { final_status: "done" } }; },
    async followUp(input) { return { job: { id: "follow-1", status: "queued_for_agent", activation: input.activation }, result: { final_status: "queued" } }; },
    async get() { return { job: { id: "job-1", status: "succeeded" }, artifacts: [] }; },
    async confirm(input) { return { job: { id: input.job_id, status: "succeeded" }, result: { final_status: "done" } }; },
  };
  const server = createServer({
    service: {},
    probeService: { async authorize() {}, async probe() {} },
    credentialService: { async status() { return { status: "connected" }; } },
    generationService: { async connect() { return { status: "connected" }; }, async generate() {}, async confirm() {} },
    orchestrator,
    dataDirectory,
  });
  const client = new Client({ name: "imvia-activation-contract-test", version: "0.3.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const tool = (await client.listTools()).tools.find((item) => item.name === "imvia_generate");
  assert.ok(tool);
  assert.equal(JSON.stringify(tool.inputSchema).includes("access_key"), false);
  const result = await client.callTool({ name: "imvia_generate", arguments: { prompt: "use Lovart", activation: { source: "codex_explicit" }, idempotency_key: "job-1" } });
  assert.equal(result.structuredContent.data.job.activation.source, "codex_explicit");
  const followUp = await client.callTool({ name: "imvia_follow_up_generation", arguments: { parent_job_id: "parent-1", artifact_id: "artifact-1", instruction: "make it dusk", activation: { source: "codex_context_continuation", parent_job_id: "parent-1", artifact_id: "artifact-1" }, idempotency_key: "follow-1" } });
  assert.equal(followUp.structuredContent.data.job.activation.source, "codex_context_continuation");
  assert.equal(JSON.stringify(followUp).includes("accessKey"), false);
});
