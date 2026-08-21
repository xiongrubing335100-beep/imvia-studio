(() => {
  "use strict";
  const rootId = "imvia-live-result-workspace";
  const css = `
    #${rootId}{position:fixed;z-index:120;display:flex;flex-direction:column;overflow:hidden;background:#121518;border:1px solid #262c30;border-radius:16px;color:#f1f4f4;box-shadow:0 20px 70px #0009}
    #${rootId} .irw-head{height:64px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #20262a}
    #${rootId} .irw-head strong{font-size:16px}#${rootId} .irw-meta{display:flex;gap:8px;align-items:center;color:#92999d;font-size:11px}
    #${rootId} .irw-project{color:#57d6d8;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
    #${rootId} .irw-body{flex:1;min-height:0;padding:16px 20px 82px;overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-content:start}
    #${rootId} .irw-card{min-width:0;position:relative;border:1px solid #292f33;border-radius:11px;overflow:hidden;background:#0c0f11;cursor:pointer}
    #${rootId} .irw-card.selected{border-color:#57d6d8;box-shadow:inset 0 0 0 1px #57d6d8}
    #${rootId} .irw-preview{height:clamp(170px,31vh,320px);display:grid;place-items:center;background:#0b0f11;overflow:hidden}
    #${rootId} .irw-preview img,#${rootId} .irw-preview video{width:100%;height:100%;object-fit:cover;display:block}
    #${rootId} .irw-preview audio{width:calc(100% - 26px)}
    #${rootId} .irw-card-meta{padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;color:#aeb7ba;font-size:11px}
    #${rootId} .irw-card-meta strong{color:#dbe2e3;font-size:12px}#${rootId} .irw-card-meta span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${rootId} .irw-follow{grid-column:1 / -1;padding:14px;border:1px solid #293135;border-radius:11px;background:#151a1d}
    #${rootId} .irw-follow-label{display:flex;justify-content:space-between;align-items:center;color:#c9d0d1;font-size:12px}
    #${rootId} .irw-follow-label small{color:#778185;font-size:10px}#${rootId} textarea{width:100%;height:62px;margin-top:9px;padding:10px;border:1px solid #30383c;border-radius:9px;resize:vertical;outline:0;color:#e6ebec;background:#0e1315;font-size:12px;line-height:1.45}
    #${rootId} .irw-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:9px}#${rootId} button{height:32px;padding:0 12px;border:1px solid #30373b;border-radius:8px;background:#171b1f;color:#c9d1d2;font-size:11px}#${rootId} button.primary{border:0;background:#3f9095;color:#f2ffff;font-weight:600}#${rootId} button:disabled{opacity:.45;cursor:wait}
    #${rootId} .irw-status{position:absolute;left:20px;right:20px;bottom:18px;min-height:44px;padding:0 12px;display:flex;align-items:center;gap:8px;border:1px solid #242a2e;border-radius:10px;background:#171b1e;color:#8e969a;font-size:11px}
    #${rootId} .irw-error{color:#e49b9b}#${rootId} .irw-empty{grid-column:1 / -1;min-height:160px;display:grid;place-items:center;text-align:center;color:#92999d;font-size:12px}
    @media(max-width:900px){#${rootId} .irw-body{grid-template-columns:1fr}#${rootId} .irw-follow{grid-column:1}}
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
  `;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
  let current = null;
  let selectedArtifactId = null;
  let pendingKey = null;
  let statusMessage = "结果由 Lovart 生成，本地工作台负责展示与继续编辑。";
  let statusError = false;
  let rendering = false;
  let projectLocator = "";
  let activeProject = null;
  let projectsLoaded = false;
  let projectLoading = false;
  let generationPending = false;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  const panel = () => document.querySelector(".live-result-panel");
  const stateUrl = "/api/v1/state?include=jobs,artifacts";
  const contentUrl = (id) => `/api/v1/artifacts/${encodeURIComponent(id)}/content`;
  const projectUrl = (id) => `https://www.lovart.ai/canvas?projectId=${encodeURIComponent(id)}`;
  const jobForArtifact = (state, artifact) => (state.jobs || []).find((job) => job.id === artifact.job_id) || state.jobs?.at(-1) || null;
  const dateLabel = (value) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "时间未知"; };
  const isLiveWorkbench = () => new URLSearchParams(window.location.search).get("imvia") === "live";
  const randomKey = (prefix) => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

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

  function projectContextStatus(message = null, error = false) {
    const status = document.querySelector("#imvia-project-context .imvia-project-status");
    if (!status) return;
    status.textContent = message || (activeProject
      ? `当前项目：${activeProject.name || activeProject.project_id}`
      : "留空：首次生成会自动新建项目，之后沿用当前项目。");
    status.style.color = error ? "#e49b9b" : "";
  }

  function injectProjectContext() {
    if (!isLiveWorkbench()) return;
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
    if (!isLiveWorkbench() || projectsLoaded || projectLoading) return;
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
    projectLoading = true; button.disabled = true; projectContextStatus("正在验证 Lovart 项目地址…");
    try {
      activeProject = await apiJson("/api/v1/lovart/projects/select", { method: "POST", body: JSON.stringify({ locator, source: "user_selected" }) });
      projectLocator = activeProject?.canvas_url || locator;
      projectsLoaded = true;
      updateProjectContext();
      showWorkbenchToast("Lovart 项目已选定，后续生成会沿用它");
    } catch (error) {
      projectContextStatus(error.message || "项目地址无效", true);
      showWorkbenchToast(error.message || "项目地址无效，请检查后重试", true);
    } finally {
      projectLoading = false; button.disabled = false;
    }
  }

  async function ensureProjectSelected() {
    const input = document.querySelector("#imvia-project-context input");
    const locator = input?.value?.trim() || "";
    if (!locator || locator === projectLocator) return;
    await saveProjectFromField();
    if (!projectLocator) throw new Error("项目地址未保存");
  }

  function readGenerationInput() {
    const prompt = document.querySelector(".prompt-box textarea")?.value?.trim() || "";
    const tabText = document.querySelector(".creation-tabs button.active")?.textContent || "";
    const mode = tabText.includes("视频") ? "video" : "image";
    const model = document.querySelector(".model-section .select-box")?.textContent?.replace(/\s+/gu, " ").trim() || "";
    const attachments = [];
    for (const media of document.querySelectorAll(".references-section .reference-thumb img,.references-section .reference-thumb video,.references-section .reference-thumb audio")) {
      const source = media.getAttribute("src") || media.getAttribute("poster") || "";
      if (!source) continue;
      if (source.startsWith("blob:")) throw new Error("本地上传素材需先保存到素材库后才能发送给 Lovart");
      let pathname;
      try { pathname = new URL(source, window.location.origin).pathname; } catch { continue; }
      if (pathname.startsWith("/assets/")) attachments.push(`imvia-workbench:${pathname}`);
    }
    return { prompt, mode, model, attachments };
  }

  async function submitLiveGeneration(button) {
    if (generationPending) return;
    const input = readGenerationInput();
    if (!input.prompt) { showWorkbenchToast("请先填写创意描述", true); return; }
    generationPending = true; button.disabled = true; const originalText = button.textContent; button.textContent = "正在提交 Lovart 任务…";
    try {
      await ensureProjectSelected();
      const prefer_models = input.model ? { [input.mode]: [input.model] } : undefined;
      const payload = { prompt: input.prompt, mode: input.mode, attachments: input.attachments, idempotency_key: randomKey("workbench-generation"), ...(prefer_models ? { prefer_models } : {}) };
      const result = await apiJson("/api/v1/generations", { method: "POST", body: JSON.stringify(payload) });
      if (result.status === "awaiting_cost_confirmation") showWorkbenchToast("任务等待费用确认，请在当前 Codex 会话中明确确认");
      else showWorkbenchToast("Lovart 任务已提交，结果会自动显示在右侧");
      await load();
      projectsLoaded = false;
      await loadProjectContext();
    } catch (error) {
      showWorkbenchToast(error.message || "Lovart 任务提交失败", true);
    } finally {
      generationPending = false; button.disabled = false; button.textContent = originalText;
    }
  }

  function installLiveGenerationAction() {
    if (!isLiveWorkbench() || document.documentElement.dataset.imviaGenerationActionInstalled) return;
    document.documentElement.dataset.imviaGenerationActionInstalled = "true";
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".primary-action");
      if (!button || !document.querySelector(".creator-panel")) return;
      event.preventDefault(); event.stopImmediatePropagation();
      submitLiveGeneration(button).catch(() => {});
    }, true);
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
  }

  async function followUp(job, artifact, instruction, button) {
    const trimmed = instruction.trim();
    if (!trimmed || pendingKey) return;
    const key = `workbench-follow-up:${job.id}:${artifact.id}:${Date.now()}`;
    pendingKey = key; button.disabled = true; statusError = false; statusMessage = "已提交继续编辑，等待 Codex 执行 Lovart 任务…"; render(current);
    try {
      const response = await fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/follow-ups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifact_id: artifact.id, instruction: trimmed, idempotency_key: key }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message || "继续编辑提交失败");
      statusMessage = "继续编辑任务已准备，等待 Codex 执行。";
      window.setTimeout(load, 800);
    } catch (error) {
      statusError = true; statusMessage = error.message || "继续编辑提交失败";
    } finally { pendingKey = null; render(current); }
  }

  function render(state) {
    if (rendering) return;
    rendering = true;
    try {
    const target = panel();
    const artifacts = Array.isArray(state?.artifacts) ? state.artifacts.filter((artifact) => artifact?.id) : [];
    if (!target || !artifacts.length) { removeOverlay(); return; }
    target.style.visibility = "hidden";
    let element = document.getElementById(rootId);
    if (!element) { element = document.createElement("section"); element.id = rootId; document.body.appendChild(element); }
    place(element);
    const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId) || artifacts[0]; selectedArtifactId = selected.id;
    const job = jobForArtifact(state, selected);
    const projectId = job?.lovart_project_id || job?.snapshot?.lovart_project_id;
    const cards = artifacts.map((artifact) => {
      const kind = artifact.kind === "video" ? "video" : artifact.kind === "audio" ? "audio" : "image";
      const preview = kind === "video" ? `<video src="${contentUrl(artifact.id)}" controls preload="metadata"></video>` : kind === "audio" ? `<audio src="${contentUrl(artifact.id)}" controls preload="metadata"></audio>` : `<img src="${contentUrl(artifact.id)}" alt="生成图片结果" loading="lazy">`;
      const selectedClass = artifact.id === selected.id ? " selected" : "";
      return `<article class="irw-card${selectedClass}" data-artifact-id="${escapeHtml(artifact.id)}" tabindex="0"><div class="irw-preview">${preview}</div><div class="irw-card-meta"><strong>${kind === "video" ? "视频结果" : kind === "audio" ? "音频结果" : "图片结果"}</strong><span>${escapeHtml(dateLabel(artifact.created_at))}</span></div></article>`;
    }).join("");
    element.innerHTML = `<header class="irw-head"><strong>生成结果</strong><div class="irw-meta"><span>${escapeHtml(job?.status || "已导入")}</span>${projectId ? `<a class="irw-project" href="${projectUrl(projectId)}" target="_blank" rel="noreferrer">打开 Lovart 项目</a>` : ""}</div></header><div class="irw-body"><div class="irw-empty" style="display:none"></div>${cards}<div class="irw-follow"><div class="irw-follow-label"><span>继续编辑当前结果</span><small>文字指令会连同选中的结果发送给 Lovart</small></div><textarea aria-label="再次编辑提示词" placeholder="例如：把背景改成黄昏，并保持人物和构图不变"></textarea><div class="irw-actions"><button type="button" class="primary" ${pendingKey ? "disabled" : ""}>发送继续编辑</button></div></div></div><div class="irw-status${statusError ? " irw-error" : ""}" aria-live="polite">${escapeHtml(statusMessage)}</div>`;
    element.querySelectorAll(".irw-card").forEach((card) => { const select = () => { selectedArtifactId = card.dataset.artifactId; render(current); }; card.addEventListener("click", select); card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } }); });
    const textarea = element.querySelector("textarea"); const button = element.querySelector("button.primary"); button?.addEventListener("click", () => followUp(job, selected, textarea.value, button));
    } finally { rendering = false; }
  }

  async function load() {
    try { const response = await fetch(stateUrl, { cache: "no-store" }); if (!response.ok) return; const payload = await response.json(); if (payload.ok) { current = payload.data; render(current); } }
    catch { /* The empty panel remains untouched when the local API is unavailable. */ }
  }

  function enhanceWorkbench() {
    if (!isLiveWorkbench()) return;
    injectProjectContext();
    installLiveGenerationAction();
    installReferenceInsertionFix();
    loadProjectContext();
  }

  const reposition = () => { const element = document.getElementById(rootId); if (element) place(element); };
  window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
  const observer = new MutationObserver(() => {
    enhanceWorkbench();
    if (!rendering && current?.artifacts?.length) window.requestAnimationFrame(() => render(current));
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.setInterval(() => { enhanceWorkbench(); load(); }, 2000);
  window.addEventListener("load", () => { enhanceWorkbench(); load(); });
  enhanceWorkbench();
  load();
})();
