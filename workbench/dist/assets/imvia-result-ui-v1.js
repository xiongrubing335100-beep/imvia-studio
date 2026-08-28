const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
}[character]));

const icon = (name) => ({
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2"/></svg>',
  enlarge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 9 6-9 6Z"/></svg>',
  library: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM12 8v8m-4-4h8"/></svg>',
}[name]);

export function artifactKind(artifact) {
  if (artifact?.kind === "video") return "video";
  if (artifact?.kind === "audio") return "audio";
  return "image";
}

export function resultLayoutClass(count) {
  return `irw-results ${Number(count) === 1 ? "single" : "multiple"}`;
}

export function shouldRenderResultOverlay(artifacts) {
  return Array.isArray(artifacts) && artifacts.some((artifact) => artifact?.id);
}

export function simplifyEmptyResultPanel(panel) {
  const state = panel?.querySelector?.(".live-job-state.empty, .live-job-state.queued");
  if (!state) return { applied: false, removed: 0 };
  const label = state.querySelector?.("small");
  if (label && label.textContent !== "暂无任何结果") label.textContent = "暂无任何结果";
  let removed = 0;
  for (const selector of ["h2", "p", "button.primary-small"]) {
    const node = state.querySelector?.(selector);
    if (node) { node.remove?.(); removed += 1; }
  }
  return { applied: true, removed };
}

export function createResultPanelMutationHandler({
  isFreshSession,
  getPanel,
  getCurrentState,
  getResultRoot,
  isRendering,
  scheduleRender,
} = {}) {
  return (mutations = []) => {
    const simplified = isFreshSession?.()
      ? simplifyEmptyResultPanel(getPanel?.())
      : { applied: false, removed: 0 };
    const state = getCurrentState?.();
    const renderScheduled = Boolean(
      !isRendering?.()
      && state?.artifacts?.length
      && mutationTouchesOutsideResult(Array.from(mutations), getResultRoot?.()),
    );
    if (renderScheduled) scheduleRender?.(state);
    return { simplified, renderScheduled };
  };
}

export function resultActionsVisibilitySelector(rootId) {
  return `#${rootId} .irw-media-actions.always-visible`;
}

export function resultWorkspaceOverrides(rootId) {
  const root = `#${rootId}`;
  return `${root} .irw-body:has(> .irw-empty){display:grid;place-items:center;overflow:hidden}
${root} .irw-body:has(> .irw-empty) .irw-empty{min-height:0}
${root} .irw-body:has(.irw-results.single){display:grid;grid-template-rows:minmax(0,1fr) auto;overflow:hidden}
${root} .irw-body:has(.irw-results.single) .irw-results.single{min-height:0;height:100%}
${root} .irw-body:has(.irw-results.single) .irw-card{min-height:0;height:100%}
${root} .irw-body:has(.irw-results.single) .irw-preview{min-height:0;height:100%}
${root} .irw-icon-button{background:rgba(8,11,13,.58);box-shadow:none}
${root} .irw-icon-button:hover{background:rgba(21,56,59,.68);box-shadow:none}`;
}

export function artifactsAfterSubmissionCursor(state, cursor) {
  const artifacts = Array.isArray(state?.artifacts) ? state.artifacts.filter((artifact) => artifact?.id) : [];
  if (cursor == null) return artifacts;
  const jobs = Array.isArray(state?.jobs) ? state.jobs.filter((job) => job?.id) : [];
  const cursorIndex = cursor === "" ? -1 : jobs.findIndex((job) => job.id === cursor);
  if (cursor !== "" && cursorIndex < 0) return [];
  const visibleJobIds = new Set(jobs.slice(cursorIndex + 1).map((job) => job.id));
  return artifacts.filter((artifact) => visibleJobIds.has(artifact.job_id));
}

export function jobsAfterSubmissionCursor(state, cursor) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs.filter((job) => job?.id) : [];
  if (cursor == null) return jobs;
  const cursorIndex = cursor === "" ? -1 : jobs.findIndex((job) => job.id === cursor);
  if (cursor !== "" && cursorIndex < 0) return [];
  return jobs.slice(cursorIndex + 1);
}

export function lovartGenerationPresentation(job) {
  // Legacy callers explicitly ask for the Lovart presentation. The generic
  // workspace calls generationPresentation directly with the frozen job.
  return generationPresentation({ ...job, snapshot: { ...(job?.snapshot || {}), provider_id: "lovart" } }, { providerLabel: "Lovart" });
}

function providerId(job) {
  return job?.snapshot?.provider_id ?? job?.provider_id ?? "lovart";
}

export function redactedProviderMetadata(job) {
  const snapshot = job?.snapshot && typeof job.snapshot === "object" ? job.snapshot : {};
  const id = typeof snapshot.provider_id === "string" && snapshot.provider_id.trim()
    ? snapshot.provider_id.trim()
    : typeof job?.provider_id === "string" && job.provider_id.trim() ? job.provider_id.trim() : "lovart";
  const declared = snapshot.provider && typeof snapshot.provider === "object" ? snapshot.provider : {};
  const label = typeof snapshot.provider_label === "string" && snapshot.provider_label.trim()
    ? snapshot.provider_label.trim()
    : typeof declared.display_name === "string" && declared.display_name.trim()
      ? declared.display_name.trim()
      : id === "lovart" ? "Lovart" : "提供商";
  const metadata = { provider_id: id, provider_label: label };
  const connectionId = typeof snapshot.connection_id === "string" && snapshot.connection_id.trim()
    ? snapshot.connection_id.trim()
    : typeof job?.connection_id === "string" && job.connection_id.trim() ? job.connection_id.trim() : null;
  if (connectionId) metadata.connection_id = connectionId;
  const model = typeof snapshot.model === "string" && snapshot.model.trim() ? snapshot.model.trim() : null;
  if (model) metadata.model = model;
  return metadata;
}

export function generationPresentation(job, { providerLabel } = {}) {
  const busy = ["queued_for_agent", "uploading", "submitted", "generating"].includes(job?.status);
  if (!busy) return { busy: false, label: null };
  const providerName = typeof providerLabel === "string" && providerLabel.trim() ? providerLabel.trim() : "提供商";
  const label = providerId(job) === "lovart" || providerName === "Lovart" ? "Lovart生成中..." : `${providerName}生成中...`;
  return { busy: true, label };
}

export function renderProviderLoading({ providerLabel = "提供商" } = {}) {
  const providerName = typeof providerLabel === "string" && providerLabel.trim() ? providerLabel.trim() : "提供商";
  const label = providerName === "Lovart" ? "Lovart生成中..." : `${providerName}生成中...`;
  return `<div class="irw-body"><div class="irw-empty irw-loading"><span class="irw-loading-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span></div></div>`;
}

// The only continuation endpoint exposed by the current workbench service is
// the Lovart continuation endpoint. Treat that built-in route as Lovart's
// explicit declaration; generic providers must not be sent through it.
export function providerSupportsContinuation(job) {
  return providerId(job) === "lovart" && job?.snapshot?.continuation_supported !== false;
}

export function resolveSessionSubmissionCursor({ urlCursor, sessionId, previousCursor, state }) {
  if (urlCursor != null) return urlCursor;
  if (!sessionId) return null;
  if (previousCursor !== undefined) return previousCursor;
  const jobs = Array.isArray(state?.jobs) ? state.jobs.filter((job) => job?.id) : [];
  return jobs.at(-1)?.id ?? "";
}

export function resetFreshCreator(root) {
  const textarea = root?.querySelector?.('.prompt-box textarea[aria-label="创意描述"]');
  if (!textarea) return { ready: false, referencesCleared: false, promptCleared: false };
  const clearReferences = Array.from(root.querySelectorAll?.(".references-section .text-action") || [])
    .find((button) => button.textContent?.replace(/\s+/gu, "").includes("清空全部"));
  clearReferences?.click?.();
  const view = textarea.ownerDocument?.defaultView || globalThis;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement?.prototype || {}, "value")?.set;
  if (setter) setter.call(textarea, ""); else textarea.value = "";
  const EventConstructor = view.Event || globalThis.Event;
  textarea.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  return { ready: true, referencesCleared: Boolean(clearReferences), promptCleared: true };
}

export function renderFreshResultPlaceholder() {
  return '<div class="irw-body"><div class="irw-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m5 17 4.5-4.5 3 3 2-2L19 18"/></svg><span>你的创作结果将在这里显示</span></div></div>';
}

export function renderLovartLoading() {
  return renderProviderLoading({ providerLabel: "Lovart" });
}

export function renderResultCards(artifacts, selectedId, contentUrl, { providerMetadata = null } = {}) {
  const providerLabel = typeof providerMetadata?.provider_label === "string" ? providerMetadata.provider_label : null;
  const providerId = typeof providerMetadata?.provider_id === "string" ? providerMetadata.provider_id : null;
  const connectionId = typeof providerMetadata?.connection_id === "string" ? providerMetadata.connection_id : null;
  const model = typeof providerMetadata?.model === "string" ? providerMetadata.model : null;
  const providerMetaValues = [providerLabel, providerId, connectionId, model].filter(Boolean).map(escapeHtml);
  const providerMeta = providerMetaValues.length ? `<div class="irw-card-provider" data-provider-id="${escapeHtml(providerId || "provider")}"${connectionId ? ` data-connection-id="${escapeHtml(connectionId)}"` : ""}>${providerMetaValues.join(" · ")}</div>` : "";
  return artifacts.map((artifact) => {
    const kind = artifactKind(artifact);
    const id = escapeHtml(artifact.id);
    const source = escapeHtml(contentUrl(artifact.id));
    const noun = kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片";
    const preview = kind === "video"
      ? `<video src="${source}" preload="metadata" playsinline></video>`
      : kind === "audio"
        ? `<audio src="${source}" controls preload="metadata"></audio>`
        : `<img src="${source}" alt="生成图片" loading="lazy">`;
    const previewAction = kind === "image" ? "放大" : "播放";
    const previewIcon = kind === "image" ? "enlarge" : "play";
    const selectedClass = artifact.id === selectedId ? " selected" : "";
    return `<article class="irw-card${selectedClass}" data-artifact-id="${id}" tabindex="0"><div class="irw-preview">${preview}<div class="irw-media-actions always-visible"><a class="irw-icon-button" data-action="download" href="${source}" download aria-label="下载${noun}" title="下载">${icon("download")}</a><button class="irw-icon-button" type="button" data-action="preview" aria-label="${previewAction}${noun}" title="${previewAction}">${icon(previewIcon)}</button><button class="irw-icon-button" type="button" data-action="library" aria-label="加入素材库" title="加入素材库">${icon("library")}</button></div></div>${providerMeta}</article>`;
  }).join("");
}

export function mergeLibraryArtifact(items, artifact, src, providerMetadata = null) {
  const safeItems = Array.isArray(items) ? items.filter((item) => item?.artifact_id) : [];
  if (!artifact?.id || safeItems.some((item) => item.artifact_id === artifact.id)) return safeItems;
  const kind = artifactKind(artifact);
  const mimeType = typeof artifact.mime_type === "string" && artifact.mime_type ? artifact.mime_type : kind === "video" ? "video/mp4" : "image/png";
  const format = (mimeType.split("/")[1] || kind).replace("jpeg", "jpg").toUpperCase();
  const noun = kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片";
  const providerLabel = typeof providerMetadata?.provider_label === "string" && providerMetadata.provider_label.trim()
    ? providerMetadata.provider_label.trim()
    : "Lovart";
  return [{
    id: `imvia-result-${artifact.id}`,
    artifact_id: artifact.id,
    kind,
    mime_type: mimeType,
    name: `生成${noun} ${artifact.id}`,
    tag: "@生成结果",
    meta: `${format} · ${providerLabel} 生成`,
    src,
  }, ...safeItems];
}

export function renderResultBody({ cards, followUp = "", count = 1 }) {
  return `<div class="irw-body"><div class="${resultLayoutClass(count)}">${cards}</div>${followUp}</div>`;
}

export function mutationTouchesOutsideResult(mutations, root) {
  if (!root || !Array.isArray(mutations)) return true;
  return mutations.some((mutation) => !root.contains(mutation?.target));
}

export function resultRenderSignature(state, selectedArtifactId, pending) {
  return JSON.stringify({
    selected_artifact_id: selectedArtifactId ?? null,
    pending: Boolean(pending),
    jobs: (state?.jobs || []).map((job) => ({
      id: job.id,
      status: job.status,
      lovart_project_id: job.lovart_project_id ?? job.snapshot?.lovart_project_id ?? null,
      provider: redactedProviderMetadata(job),
    })),
    artifacts: (state?.artifacts || []).map((artifact) => ({
      id: artifact.id,
      job_id: artifact.job_id,
      kind: artifact.kind,
      mime_type: artifact.mime_type,
    })),
  });
}
