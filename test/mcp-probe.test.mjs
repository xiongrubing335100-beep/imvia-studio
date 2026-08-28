import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { DomainError } from "../src/domain/errors.js";
import { createServer } from "../src/index.js";

const expectedTools = [
  "imvia_authorize_lovart_probe", "imvia_claim_cost_decision", "imvia_claim_next_workbench_dispatch",
  "imvia_confirm_generation", "imvia_connect_lovart", "imvia_create_iteration",
  "imvia_disconnect_lovart", "imvia_execute_workbench_submission",
  "imvia_generate", "imvia_get_account_status", "imvia_get_state", "imvia_health",
  "imvia_get_bridge_status", "imvia_heartbeat_conversation_bridge", "imvia_import_result", "imvia_list_pending_jobs",
  "imvia_list_provider_connections", "imvia_list_providers", "imvia_lovart_status", "imvia_mark_dispatch_host_accepted", "imvia_open_workbench",
  "imvia_patch_workbench", "imvia_prepare_generation", "imvia_probe_lovart_capabilities",
  "imvia_record_cost_decision", "imvia_register_conversation_bridge", "imvia_release_dispatch_claim", "imvia_test_provider_connection", "imvia_update_account_status", "imvia_update_job",
].sort();

const originalSchemaHashes = {
  imvia_health: "55afd3d22cd35ef3b5e3dc2e2651ad10a586f230804ece94dcd65ac7867639fb",
  imvia_get_state: "40c04f44f3826cdf2e6c9c8ae21fa763f41e3ba5236c786a9f8e93bfe75b44d8",
  imvia_get_account_status: "1247f6742da311cb1d292dae23a3bc20493d8abade1c154f93f773c59dc2bc00",
  imvia_update_account_status: "ca4885c4a3bc000661c7507d8bbb08118646810d28601754a48f21e0a2a0b0f9",
  imvia_patch_workbench: "92bfa29afdf8ac9fa78209fca0311456be8d3faf2201389a6ce3fa6d6dc018c3",
  imvia_create_iteration: "12481d8e22f770acca289535797752a49c6d11c865792186343bce820c693bb6",
  imvia_prepare_generation: "dfbbde3e4dcd7274d9121ae5298075195abd28f223f636c668c05209f98f1ebc",
  imvia_list_pending_jobs: "3c1b5ddddb0ca52a485e51db0e91613647baf07746188f99248107c9a69f7d3a",
  imvia_update_job: "098bd8c4752e927fe2268ea62de1fe9ca18550310876813a3ae95fa2b014eca1",
  imvia_record_cost_decision: "7c6a7d65f689c39517c224cf2a98d5d6a04565f0f6909022b9a3bd4b5e5c1d8e",
  imvia_claim_cost_decision: "f8394b19dedaa2252b9edf3e6d4f9c593414b0d0136f9d069eb624b8d354f7f9",
  imvia_import_result: "e7c9dee35ba83ac6292d71aa5cdd9e0a4841f4dae7b50bc0ad3ac6e19b00c632",
};

const prohibitedFields = [
  "url", "origin", "path", "method", "credential", "credential_reference",
  "retry", "tls", "proxy", "model", "project", "thread", "account",
];

async function connectServer(context, probeService) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-probe-"));
  const server = createServer({ service: {}, probeService, dataDirectory });
  const client = new Client({ name: "imvia-probe-contract-test", version: "0.1.0" });
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

function schemaHash(inputSchema) {
  return createHash("sha256").update(JSON.stringify(inputSchema)).digest("hex");
}

test("MCP exposes exactly two new probe tools and preserves all original schemas", async (context) => {
  const client = await connectServer(context, {
    async authorize() { throw new Error("not called"); },
    async probe() { throw new Error("not called"); },
  });
  const tools = (await client.listTools()).tools;

  assert.deepEqual(tools.map(({ name }) => name).sort(), expectedTools);
  for (const [name, expectedHash] of Object.entries(originalSchemaHashes)) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    assert.equal(schemaHash(tool.inputSchema), expectedHash, name);
  }
});

test("MCP recursively redacts sensitive domain and bridge error details", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-redaction-"));
  const sensitive = {
    nested: { authorization: "Bearer hidden", credential_values: { api_key: "hidden-key" } },
    values: [{ api_key: "hidden-array-key" }, { safe: "visible" }],
  };
  const server = createServer({
    service: {},
    probeService: { async authorize() {}, async probe() {} },
    dataDirectory,
    connectionStore: { async get() { throw new DomainError("NOT_FOUND", "missing", sensitive); }, async list() { return []; } },
    bridgeService: { async getSessionStatus() { throw new DomainError("SESSION_TOKEN_INVALID", "bad", sensitive); } },
  });
  const client = new Client({ name: "imvia-mcp-redaction-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); await rm(dataDirectory, { recursive: true, force: true }); });

  for (const request of [
    { name: "imvia_test_provider_connection", arguments: { connection_id: "missing" } },
    { name: "imvia_get_bridge_status", arguments: { session_id: "session" } },
  ]) {
    const result = await client.callTool(request);
    const encoded = JSON.stringify(result.structuredContent);
    for (const forbidden of ["authorization", "credential_values", "api_key", "hidden", "Bearer"]) assert.equal(encoded.includes(forbidden), false, `${request.name}: ${forbidden}`);
  }
});

test("probe tools trim exact inputs and return stable success envelopes", async (context) => {
  const authorization = {
    authorization_id: "auth-1",
    policy_version: "lovart-readonly-probe-v1",
    issued_at: "2026-08-20T00:00:00.000Z",
    expires_at: "2026-08-20T00:02:00.000Z",
    consumed: false,
  };
  const summary = {
    reachable: true,
    authenticated: true,
    service_version: null,
    capability_status: "unknown",
    workbench_models: [],
    checked_at: "2026-08-20T00:00:01.000Z",
    expires_at: "2026-08-20T00:05:01.000Z",
    policy_version: "lovart-readonly-probe-v1",
  };
  const client = await connectServer(context, {
    async authorize(input) {
      assert.deepEqual(input, {
        source: "user:current_session",
        reason: "Current session request",
        idempotency_key: "authorize-1",
      });
      return authorization;
    },
    async probe(input) {
      assert.deepEqual(input, { authorization_id: "auth-1", idempotency_key: "probe-1" });
      return summary;
    },
  });

  const authorized = await client.callTool({
    name: "imvia_authorize_lovart_probe",
    arguments: {
      source: "user:current_session",
      reason: "  Current session request  ",
      idempotency_key: "  authorize-1  ",
    },
  });
  assert.deepEqual(authorized.structuredContent, { api_version: "1", ok: true, data: authorization });

  const probed = await client.callTool({
    name: "imvia_probe_lovart_capabilities",
    arguments: { authorization_id: "  auth-1  ", idempotency_key: "  probe-1  " },
  });
  assert.deepEqual(probed.structuredContent, { api_version: "1", ok: true, data: summary });
});

test("probe schemas reject missing, blank, incorrect, and authority-expanding fields", async (context) => {
  let serviceCalls = 0;
  const client = await connectServer(context, {
    async authorize() { serviceCalls += 1; },
    async probe() { serviceCalls += 1; },
  });

  for (const arguments_ of [
    {},
    { source: "user:earlier_session", reason: "why", idempotency_key: "auth-1" },
    { source: "user:current_session", reason: "   ", idempotency_key: "auth-1" },
    { source: "user:current_session", reason: "why", idempotency_key: "   " },
  ]) {
    const result = await client.callTool({ name: "imvia_authorize_lovart_probe", arguments: arguments_ });
    assert.equal(result.isError, true, JSON.stringify(arguments_));
  }
  for (const prohibited of prohibitedFields) {
    const result = await client.callTool({
      name: "imvia_authorize_lovart_probe",
      arguments: {
        source: "user:current_session",
        reason: "why",
        idempotency_key: "auth-1",
        [prohibited]: "forbidden",
      },
    });
    assert.equal(result.isError, true, prohibited);
  }

  for (const arguments_ of [
    {},
    { authorization_id: "   ", idempotency_key: "probe-1" },
    { authorization_id: "auth-1", idempotency_key: "   " },
  ]) {
    const result = await client.callTool({ name: "imvia_probe_lovart_capabilities", arguments: arguments_ });
    assert.equal(result.isError, true, JSON.stringify(arguments_));
  }
  for (const prohibited of prohibitedFields) {
    const result = await client.callTool({
      name: "imvia_probe_lovart_capabilities",
      arguments: {
        authorization_id: "auth-1",
        idempotency_key: "probe-1",
        [prohibited]: "forbidden",
      },
    });
    assert.equal(result.isError, true, prohibited);
  }
  assert.equal(serviceCalls, 0);
});

test("probe handlers preserve stable domain errors and redact unexpected failures", async (context) => {
  const client = await connectServer(context, {
    async authorize() {
      throw new Error("SECRET_AUTHORIZATION_FAILURE");
    },
    async probe() {
      throw new DomainError(
        "AUTHENTICATION_FAILED",
        "Lovart authentication was rejected",
        { authenticated: false },
      );
    },
  });

  const authorizationFailure = await client.callTool({
    name: "imvia_authorize_lovart_probe",
    arguments: { source: "user:current_session", reason: "why", idempotency_key: "auth-1" },
  });
  assert.deepEqual(authorizationFailure.structuredContent, {
    api_version: "1",
    ok: false,
    error: {
      code: "STORE_UNAVAILABLE",
      message: "The local workbench store is unavailable.",
      retryable: false,
      details: {},
    },
  });
  assert.equal(JSON.stringify(authorizationFailure).includes("SECRET_AUTHORIZATION_FAILURE"), false);

  const probeFailure = await client.callTool({
    name: "imvia_probe_lovart_capabilities",
    arguments: { authorization_id: "auth-1", idempotency_key: "probe-1" },
  });
  assert.deepEqual(probeFailure.structuredContent, {
    api_version: "1",
    ok: false,
    error: {
      code: "AUTHENTICATION_FAILED",
      message: "Lovart authentication was rejected",
      retryable: false,
      details: { authenticated: false },
    },
  });
});
