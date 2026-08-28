import assert from "node:assert/strict";
import test from "node:test";
import * as records from "../workbench/dist/assets/imvia-record-management-v1.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function homeProjectDocument(titles) {
  const inserted = [];
  const rows = titles.map((title) => ({
    hidden: false,
    querySelector(selector) {
      return selector === "strong" ? { textContent: title } : null;
    },
  }));
  const grid = {
    hidden: false,
    querySelectorAll(selector) {
      assert.equal(selector, ":scope > button");
      return rows;
    },
    after(element) {
      inserted.push(element);
    },
  };
  const document = {
    querySelector(selector) {
      if (selector === ".project-grid") return grid;
      if (selector === ".imvia-home-projects-empty") return null;
      return null;
    },
    createElement(tagName) {
      assert.equal(tagName, "div");
      return { className: "", innerHTML: "" };
    },
  };
  return { document, grid, inserted, rows };
}

test("remembers deleted project and history ids without mixing record types", () => {
  const storage = memoryStorage();

  records.rememberDeletedRecord(storage, "projects", "project-2");
  records.rememberDeletedRecord(storage, "history", "history-4");

  assert.deepEqual(records.readDeletedRecordIds(storage, "projects"), ["project-2"]);
  assert.deepEqual(records.readDeletedRecordIds(storage, "history"), ["history-4"]);
  assert.deepEqual(
    records.filterVisibleRecords(storage, "projects", [{ id: "project-1" }, { id: "project-2" }]),
    [{ id: "project-1" }],
  );
});

test("treats malformed local record preferences as empty and validates record types", () => {
  const storage = memoryStorage({ "imvia.record-management.v1.projects": "not-json" });

  assert.deepEqual(records.readDeletedRecordIds(storage, "projects"), []);
  assert.throws(() => records.readDeletedRecordIds(storage, "assets"), /Unsupported record type/u);
});

test("hides deleted projects from the home recent-project grid", () => {
  const storage = memoryStorage();
  const home = homeProjectDocument(["雨夜街景短片", "人物角色设定", "花境风格测试"]);

  for (const title of ["雨夜街景短片", "人物角色设定", "花境风格测试"]) {
    records.rememberDeletedRecord(storage, "projects", records.recordIdFromTitle("projects", title));
  }

  assert.equal(typeof records.reconcileHomeProjectCards, "function");
  assert.deepEqual(records.reconcileHomeProjectCards(home.document, storage), { hidden: 3, visible: 0 });
  assert.deepEqual(home.rows.map((row) => row.hidden), [true, true, true]);
  assert.equal(home.grid.hidden, true);
  assert.equal(home.inserted.length, 1);
  assert.match(home.inserted[0].innerHTML, /还没有项目/u);
});

test("starts every live workbench with empty seed data without losing its session", () => {
  const liveUrl = "http://127.0.0.1:65214/workbench?imvia=live&session=session-1&bridge_token=bridge-1&submission_cursor=cursor-1#home";
  const mockUrl = "http://127.0.0.1:65214/workbench?imvia=mock#home";
  const replacements = [];

  assert.equal(typeof records.liveWorkbenchEmptySeedUrl, "function");
  assert.equal(typeof records.ensureLiveWorkbenchEmptySeed, "function");
  assert.equal(
    records.liveWorkbenchEmptySeedUrl(liveUrl),
    "http://127.0.0.1:65214/workbench?imvia=live&session=session-1&bridge_token=bridge-1&submission_cursor=cursor-1&empty=1#home",
  );
  assert.equal(records.liveWorkbenchEmptySeedUrl(mockUrl), mockUrl);
  assert.equal(records.ensureLiveWorkbenchEmptySeed({
    location: { href: liveUrl },
    history: { replaceState: (...args) => replacements.push(args) },
  }), true);
  assert.deepEqual(replacements, [[
    null,
    "",
    "http://127.0.0.1:65214/workbench?imvia=live&session=session-1&bridge_token=bridge-1&submission_cursor=cursor-1&empty=1#home",
  ]]);
});

test("workbench exposes persistent project/history delete controls", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../workbench/dist/assets/imvia-record-management-v1.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../workbench/dist/index.html", import.meta.url), "utf8");

  assert.match(source, /确认删除项目/u);
  assert.match(source, /确认删除任务记录/u);
  assert.match(source, /rememberDeletedRecord/u);
  assert.match(source, /\/api\/v1\/projects\//u);
  assert.match(html, /imvia-record-management-v1\.js/u);
});
