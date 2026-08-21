import { createLovartClient } from "./client.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLLS = 60;

function stableError(error) {
  const result = new Error(typeof error?.message === "string" ? error.message : "Lovart upstream is unavailable");
  result.code = typeof error?.code === "string" ? error.code : "UPSTREAM_UNAVAILABLE";
  return result;
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

  async function connect() {
    const connection = await credentialService.connect();
    if (connection.status !== "connected") return connection;
    try {
      const client = await clientForOperation();
      await client.queryMode();
      return { ...connection, lovart: { reachable: true } };
    } catch (error) {
      const safe = stableError(error);
      return {
        status: "not_connected",
        code: safe.code,
        message: safe.message,
      };
    }
  }

  async function pollResult(client, threadId, projectId) {
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const state = await client.status({ thread_id: threadId });
      if (state?.status === "abort") return { thread_id: threadId, project_id: projectId, final_status: "abort", items: [] };
      if (state?.status === "done") {
        const result = await client.result({ thread_id: threadId });
        const finalStatus = result?.pending_confirmation ? "pending_confirmation" : "done";
        return { ...result, thread_id: threadId, project_id: projectId, final_status: finalStatus };
      }
      await sleep(pollIntervalMs);
    }
    return { thread_id: threadId, project_id: projectId, final_status: "timeout", items: [] };
  }

  async function generate(input) {
    let client;
    try {
      client = await clientForOperation();
      const sent = await client.send(input);
      if (typeof sent?.thread_id !== "string" || !sent.thread_id) throw new Error("Lovart did not return a thread");
      return await pollResult(client, sent.thread_id, sent.project_id || input.project_id || null);
    } catch (error) {
      throw stableError(error);
    }
  }

  async function resume({ thread_id: threadId, project_id: projectId = null }) {
    if (typeof threadId !== "string" || !threadId) throw new Error("Lovart thread is required");
    try {
      return await pollResult(await clientForOperation(), threadId, projectId);
    } catch (error) {
      throw stableError(error);
    }
  }

  async function confirm(input) {
    let client;
    try {
      client = await clientForOperation();
      const confirmed = await client.confirm({ thread_id: input.thread_id });
      return await pollResult(client, input.thread_id, confirmed?.project_id || null);
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
