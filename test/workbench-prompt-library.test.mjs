import assert from "node:assert/strict";
import test from "node:test";

const library = await import("../workbench/dist/assets/imvia-prompt-library-v1.js").catch(() => ({}));

test("saves a trimmed prompt once and keeps the newest prompt first", () => {
  const first = library.savePromptEntry?.([], "  雨夜街道，电影级光影。  ", {
    id: "prompt-1",
    createdAt: "2026-08-23T10:00:00.000Z",
  }) ?? [];
  const duplicate = library.savePromptEntry?.(first, "雨夜街道，电影级光影。", {
    id: "prompt-2",
    createdAt: "2026-08-23T10:01:00.000Z",
  }) ?? [];
  const second = library.savePromptEntry?.(duplicate, "角色正面肖像，保持身份一致。", {
    id: "prompt-3",
    createdAt: "2026-08-23T10:02:00.000Z",
  }) ?? [];

  assert.deepEqual(second, [
    { id: "prompt-3", text: "角色正面肖像，保持身份一致。", created_at: "2026-08-23T10:02:00.000Z" },
    { id: "prompt-1", text: "雨夜街道，电影级光影。", created_at: "2026-08-23T10:00:00.000Z" },
  ]);
});

test("deletes only the requested stored prompt", () => {
  const entries = [
    { id: "prompt-1", text: "第一条", created_at: "2026-08-23T10:00:00.000Z" },
    { id: "prompt-2", text: "第二条", created_at: "2026-08-23T10:01:00.000Z" },
  ];

  assert.deepEqual(library.deletePromptEntry?.(entries, "prompt-1") ?? [], [entries[1]]);
});

test("applies a stored prompt through the textarea input contract", () => {
  const events = [];
  class FakeTextArea {
    constructor() {
      this._value = "旧提示词";
      this.ownerDocument = { defaultView: { HTMLTextAreaElement: FakeTextArea, Event } };
    }
    dispatchEvent(event) { events.push(event.type); return true; }
    focus() {}
  }
  Object.defineProperty(FakeTextArea.prototype, "value", {
    get() { return this._value; },
    set(value) { this._value = value; },
  });
  const textarea = new FakeTextArea();

  assert.equal(library.applyPromptToTextarea?.(textarea, "新的提示词"), true);
  assert.equal(textarea.value, "新的提示词");
  assert.deepEqual(events, ["input"]);
});

test("renders callable and deletable prompt entries without trusting stored markup", () => {
  const html = library.renderPromptLibraryEntries?.([
    { id: "prompt-1", text: "<img src=x onerror=alert(1)>", created_at: "2026-08-23T10:00:00.000Z" },
  ]) ?? "";

  assert.match(html, /data-action="apply"/u);
  assert.match(html, /data-action="delete"/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(html, /<img src=x/u);
});

test("shows an explicit add-prompt action instead of saving the current editor implicitly", () => {
  const html = library.renderPromptLibraryDialog?.({ entries: [], editing: false }) ?? "";

  assert.match(html, /data-action="start-add"[^>]*>添加提示词</u);
  assert.doesNotMatch(html, /保存当前提示词/u);
});

test("opens an editor with prompt input, save, and cancel actions", () => {
  const html = library.renderPromptLibraryDialog?.({ entries: [], editing: true, draftText: "雨夜街道" }) ?? "";

  assert.match(html, /textarea[^>]*aria-label="提示词内容"/u);
  assert.match(html, />雨夜街道<\/textarea>/u);
  assert.match(html, /data-action="save-add"[^>]*>保存</u);
  assert.match(html, /data-action="cancel-add"[^>]*>取消</u);
});
