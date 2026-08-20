import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("starts the independent imvia-studio MCP and responds to imvia_health", async (context) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "src/index.js")],
    cwd: pluginRoot,
    env: { ...process.env, IMVIA_HTTP_PORT: "0" },
  });
  const client = new Client({ name: "imvia-studio-test-client", version: "0.1.0" });
  context.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["imvia_claim_cost_decision", "imvia_create_iteration", "imvia_get_account_status", "imvia_get_state", "imvia_health", "imvia_import_result", "imvia_list_pending_jobs", "imvia_patch_workbench", "imvia_prepare_generation", "imvia_record_cost_decision", "imvia_update_account_status", "imvia_update_job"],
  );

  const result = await client.callTool({ name: "imvia_health", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.http_service.status, "started");
  assert.ok(result.structuredContent.data.http_service.port > 0);
  assert.deepEqual({ ...result.structuredContent, data: { ...result.structuredContent.data, http_service: { ...result.structuredContent.data.http_service, port: 0 } } }, {
    api_version: "1",
    ok: true,
    data: {
      plugin_version: "0.1.0",
      schema_version: "1",
      server_id: "imvia-studio",
      http_service: {
        status: "started",
        port: 0,
        host: "127.0.0.1",
      },
      data_store: {
        status: "available",
      },
      diagnostics: {
        last_error: null,
        lovart_checked: false,
      },
    },
  });
});
