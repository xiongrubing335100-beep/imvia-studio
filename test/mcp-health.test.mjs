import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("starts the independent imvia-studio MCP and responds to imvia_health", async (context) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-mcp-health-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "src/index.js")],
    cwd: pluginRoot,
    env: { ...process.env, IMVIA_DATA_DIR: dataDirectory, IMVIA_HTTP_PORT: "0" },
  });
  const client = new Client({ name: "imvia-studio-test-client", version: "0.3.0" });
  context.after(async () => {
    await client.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["imvia_authorize_lovart_probe", "imvia_claim_cost_decision", "imvia_confirm_generation", "imvia_connect_lovart", "imvia_create_iteration", "imvia_create_lovart_project", "imvia_execute_workbench_submission", "imvia_follow_up_generation", "imvia_generate", "imvia_get_account_status", "imvia_get_generation", "imvia_get_state", "imvia_health", "imvia_import_result", "imvia_list_lovart_projects", "imvia_list_pending_jobs", "imvia_lovart_status", "imvia_open_workbench", "imvia_patch_workbench", "imvia_prepare_generation", "imvia_probe_lovart_capabilities", "imvia_record_cost_decision", "imvia_select_lovart_project", "imvia_update_account_status", "imvia_update_job", "imvia_wait_for_workbench_submission"],
  );

  const result = await client.callTool({ name: "imvia_health", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.http_service.status, "started");
  assert.ok(result.structuredContent.data.http_service.port > 0);
  assert.deepEqual({ ...result.structuredContent, data: { ...result.structuredContent.data, http_service: { ...result.structuredContent.data.http_service, port: 0 } } }, {
    api_version: "1",
    ok: true,
    data: {
      plugin_version: "0.3.0",
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

  const opened = await client.callTool({ name: "imvia_open_workbench", arguments: {} });
  assert.equal(opened.structuredContent.data.mode, "live");
  assert.equal(opened.structuredContent.data.placement, "right");
  assert.equal(opened.structuredContent.data.submission_cursor, null);
  assert.match(opened.structuredContent.data.workbench_url, /^http:\/\/127\.0\.0\.1:\d+\/workbench\?imvia=live$/);

  await assert.rejects(
    access(path.join(dataDirectory, "lovart-probe-state-v1.json")),
    (error) => error?.code === "ENOENT",
  );
});
