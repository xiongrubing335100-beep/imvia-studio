import { resolveVisualCaret, visualCaretPhase } from "./imvia-prompt-layout.js?v=2";
import { LOVART_IMAGE_MAX_BYTES, oversizedLovartImages, uploadWorkbenchReference } from "./imvia-upload-preflight-v1.js";
import { artifactKind, artifactsAfterSubmissionCursor, createResultPanelMutationHandler, generationPresentation, jobsAfterSubmissionCursor, mergeLibraryArtifact, providerSupportsContinuation, redactedProviderMetadata, renderResultBody, renderResultCards, resetFreshCreator, resolveSessionSubmissionCursor, resultActionsVisibilitySelector, resultRenderSignature, resultWorkspaceOverrides, shouldRenderResultOverlay, simplifyEmptyResultPanel } from "./imvia-result-ui-v1.js?v=9";
import { installImageCountAuto, serializeGenerationCount } from "./imvia-generation-count-v1.js?v=5";
import { installGenerationSettings, resolveGenerationModel, resolveGenerationRatio } from "./imvia-generation-settings-v1.js?v=3";
import { installModelAuto } from "./imvia-model-auto-v1.js?v=6";
import { installProviderSelector, serializeProviderSelection } from "./imvia-provider-connections-v1.js?v=3";
import { installAssetLibraryEnhancements } from "./imvia-asset-library-v1.js?v=9";

(() => {
  "use strict";
  const rootId = "imvia-live-result-workspace";
  const css = `
    #${rootId}{position:fixed;z-index:120;display:flex;flex-direction:column;overflow:hidden;background:#121518;border:1px solid #262c30;border-radius:16px;color:#f1f4f4;box-shadow:0 20px 70px #0009}
    #${rootId} .irw-head{height:64px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #20262a}
    #${rootId} .irw-head strong{font-size:16px}#${rootId} .irw-meta{display:flex;gap:8px;align-items:center;color:#92999d;font-size:11px}
    #${rootId} .irw-project{color:#57d6d8;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
    #${rootId} .irw-body{flex:1;min-height:0;padding:18px 20px 24px;overflow:auto;display:flex;flex-direction:column;gap:18px}
    #${rootId} .irw-results{display:grid;gap:14px;align-content:start}
    #${rootId} .irw-results.multiple{grid-template-columns:repeat(2,minmax(0,1fr))}
    #${rootId} .irw-results.single{grid-template-columns:minmax(0,min(100%,760px));justify-content:center}
    #${rootId} .irw-card{min-width:0;position:relative;border:1px solid #292f33;border-radius:11px;overflow:hidden;background:#0c0f11;cursor:pointer}
    #${rootId} .irw-card.selected{border-color:#57d6d8;box-shadow:inset 0 0 0 1px #57d6d8}
    #${rootId} .irw-card-provider{padding:8px 10px;color:#8c979a;font-size:10px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${rootId} .irw-preview{height:clamp(220px,38vh,440px);position:relative;display:grid;place-items:center;background:#080b0d;overflow:hidden}
    #${rootId} .irw-results.single .irw-preview{height:clamp(420px,67vh,820px)}
    #${rootId} .irw-preview img,#${rootId} .irw-preview video{width:100%;height:100%;object-fit:contain;display:block}
    #${rootId} .irw-preview audio{width:calc(100% - 26px)}
    #${rootId} .irw-media-actions{position:absolute;z-index:2;top:12px;right:12px;display:flex;gap:8px;opacity:0;transform:translateY(-4px);transition:opacity .18s ease,transform .18s ease}
    ${resultActionsVisibilitySelector(rootId)}{opacity:1;transform:none}
    #${rootId} .irw-card:hover .irw-media-actions,#${rootId} .irw-card:focus-within .irw-media-actions{opacity:1;transform:none}
    #${rootId} .irw-icon-button{width:36px;height:36px;padding:0;display:grid;place-items:center;border:1px solid #ffffff2b;border-radius:10px;background:#080b0ddd;color:#f4fbfb;text-decoration:none;box-shadow:0 5px 18px #0008;cursor:pointer;backdrop-filter:blur(10px)}
    #${rootId} .irw-icon-button:hover{border-color:#57d6d8;background:#15383b;color:#8ff7f8}
    #${rootId} .irw-icon-button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    #${rootId} .irw-follow{padding:16px;border:1px solid #293135;border-radius:11px;background:#151a1d}
    #${rootId} .irw-follow-label{display:flex;justify-content:space-between;align-items:center;color:#c9d0d1;font-size:12px}
    #${rootId} .irw-follow-label small{color:#778185;font-size:10px}#${rootId} textarea{width:100%;height:62px;margin-top:9px;padding:10px;border:1px solid #30383c;border-radius:9px;resize:vertical;outline:0;color:#e6ebec;background:#0e1315;font-size:12px;line-height:1.45}
    #${rootId} .irw-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:9px}#${rootId} button{height:32px;padding:0 12px;border:1px solid #30373b;border-radius:8px;background:#171b1f;color:#c9d1d2;font-size:11px}#${rootId} button.primary{border:0;background:#3f9095;color:#f2ffff;font-weight:600}#${rootId} button:disabled{opacity:.45;cursor:wait}
    #${rootId} .irw-empty{min-height:160px;display:flex;align-items:center;justify-content:center;gap:10px;text-align:center;color:#92999d;font-size:12px}
    #${rootId} .irw-empty svg{width:21px;height:21px;fill:none;stroke:#687377;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round}
    #${rootId} .irw-loading-spinner{width:22px;height:22px;border:2px solid #33585b;border-top-color:#66dadd;border-radius:50%;animation:irw-lovart-spin .8s linear infinite}
    .primary-action.imvia-lovart-generating{position:relative;pointer-events:none;color:transparent!important;font-size:0!important}
    .primary-action.imvia-lovart-generating::before{content:"";width:17px;height:17px;border:2px solid #dfffff66;border-top-color:#efffff;border-radius:50%;animation:irw-lovart-spin .8s linear infinite}
    .primary-action.imvia-lovart-generating::after{content:attr(data-imvia-lovart-label);color:#f1ffff;font-size:14px;font-weight:600}
    @keyframes irw-lovart-spin{to{transform:rotate(360deg)}}
    @media(max-width:900px){#${rootId} .irw-results.multiple{grid-template-columns:1fr}#${rootId} .irw-results.single .irw-preview{height:clamp(340px,62vh,680px)}}
    #imvia-result-preview{position:fixed;z-index:420;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#050708f2;color:#fff}
    #imvia-result-preview::backdrop{background:#000d}
    #imvia-result-preview .irw-lightbox-shell{width:100%;height:100%;padding:28px;display:grid;place-items:center;position:relative}
    #imvia-result-preview img,#imvia-result-preview video{max-width:calc(100vw - 56px);max-height:calc(100vh - 56px);object-fit:contain;display:block}
    #imvia-result-preview audio{width:min(680px,calc(100vw - 80px))}
    #imvia-result-preview .irw-lightbox-close{position:absolute;z-index:2;top:24px;right:24px;width:42px;height:42px;padding:0;border:1px solid #ffffff35;border-radius:50%;background:#0b1114dc;color:#fff;font-size:25px;line-height:1;cursor:pointer}
    #imvia-result-preview .irw-lightbox-actions{position:absolute;z-index:2;left:50%;bottom:24px;transform:translateX(-50%);display:flex;gap:10px}
    #imvia-result-preview .irw-lightbox-actions button{height:40px;padding:0 18px;border:1px solid #ffffff35;border-radius:11px;background:#132326e8;color:#efffff;font-size:12px;cursor:pointer;backdrop-filter:blur(10px)}
    .asset-grid .asset-card.imvia-generated-library-card video{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}
    #imvia-project-context{padding:16px 0;border-bottom:1px solid #20262a}
    #imvia-project-context .imvia-project-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    #imvia-project-context .imvia-project-head strong{font-size:15px;color:#f1f4f4}
    #imvia-project-context .imvia-project-head span{color:#92999d;font-size:11px}
    #imvia-project-context .imvia-project-row{display:flex;gap:8px;align-items:center}
    #imvia-project-context input{flex:1;min-width:0;height:40px;padding:0 12px;border:1px solid #2a3236;border-radius:10px;background:#171b1f;color:#e8eded;font-size:12px;outline:0}
    #imvia-project-context input:focus{border-color:#57d6d8;box-shadow:0 0 0 2px #57d6d82b}
    #imvia-project-context button{height:40px;padding:0 13px;border:0;border-radius:10px;background:#3f9095;color:#f2ffff;font-size:12px;font-weight:600;white-space:nowrap}
    #imvia-project-context button:disabled{opacity:.5;cursor:wait}
    #imvia-project-context .imvia-project-status{display:block;margin-top:8px;color:#778185;font-size:10px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #imvia-workbench-toast{position:fixed;z-index:240;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(560px,calc(100vw - 40px));min-height:42px;padding:10px 18px;border:1px solid #334044;border-radius:22px;background:#171c1f;color:#dce5e6;box-shadow:0 10px 40px #0008;font-size:12px;line-height:1.4;text-align:center}
    #imvia-workbench-toast.error{color:#f0b2b2;border-color:#71454a}
    .prompt-box textarea{caret-color:transparent!important}
    #imvia-prompt-visual-caret{position:fixed;z-index:230;width:1.5px;pointer-events:none;background:#ecffff;opacity:0;transform:translateX(-.5px);box-shadow:0 0 3px #57d6d8}
    #imvia-prompt-visual-caret.active{opacity:1}
    #imvia-prompt-visual-caret.active.blinking{animation:imvia-caret-blink 1.05s steps(1,end) infinite}
    @keyframes imvia-caret-blink{0%,48%{opacity:1}49%,100%{opacity:0}}
    ${resultWorkspaceOverrides(rootId)}
  `;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
  let current = null;
  let selectedArtifactId = null;
  let pendingKey = null;
  let lastRenderedSignature = null;
  let lastPanelTarget = null;
  let rendering = false;
  let projectLocator = "";
  let activeProject = null;
  let projectsLoaded = false;
  let projectLoading = false;
  let handoffPending = false;
  let promptCaretFrame = 0;
  let promptCaretTimer = 0;
  let lastPromptCaretInteractionAt = null;
  let capturedSubmissionCursor;
  let freshHydrationResetDone = false;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  const panel = () => document.querySelector(".live-result-panel");
  const stateUrl = "/api/v1/state?include=jobs,artifacts";
  const contentUrl = (id) => `/api/v1/artifacts/${encodeURIComponent(id)}/content`;
  const projectUrl = (id) => `https://www.lovart.ai/canvas?projectId=${encodeURIComponent(id)}`;
  const jobForArtifact = (state, artifact) => (state.jobs || []).find((job) => job.id === artifact.job_id) || state.jobs?.at(-1) || null;
  const libraryStorageKey = "imvia-studio:generated-library:v1";
  const isLiveWorkbench = () => new URLSearchParams(window.location.search).get("imvia") === "live";
  const randomKey = (prefix) => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workbenchSessionId = () => new URLSearchParams(window.location.search).get("session");
  const urlSubmissionCursor = () => { const params = new URLSearchParams(window.location.search); return params.has("submission_cursor") ? params.get("submission_cursor") : null; };
  const submissionCursor = (state) => {
    capturedSubmissionCursor = resolveSessionSubmissionCursor({ urlCursor: urlSubmissionCursor(), sessionId: workbenchSessionId(), previousCursor: capturedSubmissionCursor, state });
    return capturedSubmissionCursor;
  };
  const sessionHeaders = () => { const params = new URLSearchParams(window.location.search); const session = params.get("session"); const token = params.get("bridge_token"); return session ? { "x-imvia-workbench-session": session, ...(token ? { "x-imvia-workbench-token": token } : {}) } : {}; };
  const megabytes = (bytes) => `${(Number(bytes) / 1_000_000).toFixed(1)}MB`;

  async function apiJson(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error?.message || `请求失败（${response.status}）`);
      error.code = payload.error?.code || "UPSTREAM_UNAVAILABLE";
      throw error;
    }
    return payload.data ?? payload;
  }

  function showWorkbenchToast(message, error = false) {
    let toast = document.getElementById("imvia-workbench-toast");
    if (!toast) { toast = document.createElement("div"); toast.id = "imvia-workbench-toast"; document.body.appendChild(toast); }
    toast.className = error ? "error" : "";
    toast.textContent = message;
    window.clearTimeout(Number(toast.dataset.timer || 0));
    toast.dataset.timer = String(window.setTimeout(() => toast.remove(), 4200));
  }

  function readGeneratedLibrary() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(libraryStorageKey) || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => item?.artifact_id && item?.src) : [];
    } catch { return []; }
  }

  function writeGeneratedLibrary(items) {
    window.localStorage.setItem(libraryStorageKey, JSON.stringify(items));
  }

  function openMediaPreview({ src, kind = "image", name = "生成结果", libraryItem = null }) {
    document.getElementById("imvia-result-preview")?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "imvia-result-preview";
    const media = kind === "video"
      ? `<video src="${escapeHtml(src)}" controls autoplay playsinline></video>`
      : kind === "audio"
        ? `<audio src="${escapeHtml(src)}" controls autoplay></audio>`
        : `<img src="${escapeHtml(src)}" alt="${escapeHtml(name)}">`;
    const referenceActions = libraryItem
      ? `<div class="irw-lightbox-actions"><button type="button" data-reference-mode="image">用于图片创作</button><button type="button" data-reference-mode="video">用于视频创作</button></div>`
      : "";
    dialog.innerHTML = `<div class="irw-lightbox-shell"><button type="button" class="irw-lightbox-close" aria-label="关闭预览">×</button>${media}${referenceActions}</div>`;
    document.body.appendChild(dialog);
    dialog.querySelector(".irw-lightbox-close")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.querySelectorAll("[data-reference-mode]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await useLibraryItemAsReference(libraryItem, button.dataset.referenceMode); dialog.close(); }
      catch (error) { showWorkbenchToast(error.message || "素材添加失败", true); button.disabled = false; }
    }));
    dialog.showModal();
  }

  function addArtifactToLibrary(artifact, providerMetadata = null) {
    const items = mergeLibraryArtifact(readGeneratedLibrary(), artifact, contentUrl(artifact.id), providerMetadata);
    const existed = readGeneratedLibrary().some((item) => item.artifact_id === artifact.id);
    writeGeneratedLibrary(items);
    injectGeneratedLibrary();
    showWorkbenchToast(existed ? "该结果已在素材库中" : "已加入素材库");
  }

  function waitForElement(selector, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) { resolve(existing); return; }
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (!element) return;
        window.clearTimeout(timer); observer.disconnect(); resolve(element);
      });
      const timer = window.setTimeout(() => { observer.disconnect(); reject(new Error("创作区未能及时打开")); }, timeoutMs);
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function useLibraryItemAsReference(item, mode) {
    if (!item?.src) throw new Error("素材文件不可用");
    const response = await fetch(item.src, { cache: "no-store" });
    if (!response.ok) throw new Error("素材文件读取失败");
    const blob = await response.blob();
    const extension = (item.mime_type?.split("/")[1] || (item.kind === "video" ? "mp4" : "png")).replace("jpeg", "jpg");
    const filename = `${item.name || "生成素材"}.${extension}`;
    const file = new File([blob], filename, { type: item.mime_type || blob.type });
    window.location.hash = mode === "video" ? "video" : "image";
    const dropZone = await waitForElement(".references-section .reference-drop-zone");
    const transfer = new DataTransfer(); transfer.items.add(file);
    dropZone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    showWorkbenchToast(`${item.name} 已加入参考素材`);
  }

  function injectGeneratedLibrary() {
    const grid = document.querySelector(".assets-page .asset-grid:not(.empty-grid)");
    if (!grid) return;
    const items = readGeneratedLibrary();
    grid.querySelectorAll(".imvia-generated-library-card").forEach((node) => node.remove());
    for (const item of items) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "asset-card imvia-generated-library-card";
      card.dataset.artifactId = item.artifact_id;
      const media = item.kind === "video"
        ? `<video src="${escapeHtml(item.src)}" muted preload="metadata"></video>`
        : `<img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.name)}">`;
      card.innerHTML = `${media}<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.tag)}</span><small>${escapeHtml(item.meta)}</small>`;
      card.addEventListener("click", () => openMediaPreview({ src: item.src, kind: item.kind, name: item.name, libraryItem: item }));
      grid.prepend(card);
    }
  }

  function notifyOversizedImages(files) {
    const images = oversizedLovartImages(files);
    if (!images.length) return;
    const names = images.map((file) => file.name || "图片").join("、");
    showWorkbenchToast(`${names} 超过 ${megabytes(LOVART_IMAGE_MAX_BYTES)}；提交时会自动生成不超过 18MB 的上传副本，原图不会被覆盖。`);
  }
  document.addEventListener("change", (event) => notifyOversizedImages(event.target?.files), true);
  document.addEventListener("drop", (event) => notifyOversizedImages(event.dataTransfer?.files), true);

  function projectContextStatus(message = null, error = false) {
    const status = document.querySelector("#imvia-project-context .imvia-project-status");
    if (!status) return;
    status.textContent = message || (activeProject
      ? `当前项目：${activeProject.name || activeProject.project_id}`
      : "留空：首次生成会自动新建项目，之后沿用当前项目。");
    status.style.color = error ? "#e49b9b" : "";
  }

  function injectProjectContext() {
    if (!isLiveWorkbench() || (document.documentElement.dataset.imviaProvider || "lovart") !== "lovart") return;
    const scroll = document.querySelector(".creator-scroll");
    if (!scroll || scroll.querySelector("#imvia-project-context")) return;
    const section = document.createElement("section");
    section.id = "imvia-project-context";
    section.innerHTML = `<div class="imvia-project-head"><strong>项目位置</strong><span>可选</span></div><div class="imvia-project-row"><input aria-label="Lovart项目地址" placeholder="留空：自动新建并沿用当前项目"><button type="button">保存项目地址</button></div><small class="imvia-project-status">留空：首次生成会自动新建项目，之后沿用当前项目。</small>`;
    const referenceSection = scroll.querySelector(".references-section");
    if (referenceSection) referenceSection.before(section); else scroll.prepend(section);
    const input = section.querySelector("input");
    const button = section.querySelector("button");
    input.value = projectLocator;
    button.addEventListener("click", () => saveProjectFromField());
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveProjectFromField(); } });
    projectContextStatus();
  }

  function updateProjectContext() {
    const input = document.querySelector("#imvia-project-context input");
    if (input && document.activeElement !== input) input.value = projectLocator;
    projectContextStatus();
  }

  async function loadProjectContext() {
    if (!isLiveWorkbench() || (document.documentElement.dataset.imviaProvider || "lovart") !== "lovart" || projectsLoaded || projectLoading) return;
    projectLoading = true;
    try {
      const data = await apiJson("/api/v1/lovart/projects", { method: "GET", headers: {} });
      const projects = Array.isArray(data.projects) ? data.projects : [];
      activeProject = projects.find((project) => project.project_id === data.active_lovart_project_id) || null;
      projectLocator = activeProject?.canvas_url || "";
      projectsLoaded = true;
      updateProjectContext();
    } catch (error) {
      projectContextStatus(error.message || "项目状态读取失败", true);
    } finally {
      projectLoading = false;
    }
  }

  async function saveProjectFromField() {
    const input = document.querySelector("#imvia-project-context input");
    const button = document.querySelector("#imvia-project-context button");
    if (!input || !button || projectLoading) return;
    const locator = input.value.trim();
    if (!locator) {
      projectLocator = "";
      projectContextStatus("留空：生成时沿用当前项目；没有当前项目时自动新建。", false);
      showWorkbenchToast("已设置为自动选择项目");
      return;
    }
    projectLoading = true; button.disabled = true; projectContextStatus("正在保存项目地址…");
    try {
      activeProject = await apiJson("/api/v1/lovart/projects/remember", { method: "POST", body: JSON.stringify({ locator, source: "user_selected" }) });
      projectLocator = activeProject?.canvas_url || locator;
      projectsLoaded = true;
      updateProjectContext();
      projectContextStatus("项目地址已保存；Codex 执行任务时再验证并使用它。");
      showWorkbenchToast("项目地址已保存，将随任务发送给 Codex");
    } catch (error) {
      projectContextStatus(error.message || "项目地址保存失败", true);
      showWorkbenchToast(error.message || "项目地址保存失败，请稍后重试", true);
    } finally {
      projectLoading = false; button.disabled = false;
    }
  }

  async function ensureProjectRemembered() {
    if ((document.documentElement.dataset.imviaProvider || "lovart") !== "lovart") return;
    const input = document.querySelector("#imvia-project-context input");
    const locator = input?.value?.trim() || "";
    if (!locator || locator === projectLocator) return;
    await saveProjectFromField();
    if (!projectLocator) throw new Error("项目地址未保存");
  }

  function compactText(element) {
    return element?.textContent?.replace(/\s+/gu, " ").trim() || "";
  }

  async function referenceSummary() {
    const summaries = [];
    const counters = { image: 0, video: 0, audio: 0 };
    const kindLabels = { image: "图片", video: "视频", audio: "音频" };
    for (const [index, item] of Array.from(document.querySelectorAll(".references-section .reference-item")).entries()) {
      const media = item.querySelector("img,video,audio");
      const source = media?.getAttribute("src") || media?.getAttribute("poster") || "";
      const kind = item.querySelector(".audio-reference") || media?.tagName?.toLowerCase() === "audio" ? "audio" : item.querySelector("em") || media?.tagName?.toLowerCase() === "video" ? "video" : "image";
      counters[kind] += 1;
      const label = compactText(item.querySelector(".reference-label span")) || compactText(item.querySelector("strong")) || `${kindLabels[kind]}${counters[kind]}`;
      let attachment = null;
      if (source.startsWith("blob:") || source.startsWith("data:")) {
        attachment = await uploadWorkbenchReference({
          source,
          kind,
          label,
          uploadJson: apiJson,
          onCompressed: ({ original_size_bytes: originalSize, upload_size_bytes: uploadSize, width, height }) => {
            showWorkbenchToast(`${label} 超过 ${megabytes(LOVART_IMAGE_MAX_BYTES)}，已生成 ${megabytes(uploadSize)} 的上传副本；原图未改动，像素尺寸保持 ${width}×${height}。`);
          },
        });
      } else if (source) {
        let url;
        try { url = new URL(source, window.location.origin); } catch { url = null; }
        if (url?.origin === window.location.origin && url.pathname.startsWith("/assets/")) attachment = `imvia-workbench:${url.pathname}`;
        else if (url?.protocol === "https:") attachment = String(url);
      }
      summaries.push({ id: `workbench-reference-${index + 1}`, display: label.replace(/^@/u, ""), kind, attachment });
    }
    return summaries;
  }

  async function readWorkbenchSubmission() {
    const prompt = document.querySelector(".prompt-box textarea")?.value || "";
    const tabText = document.querySelector(".creation-tabs button.active")?.textContent || "";
    const mode = tabText.includes("视频") ? "video" : "image";
    const model = resolveGenerationModel({
      value: document.querySelector(".model-section .select-box")?.textContent?.replace(/\s+/gu, " ").trim() || "",
      modelOverride: document.documentElement.dataset.imviaModel,
    });
    const references = await referenceSummary();
    const provider = serializeProviderSelection({
      providerId: document.documentElement.dataset.imviaProvider || "lovart",
      connectionId: document.documentElement.dataset.imviaConnection || null,
      model,
    });
    const settingValues = {};
    for (const label of document.querySelectorAll(".settings-grid label,.advanced-panel label")) {
      const name = compactText(label.querySelector(":scope > span"));
      if (name) settingValues[name] = compactText(label.querySelector(".select-box"));
    }
    const generationMode = compactText(document.querySelector(".mode-row .select-box"));
    const countText = mode === "image"
      ? document.documentElement.dataset.imviaGenerationCount || settingValues["生成数量"] || settingValues["数量"] || "Auto"
      : settingValues["生成数量"] || settingValues["数量"] || "1";
    const generationCount = serializeGenerationCount({ mode, value: countText });
    const durationText = settingValues["时长"] || "";
    const tokens = references.filter((reference) => prompt.includes(`@${reference.display}`)).map((reference) => ({ reference_id: reference.id, display: reference.display }));
    return {
      mode,
      model: provider.model,
      provider_id: provider.provider_id,
      connection_id: provider.connection_id,
      prompt: { text: prompt, tokens },
      references,
      attachments: references.map((reference) => reference.attachment).filter(Boolean),
      settings: {
        generation_mode: generationMode || null,
        ratio: resolveGenerationRatio({ mode, value: settingValues["比例"], ratioOverride: document.documentElement.dataset.imviaRatio || document.documentElement.dataset.imviaImageRatio }),
        resolution: settingValues["分辨率"] || null,
        duration_seconds: durationText ? Number.parseInt(durationText, 10) || null : null,
        count_mode: generationCount.count_mode,
        count: generationCount.count,
        audio: document.querySelector(".audio-setting .toggle")?.classList.contains("on") || false,
        advanced: Object.fromEntries(Object.entries(settingValues).filter(([name]) => !["比例", "分辨率", "时长", "生成数量", "数量"].includes(name))),
      },
      project_locator: provider.provider_id === "lovart" ? (document.querySelector("#imvia-project-context input")?.value?.trim() || null) : null,
    };
  }

  async function submitWorkbenchHandoff(button) {
    if (handoffPending) return;
    const prompt = document.querySelector(".prompt-box textarea")?.value || "";
    if (!prompt.trim()) { showWorkbenchToast("请先填写创意描述", true); return; }
    handoffPending = true; button.disabled = true; const originalText = button.textContent; button.textContent = "正在发送给 Codex…";
    try {
      await ensureProjectRemembered();
      const snapshot = await readWorkbenchSubmission();
      const accepted = await apiJson("/api/v1/workbench/submissions", { method: "POST", headers: sessionHeaders(), body: JSON.stringify({ snapshot, idempotency_key: randomKey("workbench-handoff") }) });
      const deliveryMessage = accepted.delivery_state === "pending_bridge"
        ? "任务已保存，等待会话桥发送到当前 Codex 会话。"
        : accepted.delivery_state === "host_accepted"
          ? "任务已送达当前 Codex 会话，等待处理。"
          : "任务已保存；会话桥状态待确认。";
      showWorkbenchToast(deliveryMessage);
      if (accepted.job_id) window.setTimeout(async () => {
        try {
          const delivery = await apiJson(`/api/v1/jobs/${encodeURIComponent(accepted.job_id)}/delivery`, { method: "GET", headers: sessionHeaders() });
          if (delivery.delivery_state === "codex_received") {
            const providerLabel = compactText(document.querySelector("#imvia-provider-selector .imvia-provider-value")) || snapshot.provider_id;
            showWorkbenchToast(`Codex 已收到任务，正在通过 ${providerLabel} 处理。`);
          }
          else if (delivery.delivery_state === "pending_bridge") showWorkbenchToast("会话桥仍在等待发送，保持工作台打开即可自动重试。");
        } catch { /* the next state poll remains authoritative */ }
      }, 900);
      await load();
    } catch (error) {
      showWorkbenchToast(error.message || "任务发送给 Codex 失败", true);
    } finally {
      handoffPending = false; button.disabled = false; button.textContent = originalText;
    }
  }

  function installWorkbenchHandoffAction() {
    if (!isLiveWorkbench() || document.documentElement.dataset.imviaWorkbenchHandoffInstalled) return;
    document.documentElement.dataset.imviaWorkbenchHandoffInstalled = "true";
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".primary-action");
      if (!button || !document.querySelector(".creator-panel")) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (button.classList.contains("imvia-lovart-generating")) { showWorkbenchToast("Lovart 正在生成，请等待结果返回。"); return; }
      submitWorkbenchHandoff(button).catch(() => {});
    }, true);
  }

  function installFreshSessionReset() {
    if (!isLiveWorkbench() || !workbenchSessionId()) return;
    if (!document.documentElement.dataset.imviaFreshCreatorReset) {
      const result = resetFreshCreator(document);
      if (result.ready) document.documentElement.dataset.imviaFreshCreatorReset = "true";
    }
    if (document.documentElement.dataset.imviaFreshModeResetInstalled) return;
    document.documentElement.dataset.imviaFreshModeResetInstalled = "true";
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".creation-tabs button");
      if (!button || button.classList.contains("active")) return;
      window.setTimeout(() => resetFreshCreator(document), 0);
    }, true);
  }

  function finalizeFreshSessionReset() {
    if (freshHydrationResetDone || !isLiveWorkbench() || !workbenchSessionId()) return;
    window.requestAnimationFrame(() => {
      const result = resetFreshCreator(document);
      if (result.ready) freshHydrationResetDone = true;
    });
  }

  function firstRangeRect(node, start, end) {
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, end);
    const rects = Array.from(range.getClientRects());
    return rects.find((rect) => rect.height > 0) || rects[0] || null;
  }

  function pointFromRect(rect, side = "left") {
    if (!rect) return null;
    return { left: side === "right" ? rect.right : rect.left, top: rect.top, height: Math.max(14, rect.height) };
  }

  function plainCaretPositions(child) {
    const text = child.textContent || "";
    const node = child.firstChild;
    if (!node || !text) return [];
    const positions = [];
    for (let offset = 0; offset <= text.length; offset += 1) {
      let point = null;
      if (offset < text.length && text[offset] !== "\n") {
        point = pointFromRect(firstRangeRect(node, offset, offset + 1));
      } else if (offset > 0) {
        const previous = firstRangeRect(node, offset - 1, offset);
        if (text[offset - 1] === "\n") {
          const lineHeight = Number.parseFloat(getComputedStyle(child).lineHeight) || previous?.height || 16;
          const highlightLeft = document.querySelector(".prompt-highlights")?.getBoundingClientRect().left ?? previous?.left ?? 0;
          point = { left: highlightLeft, top: (previous?.top ?? child.getBoundingClientRect().top) + lineHeight, height: Math.max(14, previous?.height || lineHeight) };
        } else point = pointFromRect(previous, "right");
      } else {
        const rect = child.getBoundingClientRect();
        point = { left: rect.left, top: rect.top, height: Math.max(14, rect.height) };
      }
      positions.push(point);
    }
    return positions;
  }

  function visualCaretSegments(highlight) {
    return Array.from(highlight.children).map((child) => {
      if (child.classList.contains("prompt-token")) {
        const label = child.querySelector(".prompt-token-remove")?.getAttribute("aria-label")?.replace(/^删除引用\s*/u, "").trim() || "";
        const rect = child.getBoundingClientRect();
        const point = (side) => ({ left: side === "right" ? rect.right : rect.left, top: rect.top + 2, height: Math.max(14, rect.height - 4) });
        return { kind: "token", source_length: label ? label.length + 1 : 0, start: point("left"), end: point("right") };
      }
      const text = child.textContent || "";
      return { kind: "plain", source_length: text.length, positions: plainCaretPositions(child) };
    });
  }

  function promptCaretElement() {
    let caret = document.getElementById("imvia-prompt-visual-caret");
    if (!caret) {
      caret = document.createElement("span");
      caret.id = "imvia-prompt-visual-caret";
      caret.setAttribute("aria-hidden", "true");
      document.body.appendChild(caret);
    }
    return caret;
  }

  function updatePromptVisualCaret() {
    const caret = promptCaretElement();
    const textarea = document.querySelector(".prompt-box textarea");
    const highlight = document.querySelector(".prompt-highlights");
    if (!textarea || !highlight || document.activeElement !== textarea || textarea.selectionStart !== textarea.selectionEnd) {
      caret.classList.remove("active", "engaged", "blinking");
      return;
    }
    const point = resolveVisualCaret({ segments: visualCaretSegments(highlight), selection_start: textarea.selectionStart });
    if (!point || point.top < 0 || point.top > window.innerHeight || point.left < 0 || point.left > window.innerWidth) {
      caret.classList.remove("active", "engaged", "blinking");
      return;
    }
    caret.style.left = `${point.left}px`; caret.style.top = `${point.top}px`; caret.style.height = `${point.height}px`;
    const phase = visualCaretPhase({ last_interaction_at: lastPromptCaretInteractionAt });
    caret.classList.remove("engaged", "blinking");
    caret.classList.add("active", phase);
    window.clearTimeout(promptCaretTimer);
    if (phase === "engaged") promptCaretTimer = window.setTimeout(schedulePromptVisualCaret, 720);
  }

  function schedulePromptVisualCaret(engaged = false) {
    if (engaged) lastPromptCaretInteractionAt = Date.now();
    window.cancelAnimationFrame(promptCaretFrame);
    promptCaretFrame = window.requestAnimationFrame(() => {
      promptCaretFrame = window.requestAnimationFrame(updatePromptVisualCaret);
    });
  }

  function installPromptVisualCaret() {
    if (!isLiveWorkbench() || document.documentElement.dataset.imviaPromptVisualCaretInstalled) return;
    document.documentElement.dataset.imviaPromptVisualCaretInstalled = "true";
    for (const eventName of ["input", "keyup", "click", "select", "compositionupdate", "compositionend", "focusin"]) {
      document.addEventListener(eventName, () => schedulePromptVisualCaret(true), true);
    }
    document.addEventListener("focusout", () => schedulePromptVisualCaret(false), true);
    document.addEventListener("selectionchange", schedulePromptVisualCaret, true);
    window.addEventListener("resize", schedulePromptVisualCaret);
    window.addEventListener("scroll", schedulePromptVisualCaret, true);
    schedulePromptVisualCaret();
  }

  function installReferenceInsertionFix() {
    if (!isLiveWorkbench() || document.documentElement.dataset.imviaReferenceInsertionFixInstalled) return;
    document.documentElement.dataset.imviaReferenceInsertionFixInstalled = "true";
    function visualCaretIndex(event) {
      const highlight = document.querySelector(".prompt-highlights");
      const textarea = document.querySelector(".prompt-box textarea");
      if (!highlight || !textarea) return null;
      const target = event.target;
      const tokenTarget = target?.closest?.(".prompt-token");
      const textareaTarget = target?.closest?.(".prompt-box textarea");
      const highlightTarget = target?.closest?.(".prompt-highlights");
      if (!tokenTarget && !textareaTarget && !highlightTarget) return null;
      if (target?.closest?.(".prompt-token-remove")) return null;
      const point = { x: event.clientX, y: event.clientY };
      const children = Array.from(highlight.children);
      let rawIndex = 0;
      for (const child of children) {
        if (child.classList.contains("prompt-token")) {
          const label = child.querySelector(".prompt-token-remove")?.getAttribute("aria-label")?.replace(/^删除引用\s*/u, "").trim();
          const source = label ? `@${label}` : "";
          const rects = Array.from(child.getClientRects());
          if (source && rects.some((rect) => point.x >= rect.left - 4 && point.x <= rect.right + 18 && point.y >= rect.top - 4 && point.y <= rect.bottom + 4)) return rawIndex + source.length;
          rawIndex += source.length;
          continue;
        }
        const text = child.textContent || "";
        const node = child.firstChild;
        if (!node || !text) { rawIndex += text.length; continue; }
        for (let index = 0; index < text.length; index += 1) {
          const range = document.createRange();
          range.setStart(node, index); range.setEnd(node, index + 1);
          const rects = Array.from(range.getClientRects());
          for (const rect of rects) {
            if (point.y < rect.top - 4 || point.y > rect.bottom + 4) continue;
            if (point.x <= rect.left) return rawIndex + index;
            if (point.x <= rect.right) return rawIndex + (point.x < rect.left + rect.width * 0.35 ? index : index + 1);
          }
        }
        rawIndex += text.length;
      }
      return null;
    }

    const placeCaretAtVisualPoint = (event) => {
      const index = visualCaretIndex(event);
      if (index == null) return;
      const textarea = document.querySelector(".prompt-box textarea");
      if (!textarea) return;
      const tokenTarget = event.target?.closest?.(".prompt-token");
      event.preventDefault();
      textarea.focus(); textarea.setSelectionRange(index, index);
      schedulePromptVisualCaret();
      if (tokenTarget) event.stopImmediatePropagation();
    };
    document.addEventListener("mousedown", placeCaretAtVisualPoint, true);
    document.addEventListener("click", placeCaretAtVisualPoint, true);
  }

  function place(element) {
    const target = panel(); if (!target || !element) return;
    const rect = target.getBoundingClientRect();
    element.style.top = `${Math.max(0, rect.top)}px`; element.style.left = `${Math.max(0, rect.left)}px`;
    element.style.width = `${Math.max(280, rect.width)}px`; element.style.height = `${Math.max(280, rect.height)}px`;
  }

  function removeOverlay() {
    document.getElementById(rootId)?.remove();
    const target = panel(); if (target) target.style.visibility = "";
    lastRenderedSignature = null;
    lastPanelTarget = null;
  }

  async function followUp(job, artifact, instruction, button) {
    if (!providerSupportsContinuation(job)) return;
    const trimmed = instruction.trim();
    if (!trimmed || pendingKey) return;
    const key = `workbench-follow-up:${job.id}:${artifact.id}:${Date.now()}`;
    pendingKey = key; button.disabled = true; showWorkbenchToast("已提交继续编辑，等待 Codex 执行 Lovart 任务…"); render(current);
    try {
      const response = await fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/follow-ups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifact_id: artifact.id, instruction: trimmed, idempotency_key: key }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || "继续编辑提交失败");
      showWorkbenchToast("继续编辑任务已准备，等待 Codex 执行。");
      window.setTimeout(load, 800);
    } catch (error) {
      showWorkbenchToast(error.message || "继续编辑提交失败", true);
    } finally { pendingKey = null; render(current); }
  }

  function render(state) {
    if (rendering) return;
    rendering = true;
    try {
    const target = panel();
    const cursor = submissionCursor(state);
    const sessionJobs = jobsAfterSubmissionCursor(state, cursor);
    const latestSessionJob = sessionJobs.at(-1) || null;
    const generationState = generationPresentation(latestSessionJob, { providerLabel: redactedProviderMetadata(latestSessionJob).provider_label });
    document.querySelectorAll(".creator-panel .primary-action").forEach((button) => {
      button.classList.toggle("imvia-lovart-generating", generationState.busy);
      if (generationState.busy) {
        button.dataset.imviaLovartLabel = generationState.label;
        button.setAttribute("aria-busy", "true");
      } else {
        delete button.dataset.imviaLovartLabel;
        button.removeAttribute("aria-busy");
      }
    });
    const artifacts = artifactsAfterSubmissionCursor(state, cursor);
    if (!target) { removeOverlay(); return; }
    // The legacy live-result panel is the authoritative empty/pending state.
    // Do not mount a second empty overlay over it; only mount this enhanced
    // layer once real provider artifacts exist.
    if (!shouldRenderResultOverlay(artifacts)) { simplifyEmptyResultPanel(target); removeOverlay(); return; }
    target.style.visibility = "hidden";
    let element = document.getElementById(rootId);
    if (!element) { element = document.createElement("section"); element.id = rootId; document.body.appendChild(element); }
    const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId) || artifacts[0]; selectedArtifactId = selected.id;
    const signature = resultRenderSignature(state, selected.id, Boolean(pendingKey));
    if (target === lastPanelTarget && signature === lastRenderedSignature) { place(element); return; }
    place(element);
    const job = jobForArtifact(state, selected);
    const providerMetadata = redactedProviderMetadata(job);
    const isLovart = providerMetadata.provider_id === "lovart";
    const projectId = isLovart ? (job?.lovart_project_id || job?.snapshot?.lovart_project_id) : null;
    const cards = renderResultCards(artifacts, selected.id, contentUrl, { providerMetadata });
    const followUpMarkup = providerSupportsContinuation(job)
      ? `<section class="irw-follow"><div class="irw-follow-label"><span>继续编辑当前结果</span><small>文字指令会连同选中的结果发送给 Lovart</small></div><textarea aria-label="再次编辑提示词" placeholder="例如：把背景改成黄昏，并保持人物和构图不变"></textarea><div class="irw-actions"><button type="button" class="primary" ${pendingKey ? "disabled" : ""}>发送继续编辑</button></div></section>`
      : "";
    element.innerHTML = `<header class="irw-head"><strong>生成结果</strong><div class="irw-meta"><span>${escapeHtml(job?.status || "已导入")}</span>${projectId ? `<a class="irw-project" href="${projectUrl(projectId)}" target="_blank" rel="noreferrer">打开 Lovart 项目</a>` : ""}</div></header>${renderResultBody({ cards, followUp: followUpMarkup, count: artifacts.length, providerLabel: providerMetadata.provider_label })}`;
    element.querySelectorAll(".irw-card").forEach((card) => {
      const artifact = artifacts.find((item) => item.id === card.dataset.artifactId);
      const select = () => { selectedArtifactId = card.dataset.artifactId; render(current); };
      card.addEventListener("click", (event) => { if (!event.target.closest("[data-action]")) select(); });
      card.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("[data-action]")) { event.preventDefault(); select(); } });
      card.querySelector('[data-action="download"]')?.addEventListener("click", (event) => event.stopPropagation());
      card.querySelector('[data-action="preview"]')?.addEventListener("click", (event) => { event.stopPropagation(); openMediaPreview({ src: contentUrl(artifact.id), kind: artifactKind(artifact), name: "生成结果" }); });
      card.querySelector('[data-action="library"]')?.addEventListener("click", (event) => { event.stopPropagation(); addArtifactToLibrary(artifact, redactedProviderMetadata(jobForArtifact(current, artifact))); });
    });
    const textarea = element.querySelector("textarea"); const button = element.querySelector("button.primary");
    if (providerSupportsContinuation(job) && textarea && button) button.addEventListener("click", () => followUp(job, selected, textarea.value, button));
    injectGeneratedLibrary();
    lastPanelTarget = target;
    lastRenderedSignature = signature;
    } finally { rendering = false; }
  }

  async function load() {
    try { const response = await fetch(stateUrl, { cache: "no-store" }); if (!response.ok) return; const payload = await response.json(); if (payload.ok) { current = payload.data; render(current); finalizeFreshSessionReset(); } }
    catch { /* The empty panel remains untouched when the local API is unavailable. */ }
  }

  function enhanceWorkbench() {
    if (!isLiveWorkbench()) return;
    installImageCountAuto(document);
    installGenerationSettings(document);
    installModelAuto(document);
    installProviderSelector({ document, root: document }).then(() => {
      const project = document.getElementById("imvia-project-context");
      if (project) project.hidden = (document.documentElement.dataset.imviaProvider || "lovart") !== "lovart";
    }).catch(() => undefined);
    installAssetLibraryEnhancements(document);
    injectProjectContext();
    installWorkbenchHandoffAction();
    installFreshSessionReset();
    installPromptVisualCaret();
    installReferenceInsertionFix();
    loadProjectContext();
    schedulePromptVisualCaret();
  }

  document.addEventListener("imvia:provider-selection-changed", (event) => {
    const isLovart = event.detail?.provider_id === "lovart";
    const project = document.getElementById("imvia-project-context");
    if (project) project.hidden = !isLovart;
    if (isLovart) { injectProjectContext(); loadProjectContext(); }
  });

  let repositionFrame = 0;
  const reposition = () => {
    window.cancelAnimationFrame(repositionFrame);
    repositionFrame = window.requestAnimationFrame(() => {
      const element = document.getElementById(rootId); if (element) place(element);
      installImageCountAuto(document);
      installGenerationSettings(document);
      installModelAuto(document);
    });
  };
  window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
  const syncResultPanelMutation = createResultPanelMutationHandler({
    isFreshSession: () => isLiveWorkbench() && Boolean(workbenchSessionId()),
    getPanel: panel,
    getCurrentState: () => current,
    getResultRoot: () => document.getElementById(rootId),
    isRendering: () => rendering,
    scheduleRender: (state) => window.requestAnimationFrame(() => render(state)),
  });
  const observer = new MutationObserver((mutations) => {
    enhanceWorkbench();
    syncResultPanelMutation(mutations);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.setInterval(() => { enhanceWorkbench(); injectGeneratedLibrary(); load(); }, 2000);
  window.addEventListener("hashchange", () => window.setTimeout(injectGeneratedLibrary, 80));
  window.addEventListener("load", () => { enhanceWorkbench(); load(); });
  enhanceWorkbench();
  load();
})();
