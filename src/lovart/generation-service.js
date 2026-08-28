import { createLovartClient } from "./client.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLLS = 60;

function stableError(error) {
  const result = new Error(typeof error?.message === "string" ? error.message : "Lovart upstream is unavailable");
  result.code = typeof error?.code === "string" ? error.code : "UPSTREAM_UNAVAILABLE";
  if (typeof error?.operation === "string") result.operation = error.operation;
  if (Number.isInteger(error?.status)) result.status = error.status;
  if (error?.details && typeof error.details === "object" && !Array.isArray(error.details)) {
    result.details = JSON.parse(JSON.stringify(error.details));
  }
  return result;
}

async function reportProgress(onProgress, update) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress(Object.freeze({ ...update }));
  } catch {
    // Progress delivery is best effort and must never turn a successful
    // Lovart request into a failed generation.
  }
}

export function createGenerationService({
  credentialService,
  clientFactory = (credentials) => createLovartClient({ credentials }),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
} = {}) {
  if (!credentialService?.connect || !credentialService?.getCredentials) throw new TypeError("credentialService is required");

  async function clientForOperation() {
    const credentials = await credentialService.getCredentials();
    return clientFactory(credentials);
  }

  async function connect({ onState } = {}) {
    return credentialService.connect({
      onState,
      validate: async (credentials) => {
        try {
          await clientFactory(credentials).queryMode();
          return { accepted: true, code: "CONNECTED" };
        } catch (error) {
          const safe = stableError(error);
          return { accepted: false, code: safe.code, message: safe.message };
        }
      },
    });
  }

  async function pollResult(client, threadId, projectId, { onProgress } = {}) {
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const state = await client.status({ thread_id: threadId });
      const upstreamStatus = typeof state?.status === "string" ? state.status : "processing";
      await reportProgress(onProgress, {
        phase: "status",
        status: "generating",
        provider_status: upstreamStatus,
        progress: { current: attempt + 1, total: maxPolls },
        message: `Lovart 正在处理（${attempt + 1}/${maxPolls}）。`,
      });
      if (state?.status === "abort") {
        await reportProgress(onProgress, { phase: "aborted", status: "failed", message: "Lovart 已中止任务。" });
        return { thread_id: threadId, project_id: projectId, final_status: "abort", items: [] };
      }
      if (state?.status === "done") {
        await reportProgress(onProgress, { phase: "result", status: "generating", message: "Lovart 已完成处理，正在读取结果。" });
        const result = await client.result({ thread_id: threadId });
        const finalStatus = result?.pending_confirmation ? "pending_confirmation" : "done";
        await reportProgress(onProgress, {
          phase: finalStatus === "pending_confirmation" ? "awaiting_cost_confirmation" : "completed",
          status: finalStatus === "pending_confirmation" ? "awaiting_cost_confirmation" : "succeeded",
          message: finalStatus === "pending_confirmation" ? "Lovart 返回了费用确认，等待你的决定。" : "Lovart 已返回生成结果。",
        });
        return { ...result, thread_id: threadId, project_id: projectId, final_status: finalStatus };
      }
      await sleep(pollIntervalMs);
    }
    await reportProgress(onProgress, { phase: "timeout", status: "failed", message: "Lovart 状态查询超时。" });
    return { thread_id: threadId, project_id: projectId, final_status: "timeout", items: [] };
  }

  async function generate(input, { onProgress } = {}) {
    let client;
    try {
      await reportProgress(onProgress, { phase: "connecting", status: "uploading", message: "正在准备调用 Lovart。" });
      client = await clientForOperation();
      const sent = await client.send(input);
      if (typeof sent?.thread_id !== "string" || !sent.thread_id) throw new Error("Lovart did not return a thread");
      await reportProgress(onProgress, {
        phase: "submitted",
        status: "submitted",
        thread_id: sent.thread_id,
        message: "已通过 Lovart 提交任务，正在生成。",
      });
      return await pollResult(client, sent.thread_id, sent.project_id || input.project_id || null, { onProgress });
    } catch (error) {
      throw stableError(error);
    }
  }

  async function resume({ thread_id: threadId, project_id: projectId = null }, { onProgress } = {}) {
    if (typeof threadId !== "string" || !threadId) throw new Error("Lovart thread is required");
    try {
      await reportProgress(onProgress, { phase: "resuming", status: "generating", message: "正在恢复 Lovart 任务状态。" });
      return await pollResult(await clientForOperation(), threadId, projectId, { onProgress });
    } catch (error) {
      throw stableError(error);
    }
  }

  async function confirm(input, { onProgress } = {}) {
    let client;
    try {
      client = await clientForOperation();
      const confirmed = await client.confirm({ thread_id: input.thread_id });
      await reportProgress(onProgress, { phase: "confirmed", status: "generating", message: "费用已确认，Lovart 继续生成。" });
      return await pollResult(client, input.thread_id, confirmed?.project_id || null, { onProgress });
    } catch (error) {
      throw stableError(error);
    }
  }

  async function createProject(input) {
    try {
      return await (await clientForOperation()).createProject(input);
    } catch (error) {
      throw stableError(error);
    }
  }

  async function validateProject(input) {
    try {
      return await (await clientForOperation()).validateProject(input);
    } catch (error) {
      throw stableError(error);
    }
  }

  async function upload(input) {
    try {
      return await (await clientForOperation()).upload(input);
    } catch (error) {
      throw stableError(error);
    }
  }

  return Object.freeze({ connect, generate, resume, confirm, createProject, validateProject, upload });
}
