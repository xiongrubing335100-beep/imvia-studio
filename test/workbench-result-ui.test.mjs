import assert from "node:assert/strict";
import test from "node:test";

const ui = await import("../workbench/dist/assets/imvia-result-ui-v1.js").catch(() => ({}));

test("renders media-only result cards with download, enlarge or play, and library actions", () => {
  const html = ui.renderResultCards?.([
    { id: "image-1", kind: "image", mime_type: "image/png", created_at: "2026-08-23T09:31:03.000Z" },
    { id: "video-1", kind: "video", mime_type: "video/mp4", created_at: "2026-08-23T09:32:03.000Z" },
  ], "image-1", (id) => `/api/v1/artifacts/${id}/content`) ?? "";

  assert.match(html, /aria-label="下载图片"/u);
  assert.match(html, /aria-label="放大图片"/u);
  assert.match(html, /aria-label="播放视频"/u);
  assert.match(html, /aria-label="加入素材库"/u);
  assert.match(html, /irw-media-actions always-visible/u);
  assert.doesNotMatch(html, /图片结果|视频结果|2026\/8\/23/u);
});

test("uses a centered large layout only for one result", () => {
  assert.equal(ui.resultLayoutClass?.(1), "irw-results single");
  assert.equal(ui.resultLayoutClass?.(2), "irw-results multiple");
});

test("keeps the legacy live panel for empty and pending states", () => {
  assert.equal(ui.shouldRenderResultOverlay?.([]), false);
  assert.equal(ui.shouldRenderResultOverlay?.([{ id: "artifact-1", kind: "image" }]), true);
});

test("reduces empty and queued legacy panels to the no-results label", () => {
  const small = { textContent: "本地任务 · attempt 1" };
  const heading = { removed: false, remove() { this.removed = true; } };
  const description = { removed: false, remove() { this.removed = true; } };
  const action = { removed: false, remove() { this.removed = true; } };
  const state = {
    querySelector(selector) {
      return new Map([
        ["small", small],
        ["h2", heading],
        ["p", description],
        ["button.primary-small", action],
      ]).get(selector) || null;
    },
  };
  const panel = {
    querySelector(selector) {
      return selector === ".live-job-state.empty, .live-job-state.queued" ? state : null;
    },
  };

  assert.deepEqual(ui.simplifyEmptyResultPanel?.(panel), { applied: true, removed: 3 });
  assert.equal(small.textContent, "暂无任何结果");
  assert.equal(heading.removed, true);
  assert.equal(description.removed, true);
  assert.equal(action.removed, true);
});

test("simplifies a stale queued panel as soon as a fresh-session DOM mutation mounts it", () => {
  let labelWrites = 0;
  let labelValue = "本地任务 · attempt 1";
  const small = {
    get textContent() { return labelValue; },
    set textContent(value) { labelWrites += 1; labelValue = value; },
  };
  const removable = () => ({ removed: false, remove() { this.removed = true; } });
  const heading = removable();
  const description = removable();
  const action = removable();
  const state = {
    querySelector(selector) {
      return new Map([
        ["small", small],
        ["h2", heading],
        ["p", description],
        ["button.primary-small", action],
      ]).get(selector) || null;
    },
  };
  const panel = {
    querySelector(selector) {
      return selector === ".live-job-state.empty, .live-job-state.queued" ? state : null;
    },
  };
  const handler = ui.createResultPanelMutationHandler?.({
    isFreshSession: () => true,
    getPanel: () => panel,
    getCurrentState: () => null,
    getResultRoot: () => null,
    isRendering: () => false,
    scheduleRender: () => assert.fail("empty fresh sessions must not schedule the artifact overlay"),
  });

  assert.equal(typeof handler, "function");
  assert.deepEqual(handler?.([{ target: panel }]), {
    simplified: { applied: true, removed: 3 },
    renderScheduled: false,
  });
  assert.equal(small.textContent, "暂无任何结果");
  assert.equal(labelWrites, 1);
  handler?.([{ target: panel }]);
  assert.equal(labelWrites, 1, "the mutation handler must be idempotent and avoid a render loop");
});

test("scopes the always-visible action rule strongly enough to override the panel rule", () => {
  assert.equal(
    ui.resultActionsVisibilitySelector?.("result-root"),
    "#result-root .irw-media-actions.always-visible",
  );
});

test("keeps the single-result editor visible and renders flat translucent media actions", () => {
  const css = ui.resultWorkspaceOverrides?.("result-root") ?? "";

  assert.match(css, /\.irw-body:has\(\.irw-results\.single\)\{[^}]*grid-template-rows:minmax\(0,1fr\) auto;[^}]*overflow:hidden/u);
  assert.match(css, /\.irw-body:has\(\.irw-results\.single\) \.irw-preview\{[^}]*height:100%/u);
  assert.match(css, /\.irw-icon-button\{[^}]*background:rgba\(8,11,13,\.58\);[^}]*box-shadow:none/u);
});

test("centers empty and loading states across the full result body", () => {
  const css = ui.resultWorkspaceOverrides?.("result-root") ?? "";

  assert.match(css, /#result-root \.irw-body:has\(> \.irw-empty\)\{[^}]*display:grid;[^}]*place-items:center/u);
  assert.match(css, /#result-root \.irw-body:has\(> \.irw-empty\) \.irw-empty\{[^}]*min-height:0/u);
});

test("keeps one generated artifact in the persistent library when it is added twice", () => {
  const artifact = { id: "image-1", kind: "image", mime_type: "image/png" };
  const first = ui.mergeLibraryArtifact?.([], artifact, "/api/v1/artifacts/image-1/content") ?? [];
  const second = ui.mergeLibraryArtifact?.(first, artifact, "/api/v1/artifacts/image-1/content") ?? [];

  assert.equal(second.length, 1);
  assert.deepEqual(second[0], {
    id: "imvia-result-image-1",
    artifact_id: "image-1",
    kind: "image",
    mime_type: "image/png",
    name: "生成图片 image-1",
    tag: "@生成结果",
    meta: "PNG · Lovart 生成",
    src: "/api/v1/artifacts/image-1/content",
  });
});

test("labels generated library assets with the redacted producing provider", () => {
  const artifact = { id: "fixture-image-1", kind: "image", mime_type: "image/png" };
  const items = ui.mergeLibraryArtifact?.([], artifact, "/api/v1/artifacts/fixture-image-1/content", {
    provider_id: "fixture-api",
    connection_id: "connection-public-id",
    provider_label: "Fixture API",
    model: "fixture-image",
    api_key: "must-not-render",
  }) ?? [];

  assert.equal(items[0]?.meta, "PNG · Fixture API 生成");
  assert.doesNotMatch(JSON.stringify(items), /must-not-render|api_key/u);
});

test("renders result content before the follow-up editor and omits the static footer copy", () => {
  const html = ui.renderResultBody?.({
    cards: "<article>result</article>",
    followUp: "<section>follow-up</section>",
  }) ?? "";

  assert.ok(html.indexOf("result") < html.indexOf("follow-up"));
  assert.doesNotMatch(html, /结果由 Lovart 生成，本地工作台负责展示与继续编辑/u);
});

test("ignores DOM mutations created by rendering inside the result overlay", () => {
  const inside = { location: "inside" };
  const outside = { location: "outside" };
  const root = { contains: (node) => node === inside };

  assert.equal(ui.mutationTouchesOutsideResult?.([{ target: inside }], root), false);
  assert.equal(ui.mutationTouchesOutsideResult?.([{ target: outside }], root), true);
});

test("keeps the render signature stable for cloned state and changes it for a new selection", () => {
  const state = {
    jobs: [{ id: "job-1", status: "succeeded", lovart_project_id: "project-1" }],
    artifacts: [{ id: "image-1", job_id: "job-1", kind: "image", mime_type: "image/png" }],
  };
  const cloned = JSON.parse(JSON.stringify(state));

  assert.equal(
    ui.resultRenderSignature?.(state, "image-1", false),
    ui.resultRenderSignature?.(cloned, "image-1", false),
  );
  assert.notEqual(
    ui.resultRenderSignature?.(state, "image-1", false),
    ui.resultRenderSignature?.(state, "image-2", false),
  );
});

test("shows only artifacts created after the workbench session baseline", () => {
  const visible = ui.artifactsAfterSubmissionCursor?.({
    jobs: [{ id: "job-old" }, { id: "job-new" }],
    artifacts: [
      { id: "old-result", job_id: "job-old" },
      { id: "new-result", job_id: "job-new" },
    ],
  }, "job-old") ?? [];

  assert.deepEqual(visible.map((artifact) => artifact.id), ["new-result"]);
});

test("captures a session baseline when an older launcher omits the cursor", () => {
  const cursor = ui.resolveSessionSubmissionCursor?.({
    urlCursor: null,
    sessionId: "session-1",
    previousCursor: undefined,
    state: { jobs: [{ id: "job-old" }] },
  });

  assert.equal(cursor, "job-old");
});

test("resets the fresh creator references and prompt through their real UI events", () => {
  let clearClicks = 0;
  const dispatched = [];
  class FakeTextArea {
    constructor() {
      this._value = "old prompt";
      this.ownerDocument = { defaultView: { HTMLTextAreaElement: FakeTextArea, Event } };
    }
    dispatchEvent(event) { dispatched.push(event.type); return true; }
  }
  Object.defineProperty(FakeTextArea.prototype, "value", {
    get() { return this._value; },
    set(value) { this._value = value; },
  });
  const textarea = new FakeTextArea();
  const root = {
    querySelectorAll: () => [{ textContent: "清空全部", click: () => { clearClicks += 1; } }],
    querySelector: () => textarea,
  };

  const result = ui.resetFreshCreator?.(root) ?? { ready: false };

  assert.equal(result.ready, true);
  assert.equal(clearClicks, 1);
  assert.equal(textarea.value, "");
  assert.deepEqual(dispatched, ["input"]);
});

test("renders a fresh-session placeholder without stale cards or follow-up controls", () => {
  const html = ui.renderFreshResultPlaceholder?.() ?? "";

  assert.match(html, /class="irw-empty"/u);
  assert.match(html, /<svg\b/u);
  assert.match(html, /你的创作结果将在这里显示/u);
  assert.doesNotMatch(html, /<p\b|准备新任务后/u);
  assert.doesNotMatch(html, /irw-card|irw-follow/u);
});

test("renders a one-line Lovart loading state while an active job has no result", () => {
  const html = ui.renderLovartLoading?.() ?? "";

  assert.match(html, /irw-loading-spinner/u);
  assert.match(html, /Lovart生成中\.\.\./u);
  assert.doesNotMatch(html, /<p\b/u);
});

test("renders provider-neutral loading labels while retaining the Lovart label", () => {
  assert.deepEqual(
    ui.generationPresentation?.({ status: "generating", snapshot: { provider_id: "fixture-api" } }, { providerLabel: "Fixture API" }),
    { busy: true, label: "Fixture API生成中..." },
  );
  assert.deepEqual(
    ui.generationPresentation?.({ status: "submitted", snapshot: { provider_id: "lovart" } }, { providerLabel: "Lovart" }),
    { busy: true, label: "Lovart生成中..." },
  );
  const genericHtml = ui.renderProviderLoading?.({ providerLabel: "Fixture API" }) ?? "";
  assert.match(genericHtml, /Fixture API生成中\.\.\./u);
  assert.doesNotMatch(genericHtml, /api_key|secret/u);
});

test("renders only public provider metadata in result cards and omits unavailable project links", () => {
  const metadata = ui.redactedProviderMetadata?.({
    snapshot: {
      provider_id: "fixture-api",
      connection_id: "connection-public-id",
      model: "fixture-image",
      credential_values: { api_key: "must-not-render" },
      provider: { display_name: "Fixture API", api_key: "must-not-render" },
    },
  }) ?? {};
  assert.deepEqual(metadata, { provider_id: "fixture-api", connection_id: "connection-public-id", provider_label: "Fixture API", model: "fixture-image" });
  const cards = ui.renderResultCards?.([
    { id: "image-1", kind: "image", mime_type: "image/png" },
  ], "image-1", (id) => `/api/v1/artifacts/${id}/content`, { providerMetadata: metadata }) ?? "";
  assert.match(cards, /Fixture API · fixture-api · connection-public-id · fixture-image/u);
  assert.match(cards, /data-provider-id="fixture-api" data-connection-id="connection-public-id"/u);
  assert.doesNotMatch(cards, /must-not-render|api_key/u);
  const body = ui.renderResultBody?.({ cards, followUp: "", count: 1, providerLabel: metadata.provider_label }) ?? "";
  assert.doesNotMatch(body, /打开 Lovart 项目/u);
});

test("only enables the Lovart continuation controls when the provider declares support", () => {
  assert.equal(ui.providerSupportsContinuation?.({ snapshot: { provider_id: "lovart" } }), true);
  assert.equal(ui.providerSupportsContinuation?.({ snapshot: { provider_id: "fixture-api", provider_capabilities: [] } }), false);
  assert.equal(ui.providerSupportsContinuation?.({ snapshot: { provider_id: "fixture-api", provider_capabilities: ["continuation"] } }), false);
  const withoutFollowUp = ui.renderResultBody?.({ cards: "<article>result</article>", followUp: "", count: 1, providerLabel: "Fixture API" }) ?? "";
  assert.doesNotMatch(withoutFollowUp, /继续编辑|Lovart/u);
});

test("marks only the Codex-to-Lovart pipeline statuses as generating", () => {
  for (const status of ["queued_for_agent", "uploading", "submitted", "generating"]) {
    assert.deepEqual(ui.lovartGenerationPresentation?.({ status }), { busy: true, label: "Lovart生成中..." });
  }
  for (const status of ["awaiting_cost_confirmation", "succeeded", "partially_succeeded", "failed", "cancelled", "declined"]) {
    assert.deepEqual(ui.lovartGenerationPresentation?.({ status }), { busy: false, label: null });
  }
});

test("selects only jobs submitted after the current workbench session cursor", () => {
  const jobs = ui.jobsAfterSubmissionCursor?.({
    jobs: [
      { id: "job-old", status: "succeeded" },
      { id: "job-current", status: "generating" },
    ],
  }, "job-old") ?? [];

  assert.deepEqual(jobs, [{ id: "job-current", status: "generating" }]);
});
