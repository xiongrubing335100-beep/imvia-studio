import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { createWorkbenchService } from "../src/domain/workbench-service.js";
import { createProjectContextService } from "../src/lovart/project-context-service.js";

async function createContext(context) {
  const dataDirectory = await mkdtemp(`${os.tmpdir()}/imvia-project-service-`);
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const workbenchService = createWorkbenchService({ dataDirectory });
  const calls = [];
  const generationService = {
    async validateProject(input) {
      calls.push(["validate", input]);
      if (input.project_id === "missing") {
        const error = new Error("invalid");
        error.code = "INVALID_LOVART_PROJECT";
        throw error;
      }
      return { valid: true, project_name: input.project_id === "project-1" ? "已存在" : "新项目" };
    },
    async createProject(input) {
      calls.push(["create", input]);
      return { project_id: "project-1", project_name: input.project_name || "新项目" };
    },
  };
  return { calls, service: createProjectContextService({ workbenchService, generationService }) };
}

test("select validates an explicit Lovart project before activating it", async (context) => {
  const { calls, service } = await createContext(context);
  const selected = await service.select({ locator: "project-1", source: "user_selected" });
  assert.equal(selected.project_id, "project-1");
  assert.equal(selected.name, "已存在");
  assert.deepEqual(calls, [["validate", { project_id: "project-1" }]]);
  assert.equal((await service.list()).active_lovart_project_id, "project-1");
});

test("remember stores an official project locator locally without contacting Lovart", async (context) => {
  const { calls, service } = await createContext(context);
  const remembered = await service.remember({
    locator: "https://www.lovart.ai/canvas?projectId=project-local",
    source: "user_selected",
  });

  assert.equal(remembered.project_id, "project-local");
  assert.equal(remembered.canvas_url, "https://www.lovart.ai/canvas?projectId=project-local");
  assert.deepEqual(calls, []);
  assert.equal((await service.list()).active_lovart_project_id, "project-local");
});

test("create validates and activates a newly created project", async (context) => {
  const { calls, service } = await createContext(context);
  const created = await service.create({ name: "我的项目" });
  assert.deepEqual(calls, [
    ["create", { project_name: "我的项目" }],
    ["validate", { project_id: "project-1" }],
  ]);
  assert.equal(created.project_id, "project-1");
  assert.equal(created.canvas_url, "https://www.lovart.ai/canvas?projectId=project-1");
  assert.equal((await service.list()).active_lovart_project_id, "project-1");
});

test("resolve chooses explicit, active, then creates once", async (context) => {
  const { calls, service } = await createContext(context);
  assert.deepEqual(await service.resolve({ explicit_locator: "project-1" }), { project_id: "project-1", source: "explicit" });
  assert.equal((await service.list()).active_lovart_project_id, null);
  await service.select({ locator: "project-1", source: "user_selected" });
  assert.deepEqual(await service.resolve({}), { project_id: "project-1", source: "active" });
  const fresh = await createContext(context);
  assert.deepEqual(await fresh.service.resolve({}), { project_id: "project-1", source: "auto_create" });
  assert.equal(fresh.calls.filter(([kind]) => kind === "create").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "create").length, 0);
});

test("an invalid project never changes local active state", async (context) => {
  const { service } = await createContext(context);
  await assert.rejects(() => service.select({ locator: "missing", source: "user_selected" }), (error) => error.code === "INVALID_LOVART_PROJECT");
  assert.equal((await service.list()).active_lovart_project_id, null);
});
