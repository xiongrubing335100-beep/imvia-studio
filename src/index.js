#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
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
import { createOnboardingService } from "./lovart/onboarding-service.js";
import { createProjectContextService } from "./lovart/project-context-service.js";
import { createArtifactTransfer } from "./lovart/artifact-transfer.js";
import { createGenerationOrchestrator } from "./lovart/generation-orchestrator.js";
import { createHelperClient } from "./lovart/helper-client.js";
import { resolveCredentialHelper } from "./lovart/helper-manifest.js";
import { createDefaultProviderRegistry } from "./providers/default-providers.js";
import { createConnectionStore } from "./providers/connection-store.js";
import { createProviderCredentialService } from "./providers/provider-credentials.js";
import { createProviderConnectionService } from "./providers/provider-connection-service.js";
import { createProviderDiscoveryService } from "./providers/provider-discovery.js";
import { createAdapterRegistry } from "./providers/adapter-registry.js";
import { createOpenAiCompatibleImagesAdapter } from "./providers/adapters/openai-compatible-images.js";
import { safeProviderJsonRequest } from "./providers/safe-provider-http.js";
import { createProviderExecutionRouter } from "./providers/provider-execution-router.js";
import { createGenericRestConnector } from "./providers/generic-rest-connector.js";
import { createBridgeSessionService } from "./bridge/bridge-session-service.js";
import { buildConversationBridgeHtml } from "./bridge/bridge-resource.js";
import { BRIDGE_PROTOCOL_VERSION } from "./bridge/constants.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_VERSION = "0.3.0";
const SCHEMA_VERSION = "1";
const DEFAULT_HTTP_PORT = 0;
const WORKBENCH_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workbench/dist");
const BRIDGE_RESOURCE_URI = "ui://imvia-studio/conversation-bridge-v1.html";
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

export async function startWorkbenchHttpServer(options) {
  try {
    return await startHttpServer(options);
  } catch (error) {
    // A stale fixed-port override must not take the whole MCP transport down.
    // The normal plugin configuration uses port 0; when a deployment pins a
    // port, transparently fall back to an OS-assigned loopback port if that
    // port is already occupied. The returned workbench URL is rebuilt from
    // the actual bound port, so callers never receive a dead URL.
    if (options?.port !== 0 && ["EADDRINUSE", "EACCES"].includes(error?.code)) {
      return startHttpServer({ ...options, port: DEFAULT_HTTP_PORT });
    }
    throw error;
  }
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

function createMcpProgressReporter(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || typeof extra?.sendNotification !== "function") return async () => {};
  let progress = 0;
  return async (update = {}) => {
    const reported = Number.isFinite(update.progress) && update.progress >= 0 && update.progress <= 100
      ? update.progress
      : update.phase === "completed" ? 100 : progress + 1;
    progress = Math.max(progress, reported);
    const params = {
      progressToken,
      progress,
      message: typeof update.message === "string" && update.message.trim() ? update.message.trim() : "任务状态已更新。",
    };
    if (Number.isFinite(update.total)) params.total = update.total;
    try {
      await extra.sendNotification({ method: "notifications/progress", params });
    } catch {
      // The Codex progress channel is best effort; the persisted local state
      // and final MCP result remain authoritative.
    }
  };
}

const MCP_SENSITIVE_DETAIL_KEY = /(?:credential(?:_values)?|secret(?:_?key)?|access_?key|api_?key|authorization|bearer|token|password|private_?key)/i;
function redactMcpErrorDetails(value) {
  if (Array.isArray(value)) return value.map(redactMcpErrorDetails);
  if (!value || typeof value !== "object") return value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (MCP_SENSITIVE_DETAIL_KEY.test(key)) continue;
    safe[key] = redactMcpErrorDetails(item);
  }
  return safe;
}

function domainResponse(action) {
  return async (input, extra) => {
    try {
      return toMcpResponse({ api_version: "1", ok: true, data: await action(input, extra) });
    } catch (error) {
      const known = error instanceof DomainError;
      return toMcpResponse({
        api_version: "1",
        ok: false,
        error: {
          code: known ? error.code : "STORE_UNAVAILABLE",
          message: known ? error.message : "The local workbench store is unavailable.",
          retryable: known && ["REVISION_CONFLICT", "STATUS_CONFLICT"].includes(error.code),
          details: known ? redactMcpErrorDetails(error.details) : {},
        },
      });
    }
  };
}

const LOVART_ERROR_CODES = new Set([
  "AUTHENTICATION_FAILED",
  "CONNECTED",
  "CREDENTIAL_REFERENCE_UNAVAILABLE",
  "CREDENTIAL_STORE_DENIED",
  "CREDENTIAL_SETUP_CANCELLED",
  "CREDENTIAL_SETUP_FAILED",
  "CREDENTIAL_SETUP_INVALID",
  "HELPER_NOT_PACKAGED",
  "HELPER_LAUNCH_FAILED",
  "SETUP_CANCELLED",
  "SETUP_INVALID",
  "SETUP_REQUIRED",
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
  "DELIVERY_STATE_CONFLICT",
  "DISPATCH_LEASE_CONFLICT",
  "SESSION_EXPIRED",
  "SESSION_TOKEN_INVALID",
]);

function lovartResponse(action) {
  return async (input, extra) => {
    try {
      return toMcpResponse({ api_version: "1", ok: true, data: await action(input, extra) });
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

function bridgeResponse(action) {
  return async (input, extra) => {
    try {
      return toMcpResponse({ api_version: "1", ok: true, data: await action(input, extra) });
    } catch (error) {
      return toMcpResponse({
        api_version: "1",
        ok: false,
        error: {
          code: error?.code || "BRIDGE_UNAVAILABLE",
          message: error?.message || "The IMVIA conversation bridge is unavailable.",
          retryable: ["SESSION_EXPIRED", "DISPATCH_LEASE_CONFLICT", "BRIDGE_UNAVAILABLE"].includes(error?.code),
          details: redactMcpErrorDetails(error?.details || {}),
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

function createProviderConnectionTester({ providerRegistry, adapterRegistry }) {
  return async ({ connection, credential }) => {
    if (connection?.legacy !== true) {
      if (connection?.provider_id !== "external-api" || typeof connection?.adapter_id !== "string" || typeof connection?.adapter_version !== "string" || !adapterRegistry?.get) {
        throw new DomainError("VALIDATION_FAILED", "该 API 连接尚未完成可用的模型识别，请先重新发现模型。", { field: "connection_id" });
      }
      let adapter;
      try { adapter = adapterRegistry.get(connection.adapter_id, connection.adapter_version); }
      catch { throw new DomainError("VALIDATION_FAILED", "该 API 连接使用的适配器不可用，请重新发现模型。", { field: "connection_id" }); }
      const result = await adapter.validateConnection({ connection, credential, snapshot: {}, attachments: [], onProgress: () => undefined });
      return {
        status: result?.accepted === false ? "failed" : "connected",
        code: result?.accepted === false ? "CONNECTION_TEST_FAILED" : "CONNECTED",
      };
    }
    const target = providerRegistry.resolve(connection.provider_id);
    if (target.descriptor.kind !== "generic_rest") throw new DomainError("VALIDATION_FAILED", "旧版连接缺少可用的 REST 验证配置。", { field: "connection_id" });
    const connector = createGenericRestConnector();
    return connector.validateConnection({ connection, credential, snapshot: {}, attachments: [], onProgress: () => undefined });
  };
}

export function createServer({
  service: providedService,
  probeService: providedProbeService,
  credentialService: providedCredentialService,
  generationService: providedGenerationService,
  onboardingService: providedOnboardingService,
  projectContextService: providedProjectContextService,
  orchestrator: providedOrchestrator,
  artifactTransfer: providedArtifactTransfer,
  bridgeService: providedBridgeService,
  providerRegistry: providedProviderRegistry,
  connectionStore: providedConnectionStore,
  providerCredentialService: providedProviderCredentialService,
  providerConnectionService: providedProviderConnectionService,
  adapterRegistry: providedAdapterRegistry,
  discoveryService: providedDiscoveryService,
  providerExecutionRouter: providedProviderExecutionRouter,
  providerConnectionTester: providedProviderConnectionTester,
  httpService = null,
  dataDirectory: providedDataDirectory,
} = {}) {
  const server = new McpServer({ name: "imvia-studio", version: PLUGIN_VERSION });
  const stateDirectory = providedDataDirectory || process.env.IMVIA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.imvia-studio-dev");
  const providerRegistry = providedProviderRegistry ?? createDefaultProviderRegistry();
  const connectionStore = providedConnectionStore ?? createConnectionStore({ dataDirectory: stateDirectory, registry: providerRegistry });
  const service = providedService ?? createWorkbenchService({ dataDirectory: stateDirectory, providerRegistry, connectionStore });
  const bridgeService = providedBridgeService ?? createBridgeSessionService({ dataDirectory: stateDirectory });
  const probeService = providedProbeService ?? createProductionProbeService(stateDirectory);
  const credentialService = providedCredentialService ?? createCredentialService();
  const generationService = providedGenerationService ?? createGenerationService({ credentialService });
  const onboardingService = providedOnboardingService ?? createOnboardingService({
    credentialService,
    connect: ({ onState }) => generationService.connect({ onState }),
  });
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
  const providerCredentialService = providedProviderCredentialService ?? createProviderCredentialService({
    helperClient: createHelperClient({ resolveHelper: () => resolveCredentialHelper({ pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), platform: process.platform, arch: process.arch }) }),
  });
  const safeRequest = safeProviderJsonRequest;
  const adapterRegistry = providedAdapterRegistry ?? createAdapterRegistry({ adapters: [createOpenAiCompatibleImagesAdapter({ request: safeRequest })] });
  const discoveryService = providedDiscoveryService ?? (providedProviderConnectionService ? null : createProviderDiscoveryService({ adapterRegistry }));
  const providerConnectionService = providedProviderConnectionService ?? createProviderConnectionService({ connectionStore, credentialService: providerCredentialService, discoveryService, adapterRegistry });
  const canCreateProviderRouter = Boolean(orchestrator?.executePrepared && orchestrator?.get && orchestrator?.confirm
    && service?.getState && service?.updateLiveJob && service?.importResult
    && providerRegistry?.resolve && connectionStore?.get);
  const providerExecutionRouter = providedProviderExecutionRouter ?? (canCreateProviderRouter
    ? createProviderExecutionRouter({ registry: providerRegistry, connectionStore, lovartOrchestrator: orchestrator, genericConnectorFactory: () => createGenericRestConnector(), workbenchService: service, artifactTransfer, credentialService: providerCredentialService, adapterRegistry })
    : null);
  const providerConnectionTester = providedProviderConnectionTester ?? createProviderConnectionTester({ providerRegistry, adapterRegistry });
  registerAppResource(
    server,
    "IMVIA Studio 会话桥",
    BRIDGE_RESOURCE_URI,
    { description: "Routes workbench submissions into the current Codex conversation using MCP Apps ui/message." },
    async () => ({
      contents: [{
        uri: BRIDGE_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: buildConversationBridgeHtml(),
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );
  server.registerTool(
    "imvia_health",
    {
      description: "Read IMVIA Studio MCP health. Does not inspect, call, or modify Lovart.",
      inputSchema: {},
    },
    async () => toMcpResponse(healthResponse(httpService)),
  );
  registerAppTool(
    server,
    "imvia_open_workbench",
    {
      description: "Use only when the user asks for the IMVIA Studio plugin's web workbench. Return its local URL for Codex's right-side browser panel. Do not use this tool for Imvia Layer or UI/poster layer splitting.",
      inputSchema: z.object({}).strict(),
      _meta: { ui: { resourceUri: BRIDGE_RESOURCE_URI, visibility: ["model", "app"] }, "openai/widgetAccessible": true },
    },
    async () => {
      const session = await bridgeService.openSession();
      const workbenchUrl = httpService?.workbench_url || httpService?.workbenchUrl || `http://127.0.0.1:${httpService?.port ?? configuredPort()}/workbench?imvia=live`;
      const workbenchUrlWithSession = new URL(workbenchUrl);
      workbenchUrlWithSession.searchParams.set("session", session.session_id);
      workbenchUrlWithSession.searchParams.set("bridge_token", session.open_token);
      const onboarding = typeof onboardingService?.ensureStarted === "function" ? await onboardingService.ensureStarted() : null;
      let submissionCursor = null;
      if (typeof service?.getState === "function") {
        const state = await service.getState({ include: ["jobs"] });
        submissionCursor = state.jobs?.at(-1)?.id ?? null;
      }
      workbenchUrlWithSession.searchParams.set("submission_cursor", submissionCursor ?? "");
      return toMcpResponse({
        api_version: "1",
        ok: true,
        data: {
          workbench_url: workbenchUrlWithSession.toString(),
          placement: "right",
          mode: "live",
          workbench_state: "ready",
          bridge_state: "mounting",
          bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
          workbench_session_id: session.session_id,
          open_token: session.open_token,
          submission_cursor: submissionCursor,
          ...(onboarding ? { onboarding } : {}),
        },
      });
    },
  );
  const bridgeMeta = { ui: { resourceUri: BRIDGE_RESOURCE_URI, visibility: ["app"] } };
  registerAppTool(server, "imvia_register_conversation_bridge", {
    description: "Register the MCP Apps conversation bridge for the current workbench session.",
    inputSchema: z.object({ session_id: z.string().min(1), open_token: z.string().min(1), bridge_id: z.string().min(1), connected_at: z.string().optional() }).strict(),
    _meta: { ui: bridgeMeta.ui },
  }, bridgeResponse((input) => bridgeService.registerBridge({ session_id: input.session_id, open_token: input.open_token, bridge_id: input.bridge_id, connected_at: input.connected_at })));
  registerAppTool(server, "imvia_heartbeat_conversation_bridge", {
    description: "Keep the current MCP Apps conversation bridge alive.",
    inputSchema: z.object({ session_id: z.string().min(1), bridge_id: z.string().min(1) }).strict(),
    _meta: { ui: bridgeMeta.ui },
  }, bridgeResponse((input) => bridgeService.heartbeat(input)));
  registerAppTool(server, "imvia_claim_next_workbench_dispatch", {
    description: "Claim the next durable workbench message for this conversation bridge.",
    inputSchema: z.object({ session_id: z.string().min(1), bridge_id: z.string().min(1) }).strict(),
    _meta: { ui: bridgeMeta.ui },
  }, bridgeResponse((input) => bridgeService.claimNext(input)));
  registerAppTool(server, "imvia_mark_dispatch_host_accepted", {
    description: "Record that the Codex host accepted a workbench message sent through ui/message.",
    inputSchema: z.object({ dispatch_id: z.string().min(1), session_id: z.string().min(1), bridge_id: z.string().min(1), claim_token: z.string().min(1) }).strict(),
    _meta: { ui: bridgeMeta.ui },
  }, bridgeResponse((input) => bridgeService.markHostAccepted(input)));
  registerAppTool(server, "imvia_release_dispatch_claim", {
    description: "Release a failed workbench message delivery so it can be retried.",
    inputSchema: z.object({ dispatch_id: z.string().min(1), session_id: z.string().min(1), bridge_id: z.string().min(1), claim_token: z.string().min(1), error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional() }).strict(),
    _meta: { ui: bridgeMeta.ui },
  }, bridgeResponse((input) => bridgeService.releaseClaim(input)));
  registerAppTool(server, "imvia_get_bridge_status", {
    description: "Read the current conversation bridge status for the workbench.",
    inputSchema: z.object({ session_id: z.string().min(1) }).strict(),
    _meta: { ui: bridgeMeta.ui },
  }, bridgeResponse((input) => bridgeService.getSessionStatus(input)));
  if (typeof service?.getState === "function" && typeof service?.createWorkbenchSubmission === "function") {
    server.registerTool("imvia_wait_for_workbench_submission", {
      description: "Deprecated compatibility reader for older clients. It observes local submissions but does not represent host delivery; use the MCP Apps conversation bridge instead.",
      inputSchema: z.object({
        after_job_id: z.string().min(1).nullable(),
        timeout_ms: z.number().int().min(0).max(30_000).optional(),
      }).strict(),
    }, domainResponse(async ({ after_job_id: afterJobId, timeout_ms: timeoutMs = 30_000 }, extra) => {
      const reportProgress = createMcpProgressReporter(extra);
      const deadline = Date.now() + timeoutMs;
      do {
        const state = await service.getState({ include: ["jobs"] });
        const jobs = Array.isArray(state.jobs) ? state.jobs : [];
        const cursorIndex = afterJobId == null ? -1 : jobs.findIndex((job) => job.id === afterJobId);
        if (afterJobId != null && cursorIndex < 0) throw new DomainError("NOT_FOUND", "The workbench submission cursor is no longer available.", { after_job_id: afterJobId });
        const submitted = jobs.slice(cursorIndex + 1).find((job) => job.submission_kind === "workbench_generation" && job.activation?.source === "workbench_action");
        if (submitted) {
          await reportProgress({ phase: "received", status: submitted.status, message: "已收到工作台任务，正在准备调用 Lovart。" });
          return {
            submitted: true,
            job_id: submitted.id,
            status: submitted.status,
            status_message: submitted.status_message ?? "已收到工作台任务，正在准备调用 Lovart。",
            progress: submitted.progress ?? null,
            delivery_state: "legacy_observer",
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
  }, lovartResponse(() => (typeof onboardingService?.replace === "function"
    ? onboardingService.replace()
    : typeof onboardingService?.retry === "function"
      ? onboardingService.retry()
      : generationService.connect())));
  server.registerTool("imvia_disconnect_lovart", {
    description: "Explicitly disconnect the independent IMVIA Lovart credential. This deletes only the IMVIA-owned credential item.",
    inputSchema: z.object({}).strict(),
  }, lovartResponse(() => onboardingService.disconnect()));
  server.registerTool("imvia_lovart_status", {
    description: "Read the redacted local Lovart connection status without opening a dialog or returning credentials.",
    inputSchema: z.object({}).strict(),
  }, lovartResponse(() => credentialService.status()));
  server.registerTool("imvia_list_providers", {
    description: "List redacted registered providers and models. This never exposes credentials and does not alter Lovart's dedicated connection flow.",
    inputSchema: z.object({ mode: z.enum(["image", "video"]).optional() }).strict(),
  }, domainResponse(({ mode }) => ({ providers: providerRegistry.list().filter((provider) => !mode || provider.capabilities.includes(mode)).map((provider) => ({ id: provider.id, display_name: provider.display_name, kind: provider.kind, capabilities: provider.capabilities, models: provider.models, credential_fields: provider.credential_fields })) })));
  server.registerTool("imvia_list_provider_connections", {
    description: "List redacted external provider connection metadata. Credentials are never returned.",
    inputSchema: z.object({}).strict(),
  }, domainResponse(async () => ({ connections: (await connectionStore.list()).map((connection) => ({
    connection_id: connection.connection_id,
    name: connection.name,
    provider_id: connection.provider_id,
    legacy: connection.legacy === true,
    capabilities: connection.capabilities ?? [],
    status: typeof connection.status === "string" ? connection.status : undefined,
    protocol: typeof connection.protocol === "string" ? connection.protocol : undefined,
    adapter: connection.adapter_id ? { id: connection.adapter_id, ...(connection.adapter_version ? { version: connection.adapter_version } : {}) } : undefined,
    catalog: connection.model_catalog ? {
      ...(typeof connection.model_catalog.digest === "string" ? { digest: connection.model_catalog.digest } : {}),
      ...(typeof connection.model_catalog.discovered_at === "string" ? { discovered_at: connection.model_catalog.discovered_at } : {}),
      models: Array.isArray(connection.model_catalog.models) ? connection.model_catalog.models.flatMap((model) => typeof model?.id === "string" ? [{ id: model.id, name: typeof model.display_name === "string" && model.display_name ? model.display_name : model.id, capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter((item) => item === "image" || item === "video") : [], compatibility: ["confirmed", "unconfirmed", "unsupported"].includes(model.compatibility) ? model.compatibility : "unsupported" }] : []) : [],
    } : undefined,
    enabled: connection.enabled === true,
    config_revision: connection.config_revision,
    last_test: connection.last_test ? { status: connection.last_test.status, code: connection.last_test.code, tested_at: connection.last_test.tested_at } : undefined,
  })) })));
  server.registerTool("imvia_test_provider_connection", {
    description: "Test one external provider connection using its locally stored credential profile. Credential values never enter MCP arguments or results.",
    inputSchema: z.object({ connection_id: z.string().min(1) }).strict(),
  }, domainResponse(async ({ connection_id }) => {
    const connection = await connectionStore.get(connection_id);
    if (!connection) throw new DomainError("NOT_FOUND", "The provider connection does not exist.", { connection_id });
    const credential = await providerCredentialService.read({ credential_ref: connection.credential_ref });
    const result = await providerConnectionTester({ connection, credential, providerExecutionRouter });
    const tested = await connectionStore.markTested(connection_id, { status: result?.status ?? (result?.accepted ? "connected" : "failed"), code: result?.code ?? "CONNECTION_TEST_FAILED" });
    return { status: tested.last_test.status, code: tested.last_test.code, tested_at: tested.last_test.tested_at };
  }));
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
    }, lovartResponse((input, extra) => orchestrator.submit(input, { onProgress: createMcpProgressReporter(extra) })));
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
    }, lovartResponse((input, extra) => orchestrator.followUp(input, { onProgress: createMcpProgressReporter(extra) })));
    server.registerTool("imvia_confirm_generation", {
      description: "Confirm one pending Lovart job only after explicit current-session acceptance with the exact cost binding.",
      inputSchema: z.object({ job_id: z.string().min(1), attempt: z.number().int().positive(), cost_fingerprint: z.string().regex(/^[0-9a-f]{64}$/), decision_id: z.string().min(1) }).strict(),
    }, lovartResponse((input, extra) => orchestrator.confirm(input, { onProgress: createMcpProgressReporter(extra) })));
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
    }, lovartResponse((input, extra) => generationService.generate(input, { onProgress: createMcpProgressReporter(extra) })));
    server.registerTool("imvia_confirm_generation", {
      description: "Confirm a pending high-cost Lovart operation only after the user explicitly accepts the displayed cost.",
      inputSchema: z.object({ thread_id: z.string().min(1) }).strict(),
    }, lovartResponse((input) => generationService.confirm(input)));
  }
  server.registerTool("imvia_execute_workbench_submission", {
    description: "Execute the exact immutable task previously submitted by the IMVIA workbench through its frozen provider. Lovart remains isolated in its dedicated adapter path.",
    inputSchema: z.object({ job_id: z.string().min(1), snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  }, domainResponse(async (input, extra) => {
    if (!providerExecutionRouter?.executePrepared) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider execution router is unavailable.");
    return providerExecutionRouter.executePrepared({ job_id: input.job_id, snapshot_digest: input.snapshot_digest, onProgress: createMcpProgressReporter(extra) });
  }));
  server.registerTool("imvia_confirm_provider_cost", {
    description: "Accept the exact current external-provider cost estimate and resume one frozen pre-submit attempt.",
    inputSchema: z.object({ job_id: z.string().min(1), attempt: z.number().int().positive(), cost_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), decision_id: z.string().min(1) }).strict(),
  }, domainResponse(async (input, extra) => {
    if (!providerExecutionRouter?.confirm) throw new DomainError("CONTEXT_UNAVAILABLE", "Provider execution router is unavailable.");
    return providerExecutionRouter.confirm({ ...input, onProgress: createMcpProgressReporter(extra) });
  }));
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
      status_message: z.string().trim().min(1).max(256).optional(),
      progress: z.record(z.unknown()).optional(),
    },
  }, domainResponse(async (input) => { const result = await service.updateJob(input); return { job_id: result.job.id, status: result.job.status, status_message: result.job.status_message, progress: result.job.progress, attempt: result.job.attempt, estimated_cost: result.job.estimated_cost, lovart_thread_id: result.job.lovart_thread_id, lovart_thread_source: result.job.lovart_thread_source ?? null }; }));
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
  const providerRegistry = createDefaultProviderRegistry();
  const connectionStore = createConnectionStore({ dataDirectory: stateDirectory, registry: providerRegistry });
  const service = createWorkbenchService({ dataDirectory: stateDirectory, providerRegistry, connectionStore });
  const bridgeService = createBridgeSessionService({ dataDirectory: stateDirectory });
  const probeService = createProductionProbeService(stateDirectory);
  const credentialService = createCredentialService();
  const generationService = createGenerationService({ credentialService });
  const onboardingService = createOnboardingService({
    credentialService,
    connect: ({ onState }) => generationService.connect({ onState }),
  });
  const projectContextService = createProjectContextService({ workbenchService: service, generationService });
  const artifactTransfer = createArtifactTransfer({ dataDirectory: stateDirectory, workspaceDirectory: WORKBENCH_DIRECTORY });
  const orchestrator = createGenerationOrchestrator({ projectContextService, workbenchService: service, generationService, artifactTransfer });
  const providerCredentialService = createProviderCredentialService({
    helperClient: createHelperClient({ resolveHelper: () => resolveCredentialHelper({ pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), platform: process.platform, arch: process.arch }) }),
  });
  const safeRequest = safeProviderJsonRequest;
  const adapterRegistry = createAdapterRegistry({ adapters: [createOpenAiCompatibleImagesAdapter({ request: safeRequest })] });
  const discoveryService = createProviderDiscoveryService({ adapterRegistry });
  const providerConnectionService = createProviderConnectionService({ connectionStore, credentialService: providerCredentialService, discoveryService, adapterRegistry });
  const providerExecutionRouter = createProviderExecutionRouter({ registry: providerRegistry, connectionStore, lovartOrchestrator: orchestrator, genericConnectorFactory: () => createGenericRestConnector(), workbenchService: service, artifactTransfer, credentialService: providerCredentialService, adapterRegistry });
  const providerConnectionTester = createProviderConnectionTester({ providerRegistry, adapterRegistry });
  const http = await startWorkbenchHttpServer({
    service,
    dataDirectory: stateDirectory,
    projectContextService,
    orchestrator,
    bridgeService,
    port: configuredPort(),
    lovartConnection: onboardingService,
    providerRegistry,
    connectionStore,
    providerCredentialService,
    providerConnectionService,
    providerExecutionRouter,
    providerConnectionTester,
  });
  const httpService = { port: Number.parseInt(new URL(http.url).port, 10), url: http.url, workbench_url: http.workbenchUrl };
  const server = createServer({ service, probeService, credentialService, generationService, onboardingService, projectContextService, artifactTransfer, orchestrator, bridgeService, httpService, dataDirectory: stateDirectory, providerRegistry, connectionStore, providerCredentialService, providerConnectionService, adapterRegistry, discoveryService, providerExecutionRouter, providerConnectionTester });
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
