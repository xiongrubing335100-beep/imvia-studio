import { createHash } from "node:crypto";

function text(value, fallback = "未提供") {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function modeLabel(mode) {
  return mode === "video" ? "视频生成" : "图片生成";
}

function countLabel(settings) {
  if (settings?.count_mode === "auto") return "Auto";
  return Number.isInteger(settings?.count) && settings.count > 0 ? `${settings.count}个` : null;
}

function referenceLabel(reference, index) {
  const label = text(reference?.display || reference?.label, "");
  return label || `${reference?.kind === "video" ? "视频" : reference?.kind === "audio" ? "音频" : "图片"}${index + 1}`;
}

function providerMetadata(snapshot) {
  const providerId = text(snapshot?.provider_id, "lovart");
  const providerLabel = text(snapshot?.provider_label, providerId === "lovart" ? "Lovart" : providerId);
  const connectionId = providerId === "lovart" ? null : text(snapshot?.connection_id, "未提供");
  const connectionConfigRevision = providerId === "lovart" ? null : snapshot?.connection_config_revision ?? null;
  return { providerId, providerLabel, connectionId, connectionConfigRevision, isLovart: providerId === "lovart" };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function snapshotDigest(snapshot) {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

export function buildWorkbenchTaskMessage({ jobId, dispatchId, workbenchSessionId, snapshot, digest }) {
  const provider = providerMetadata(snapshot);
  const references = Array.isArray(snapshot?.references)
    ? snapshot.references.map(referenceLabel).join("、")
    : Array.isArray(snapshot?.reference_ids) ? snapshot.reference_ids.join("、") : "无";
  const settings = snapshot?.settings && typeof snapshot.settings === "object"
    ? [snapshot.settings.ratio, snapshot.settings.resolution, countLabel(snapshot.settings)]
      .filter(Boolean).join(" · ")
    : "未提供";
  const project = provider.isLovart
    ? text(snapshot?.project_locator || snapshot?.lovart_project_id, "自动选择项目")
    : "不适用（外部 API）";
  const prompt = text(snapshot?.prompt?.text, "未提供");
  const taskType = snapshot?.mode === "video" ? "video.generate" : "image.generate";
  return [
    "【IMVIA Studio 工作台提交】",
    "任务已从当前工作台提交到本 Codex 会话。",
    "schema_version: imvia.workbench-task.v1",
    `job_id: ${text(jobId)}`,
    `dispatch_id: ${text(dispatchId)}`,
    `workbench_session_id: ${text(workbenchSessionId)}`,
    `task_type: ${taskType}`,
    "activation: workbench_action",
    `类型：${modeLabel(snapshot?.mode)}`,
    `提供方：${provider.providerLabel} (${provider.providerId})`,
    ...(provider.isLovart ? [] : [
      `API 连接：${provider.connectionId}`,
      `连接配置版本：${provider.connectionConfigRevision ?? "未提供"}`,
    ]),
    `模型：${text(snapshot?.model)}`,
    `项目：${project}`,
    `参考素材：${references}`,
    `设置：${settings}`,
    `创意描述：${prompt}`,
    `snapshot_digest: ${text(digest)}`,
    "",
    `请先回复“已收到工作台任务，正在准备调用 ${provider.providerLabel}”，然后`,
    "只能通过 imvia_execute_workbench_submission 使用上述精确 job_id 与 snapshot_digest 执行。",
    `执行期间必须保持冻结的提供方 ${provider.providerLabel} (${provider.providerId})；不得切换、回退或创建第二个任务。`,
    ...(provider.isLovart
      ? ["持续同步 Lovart 的上传、提交、生成、费用确认和结果导入状态。"]
      : [`这是外部 API 任务：不得调用任何 Lovart 工具或能力；持续同步 ${provider.providerLabel} 的提交、生成、费用确认和结果导入状态。`]),
  ].join("\n");
}

export function buildDispatchSummary(dispatch) {
  const snapshot = dispatch.snapshot || {};
  const provider = providerMetadata(snapshot);
  const references = Array.isArray(snapshot.references)
    ? snapshot.references.map((reference, index) => ({ id: reference?.id || `reference-${index + 1}`, label: referenceLabel(reference, index), kind: reference?.kind || "image" }))
    : [];
  return {
    schema_version: "imvia.workbench-task.v1",
    job_id: dispatch.job_id,
    dispatch_id: dispatch.id,
    id: dispatch.id,
    claim_token: dispatch.claim_token,
    workbench_session_id: dispatch.workbench_session_id,
    snapshot_digest: dispatch.snapshot_digest,
    task_type: dispatch.task_type,
    activation: { source: "workbench_action" },
    summary: {
      mode: snapshot.mode || null,
      model: snapshot.model || null,
      provider_id: provider.providerId,
      provider_label: provider.providerLabel,
      connection_id: provider.connectionId,
      connection_config_revision: provider.connectionConfigRevision,
      project_locator: snapshot.project_locator || snapshot.lovart_project_id || null,
      prompt: snapshot.prompt?.text || "",
      references,
      settings: snapshot.settings || {},
    },
    prompt: snapshot.prompt?.text || "",
    message: dispatch.message,
    submitted_at: dispatch.submitted_at,
  };
}
