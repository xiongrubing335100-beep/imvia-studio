#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DomainError, createWorkbenchService } from "./domain/workbench-service.js";
import { CANONICAL_UTC_TIMESTAMP_PATTERN } from "./domain/timestamps.js";
import { startHttpServer } from "./http/server.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_VERSION = "0.1.0";
const SCHEMA_VERSION = "1";
const DEFAULT_HTTP_PORT = 4190;

function configuredPort() {
  const value = Number.parseInt(process.env.IMVIA_HTTP_PORT ?? "", 10);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : DEFAULT_HTTP_PORT;
}

function healthResponse(httpService) {
  return {
    api_version: "1",
    ok: true,
    data: {
      plugin_version: PLUGIN_VERSION,
      schema_version: SCHEMA_VERSION,
      server_id: "imvia-studio",
      http_service: {
        status: httpService ? "started" : "not_started",
        port: httpService?.port ?? configuredPort(),
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
  };
}

function toMcpResponse(body) {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function domainResponse(action) {
  return async (input) => {
    try {
      return toMcpResponse({ api_version: "1", ok: true, data: await action(input) });
    } catch (error) {
      const known = error instanceof DomainError;
      return toMcpResponse({
        api_version: "1",
        ok: false,
        error: {
          code: known ? error.code : "STORE_UNAVAILABLE",
          message: known ? error.message : "The local workbench store is unavailable.",
          retryable: known && ["REVISION_CONFLICT", "STATUS_CONFLICT"].includes(error.code),
          details: known ? error.details : {},
        },
      });
    }
  };
}

export function createServer({ service: providedService, httpService = null } = {}) {
  const server = new McpServer({ name: "imvia-studio", version: PLUGIN_VERSION });
  const stateDirectory = process.env.IMVIA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.imvia-studio-dev");
  const service = providedService || createWorkbenchService({ dataDirectory: stateDirectory });
  server.registerTool(
    "imvia_health",
    {
      description: "Read IMVIA Studio MCP health. Does not inspect, call, or modify Lovart.",
      inputSchema: {},
    },
    async () => toMcpResponse(healthResponse(httpService)),
  );
  server.registerTool("imvia_get_state", { description: "Read the current local IMVIA project and draft.", inputSchema: { include: z.array(z.enum(["jobs", "artifacts"])).optional() } }, domainResponse((input) => service.getState(input)));
  server.registerTool("imvia_get_account_status", {
    description: "Read the latest local account-capability cache without contacting Lovart.",
    inputSchema: z.object({ max_age_seconds: z.number().int().min(0).max(86400).optional() }).strict(),
  }, domainResponse(async (input) => {
    const result = await service.getAccountStatus(input);
    return { ...result.account_status, stale: result.stale };
  }));
  server.registerTool("imvia_update_account_status", {
    description: "Write sourced fixture account capability data. Never accepts credentials or contacts Lovart.",
    inputSchema: z.object({
      availability: z.enum(["available", "partial", "unavailable"]),
      billing_mode: z.string().min(1).nullable(),
      credit_balance: z.number().nonnegative().nullable(),
      credit_unit: z.string().min(1).nullable(),
      balance_reason: z.literal("UPSTREAM_CAPABILITY_UNAVAILABLE").nullable(),
      source_tool: z.string().min(1),
      checked_at: z.string().regex(CANONICAL_UTC_TIMESTAMP_PATTERN),
      expires_at: z.string().regex(CANONICAL_UTC_TIMESTAMP_PATTERN).nullable().optional(),
    }).strict(),
  }, domainResponse(async (input) => {
    const result = await service.updateAccountStatus(input);
    return result.account_status;
  }));
  server.registerTool("imvia_patch_workbench", { description: "Apply a revision-checked patch to the local workbench draft.", inputSchema: { draft_id: z.string().min(1), base_revision: z.number().int().nonnegative(), actor: z.enum(["codex", "user"]), reason: z.string().min(1), patch: z.record(z.unknown()) } }, domainResponse(async (input) => { const result = await service.patchWorkbench(input); return { revision: result.draft.revision, changed_fields: result.changed_fields, validation: { warnings: [] } }; }));
  server.registerTool("imvia_create_iteration", {
    description: "Create a new editable local draft from a completed parent job. Never calls Lovart.",
    inputSchema: {
      source_job_id: z.string().min(1),
      artifact_id: z.string().min(1).optional(),
      reuse_lovart_thread: z.boolean(),
      instruction: z.string().min(1),
    },
  }, domainResponse(async (input) => {
    const result = await service.createIteration(input);
    return { draft_id: result.draft.id, parent_job_id: result.parent_job_id, iteration_index: result.iteration_index, reusable_thread: result.reusable_thread };
  }));
  server.registerTool("imvia_prepare_generation", { description: "Create an immutable local task snapshot without calling Lovart.", inputSchema: { draft_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), idempotency_key: z.string().min(1) } }, domainResponse(async (input) => { const result = await service.prepareGeneration(input); return { job_id: result.job.id, status: result.job.status, snapshot: result.job.snapshot, validation: result.validation ?? { warnings: [] } }; }));
  server.registerTool("imvia_list_pending_jobs", { description: "List local tasks waiting for a Codex agent.", inputSchema: { limit: z.number().int().min(1).max(50).optional() } }, domainResponse(async (input) => ({ jobs: await service.listPendingJobs(input), next_cursor: null })));
  server.registerTool("imvia_update_job", {
    description: "Record a sourced local job-state transition. This tool never calls Lovart.",
    inputSchema: {
      job_id: z.string().min(1),
      expected_status: z.string().min(1),
      next_status: z.string().min(1),
      attempt: z.number().int().positive(),
      source: z.string().min(1),
      source_checked_at: z.string().regex(CANONICAL_UTC_TIMESTAMP_PATTERN).optional(),
      lovart_thread_id: z.string().min(1).optional(),
      estimated_cost: z.object({ amount: z.number().nonnegative(), unit: z.string().min(1) }).optional(),
      cost_decision_id: z.string().min(1).optional(),
      confirmation_evidence: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("confirmation_accepted") }).strict(),
        z.object({
          kind: z.literal("confirmation_failed"),
          error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
        }).strict(),
      ]).optional(),
      error: z.record(z.unknown()).optional(),
    },
  }, domainResponse(async (input) => { const result = await service.updateJob(input); return { job_id: result.job.id, status: result.job.status, attempt: result.job.attempt, estimated_cost: result.job.estimated_cost, lovart_thread_id: result.job.lovart_thread_id, lovart_thread_source: result.job.lovart_thread_source ?? null }; }));
  server.registerTool("imvia_record_cost_decision", {
    description: "Record an explicit current-session cost decision in local IMVIA state. Never calls Lovart.",
    inputSchema: {
      job_id: z.string().min(1),
      attempt: z.number().int().positive(),
      cost_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      decision: z.enum(["accepted", "declined"]),
      source: z.literal("user:current_session"),
      idempotency_key: z.string().min(1),
    },
  }, domainResponse(async (input) => {
    const result = await service.recordCostDecision(input);
    return {
      receipt: {
        job_id: result.job.id,
        status_at_recording: result.job.status,
        decision: result.decision,
      },
      idempotent: result.idempotent,
    };
  }));
  server.registerTool("imvia_claim_cost_decision", {
    description: "Consume one accepted local cost decision exactly once. Never calls Lovart.",
    inputSchema: {
      decision_id: z.string().min(1),
      job_id: z.string().min(1),
      attempt: z.number().int().positive(),
      cost_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    },
  }, domainResponse(async (input) => {
    const result = await service.claimCostDecision(input);
    return { job_id: result.job.id, status: result.job.status, decision: result.decision };
  }));
  server.registerTool("imvia_import_result", {
    description: "Register already-downloaded artifacts from the IMVIA managed directory. This tool never reads Lovart credentials or calls Lovart.",
    inputSchema: {
      job_id: z.string().min(1),
      idempotency_key: z.string().min(1),
      artifacts: z.array(z.object({
        kind: z.enum(["image", "video", "audio"]),
        local_path: z.string().min(1),
        mime_type: z.string().min(1).optional(),
        source_url: z.string().nullable().optional(),
        source_artifact_id: z.string().min(1).optional(),
        metadata: z.record(z.unknown()).optional(),
      })).min(1),
    },
  }, domainResponse(async (input) => { const result = await service.importResult(input); return { job_id: result.job.id, status: result.job.status, results: result.results, idempotent: result.idempotent }; }));
  return server;
}

export async function startServer() {
  const stateDirectory = process.env.IMVIA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.imvia-studio-dev");
  const service = createWorkbenchService({ dataDirectory: stateDirectory });
  const http = await startHttpServer({ service, port: configuredPort() });
  const httpService = { port: Number.parseInt(new URL(http.url).port, 10) };
  const server = createServer({ service, httpService });
  const closeHttp = () => http.close().catch(() => undefined);
  process.stdin.once("end", closeHttp);
  process.once("SIGINT", closeHttp);
  process.once("SIGTERM", closeHttp);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error("IMVIA Studio MCP failed to start:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
