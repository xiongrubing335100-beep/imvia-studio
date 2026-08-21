#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DomainError, createWorkbenchService } from "./domain/workbench-service.js";
import { CANONICAL_UTC_TIMESTAMP_PATTERN } from "./domain/timestamps.js";
import { startHttpServer } from "./http/server.js";
import { createProbeAuthorizationService } from "./probe/authorization-service.js";
import { createProbeChildRunner } from "./probe/child-runner.js";
import { createLovartProbeService } from "./probe/probe-service.js";
import { createProbeStore } from "./probe/probe-store.js";
import { createCredentialService } from "./lovart/credentials.js";
import { createGenerationService } from "./lovart/generation-service.js";
import { createProjectContextService } from "./lovart/project-context-service.js";
import { createArtifactTransfer } from "./lovart/artifact-transfer.js";
import { createGenerationOrchestrator } from "./lovart/generation-orchestrator.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_VERSION = "0.3.0";
const SCHEMA_VERSION = "1";
const DEFAULT_HTTP_PORT = 4190;
const WORKBENCH_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workbench/dist");
const authorizeProbeInput = z.object({
  source: z.literal("user:current_session"),
  reason: z.string().trim().min(1),
  idempotency_key: z.string().trim().min(1),
}).strict();
const runProbeInput = z.object({
  authorization_id: z.string().trim().min(1),
  idempotency_key: z.string().trim().min(1),
}).strict();
export const activationSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("codex_explicit") }).strict(),
  z.object({
    source: z.literal("codex_context_continuation"),
    parent_job_id: z.string().min(1).optional(),
    artifact_id: z.string().min(1).optional(),
  }).strict(),
]).superRefine((value, context) => {
  if (value.source === "codex_context_continuation" && !value.parent_job_id && !value.artifact_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "context continuation requires parent_job_id or artifact_id" });
  }
});

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

const LOVART_ERROR_CODES = new Set([
  "AUTHENTICATION_FAILED",
  "CREDENTIAL_REFERENCE_UNAVAILABLE",
  "CREDENTIAL_SETUP_CANCELLED",
  "CREDENTIAL_SETUP_FAILED",
  "CREDENTIAL_SETUP_INVALID",
  "PLATFORM_UNSUPPORTED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_SCHEMA_UNRECOGNIZED",
  "UPSTREAM_SECURITY_REJECTED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_UNREACHABLE",
  "INVALID_LOVART_PROJECT",
  "LOCAL_FILE_UNAVAILABLE",
  "ARTIFACT_DOWNLOAD_FAILED",
  "ARTIFACT_URL_NOT_ALLOWED",
]);

function lovartResponse(action) {
  return async (input) => {
    try {
      return toMcpResponse({ api_version: "1", ok: true, data: await action(input) });
    } catch (error) {
      const code = LOVART_ERROR_CODES.has(error?.code) ? error.code : "UPSTREAM_UNAVAILABLE";
      const retryable = ["UPSTREAM_RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_UNREACHABLE"].includes(code);
      return toMcpResponse({
        api_version: "1",
        ok: false,
        error: {
          code,
          message: error?.message || "Lovart upstream is unavailable",
          retryable,
          details: {},
        },
      });
    }
  };
}

function createProductionProbeService(stateDirectory) {
  const probeStore = createProbeStore({ dataDirectory: stateDirectory });
  const authorizationService = createProbeAuthorizationService({ store: probeStore });
  const childRunner = createProbeChildRunner();
  return createLovartProbeService({ authorizationService, runner: childRunner });
}

export function createServer({
  service: providedService,
  probeService: providedProbeService,
  credentialService: providedCredentialService,
  generationService: providedGenerationService,
  projectContextService: providedProjectContextService,
  orchestrator: providedOrchestrator,
  artifactTransfer: providedArtifactTransfer,
  httpService = null,
  dataDirectory: providedDataDirectory,
} = {}) {
  const server = new McpServer({ name: "imvia-studio", version: PLUGIN_VERSION });
  const stateDirectory = providedDataDirectory || process.env.IMVIA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.imvia-studio-dev");
  const service = providedService ?? createWorkbenchService({ dataDirectory: stateDirectory });
  const probeService = providedProbeService ?? createProductionProbeService(stateDirectory);
  const credentialService = providedCredentialService ?? createCredentialService();
  const generationService = providedGenerationService ?? createGenerationService({ credentialService });
  const projectContextService = providedProjectContextService ?? (
    service?.getLovartProjects && generationService?.validateProject && generationService?.createProject
      ? createProjectContextService({ workbenchService: service, generationService })
      : null
  );
  const artifactTransfer = providedArtifactTransfer ?? (projectContextService ? createArtifactTransfer({ dataDirectory: stateDirectory, workspaceDirectory: WORKBENCH_DIRECTORY }) : null);
  const orchestrator = providedOrchestrator ?? (
    projectContextService && generationService?.generate && generationService?.confirm && service?.createDirectGenerationJob
      ? createGenerationOrchestrator({ projectContextService, workbenchService: service, generationService, artifactTransfer })
      : null
  );
  server.registerTool(
    "imvia_health",
    {
      description: "Read IMVIA Studio MCP health. Does not inspect, call, or modify Lovart.",
      inputSchema: {},
    },
    async () => toMcpResponse(healthResponse(httpService)),
  );
  server.registerTool(
    "imvia_open_workbench",
    {
      description: "Return the local IMVIA Studio web workbench URL for opening in Codex's right-side browser panel.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const workbenchUrl = httpService?.workbench_url || httpService?.workbenchUrl || `http://127.0.0.1:${httpService?.port ?? configuredPort()}/workbench?imvia=live`;
      let submissionCursor = null;
      if (typeof service?.getState === "function") {
        const state = await service.getState({ include: ["jobs"] });
        submissionCursor = state.jobs?.at(-1)?.id ?? null;
      }
      return toMcpResponse({
        api_version: "1",
        ok: true,
        data: { workbench_url: workbenchUrl, placement: "right", mode: "live", submission_cursor: submissionCursor },
      });
    },
  );
  if (typeof service?.getState === "function" && typeof service?.createWorkbenchSubmission === "function") {
    server.registerTool("imvia_wait_for_workbench_submission", {
      description: "Wait briefly for a new IMVIA workbench button submission and return its immutable summary to Codex. Never calls Lovart.",
      inputSchema: z.object({
        after_job_id: z.string().min(1).nullable(),
        timeout_ms: z.number().int().min(0).max(30_000).optional(),
      }).strict(),
    }, domainResponse(async ({ after_job_id: afterJobId, timeout_ms: timeoutMs = 30_000 }) => {
      const deadline = Date.now() + timeoutMs;
      do {
        const state = await service.getState({ include: ["jobs"] });
        const jobs = Array.isArray(state.jobs) ? state.jobs : [];
        const cursorIndex = afterJobId == null ? -1 : jobs.findIndex((job) => job.id === afterJobId);
        if (afterJobId != null && cursorIndex < 0) throw new DomainError("NOT_FOUND", "The workbench submission cursor is no longer available.", { after_job_id: afterJobId });
        const submitted = jobs.slice(cursorIndex + 1).find((job) => job.submission_kind === "workbench_generation" && job.activation?.source === "workbench_action");
        if (submitted) {
          return {
            submitted: true,
            job_id: submitted.id,
            status: submitted.status,
            snapshot: submitted.snapshot,
            lovart_project_id: submitted.lovart_project_id ?? null,
            activation: submitted.activation,
            next_cursor: submitted.id,
          };
        }
        if (Date.now() >= deadline) return { submitted: false, next_cursor: afterJobId };
        await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
      } while (true);
    }));
  }
  server.registerTool("imvia_authorize_lovart_probe", {
    description: "Record an explicit current-session authorization for one read-only Lovart capability probe. Does not contact Lovart.",
    inputSchema: authorizeProbeInput,
  }, domainResponse((input) => probeService.authorize(input)));
  server.registerTool("imvia_probe_lovart_capabilities", {
    description: "Consume one authorization for a fixed, read-only Lovart connectivity and workbench-capability probe.",
    inputSchema: runProbeInput,
  }, domainResponse((input) => probeService.probe(input)));
  server.registerTool("imvia_connect_lovart", {
    description: "Open the secure native Lovart connection dialog and validate the connection. Keys never enter MCP arguments or results.",
    inputSchema: z.object({}).strict(),
  }, lovartResponse(() => generationService.connect()));
  server.registerTool("imvia_lovart_status", {
    description: "Read the redacted local Lovart connection status without opening a dialog or returning credentials.",
    inputSchema: z.object({}).strict(),
  }, lovartResponse(() => credentialService.status()));
  if (projectContextService) {
    server.registerTool("imvia_list_lovart_projects", {
      description: "List normalized Lovart project context without returning credentials.",
      inputSchema: z.object({}).strict(),
    }, domainResponse(() => projectContextService.list()));
    server.registerTool("imvia_select_lovart_project", {
      description: "Validate and activate one official Lovart project locator.",
      inputSchema: z.object({ locator: z.string().min(1), source: z.string().min(1).optional() }).strict(),
    }, domainResponse((input) => projectContextService.select(input)));
    server.registerTool("imvia_create_lovart_project", {
      description: "Create and activate a new Lovart project through the fixed official endpoint.",
      inputSchema: z.object({ name: z.string().min(1).optional() }).strict(),
    }, domainResponse((input) => projectContextService.create(input)));
  }
  if (orchestrator) {
    server.registerTool("imvia_generate", {
      description: "Submit one explicitly activated Lovart generation through the shared IMVIA orchestrator. Never confirms automatically or falls back to another provider.",
      inputSchema: z.object({
        prompt: z.string().min(1),
        project_locator: z.string().min(1).optional(),
        thread_id: z.string().min(1).optional(),
        attachments: z.array(z.string().min(1)).optional(),
        mode: z.enum(["fast", "thinking"]).optional(),
        prefer_models: z.record(z.array(z.string().min(1))).optional(),
        include_tools: z.array(z.string().min(1)).optional(),
        activation: activationSchema,
        idempotency_key: z.string().min(1),
      }).strict(),
    }, lovartResponse((input) => orchestrator.submit(input)));
    server.registerTool("imvia_execute_workbench_submission", {
      description: "Execute the exact immutable task previously submitted by the IMVIA workbench after Codex receives it. Project validation and Lovart side effects begin only here.",
      inputSchema: z.object({ job_id: z.string().min(1) }).strict(),
    }, lovartResponse((input) => orchestrator.executePrepared(input)));
    server.registerTool("imvia_get_generation", {
      description: "Read one redacted local Lovart generation job and its imported artifacts.",
      inputSchema: z.object({ job_id: z.string().min(1) }).strict(),
    }, lovartResponse((input) => orchestrator.get(input)));
    server.registerTool("imvia_follow_up_generation", {
      description: "Continue one imported Lovart artifact with an explicit text instruction. Reuses only the parent Lovart lineage and never falls back to another provider.",
      inputSchema: z.object({
        parent_job_id: z.string().min(1),
        artifact_id: z.string().min(1),
        instruction: z.string().min(1),
        activation: activationSchema,
        idempotency_key: z.string().min(1),
      }).strict(),
    }, lovartResponse((input) => orchestrator.followUp(input)));
    server.registerTool("imvia_confirm_generation", {
      description: "Confirm one pending Lovart job only after explicit current-session acceptance with the exact cost binding.",
      inputSchema: z.object({ job_id: z.string().min(1), attempt: z.number().int().positive(), cost_fingerprint: z.string().regex(/^[0-9a-f]{64}$/), decision_id: z.string().min(1) }).strict(),
    }, lovartResponse((input) => orchestrator.confirm(input)));
  } else {
    server.registerTool("imvia_generate", {
      description: "Send a prompt to Lovart and return generated artifacts or a pending cost confirmation. Never confirms automatically.",
      inputSchema: z.object({
        prompt: z.string().min(1),
        project_id: z.string().min(1).optional(),
        thread_id: z.string().min(1).optional(),
        attachments: z.array(z.string().min(1)).optional(),
        mode: z.enum(["fast", "thinking"]).optional(),
        prefer_models: z.record(z.array(z.string().min(1))).optional(),
        include_tools: z.array(z.string().min(1)).optional(),
      }).strict(),
    }, lovartResponse((input) => generationService.generate(input)));
    server.registerTool("imvia_confirm_generation", {
      description: "Confirm a pending high-cost Lovart operation only after the user explicitly accepts the displayed cost.",
      inputSchema: z.object({ thread_id: z.string().min(1) }).strict(),
    }, lovartResponse((input) => generationService.confirm(input)));
  }
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
  const probeService = createProductionProbeService(stateDirectory);
  const credentialService = createCredentialService();
  const generationService = createGenerationService({ credentialService });
  const projectContextService = createProjectContextService({ workbenchService: service, generationService });
  const artifactTransfer = createArtifactTransfer({ dataDirectory: stateDirectory, workspaceDirectory: WORKBENCH_DIRECTORY });
  const orchestrator = createGenerationOrchestrator({ projectContextService, workbenchService: service, generationService, artifactTransfer });
  const http = await startHttpServer({
    service,
    dataDirectory: stateDirectory,
    projectContextService,
    orchestrator,
    port: configuredPort(),
    lovartConnection: {
      connect: () => generationService.connect(),
      status: () => credentialService.status(),
    },
  });
  const httpService = { port: Number.parseInt(new URL(http.url).port, 10), url: http.url, workbench_url: http.workbenchUrl };
  const server = createServer({ service, probeService, credentialService, generationService, projectContextService, artifactTransfer, orchestrator, httpService, dataDirectory: stateDirectory });
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
