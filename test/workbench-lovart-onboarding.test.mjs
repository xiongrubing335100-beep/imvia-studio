import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("workbench keeps onboarding separate from the connected-only status rail", async () => {
  const source = await readFile(path.join(root, "workbench/dist/assets/imvia-lovart-bridge-v3.js"), "utf8");
  const app = await readFile(path.join(root, "workbench/dist/assets/index-B6L6y8bp.js"), "utf8");
  const html = await readFile(path.join(root, "workbench/dist/index.html"), "utf8");
  assert.equal(source.includes("URLSearchParams"), false);
  assert.equal(source.includes(["Lovart", "未连接"].join(" ")), false);
  assert.equal(source.includes("Lovart 已连接"), false);
  assert.equal(source.includes("重试连接"), false);
  assert.equal(source.includes("lovart.onboarding"), false);
  assert.equal(source.includes("sessionStorage"), false);
  assert.ok(source.includes("document.cookie"));
  assert.ok(source.includes("Max-Age=31536000"));
  assert.ok(source.includes("localStorage"));
  assert.ok(source.includes("imvia-lovart-onboarding-completed-v2"));
  assert.ok(source.includes("rememberCompletedSetup"));
  assert.ok(source.includes('state === "connected"'));
  assert.ok(source.includes('post("/api/v1/lovart/connect")'));
  assert.ok(source.includes("startFirstOpen"));
  assert.ok(app.includes("工作台已连接 · Lovart 未检测"));
  assert.ok(html.includes("imvia-lovart-bridge-v3.js"));
  assert.ok(html.includes("imvia-lovart-onboarding.css"));
  assert.equal(/type=["']password["']/i.test(source), false);
});
