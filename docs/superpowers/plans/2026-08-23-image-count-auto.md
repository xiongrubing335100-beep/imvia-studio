# 图片生成数量 Auto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为图片生成增加默认 Auto 数量模式，使图片拆分等任务可以完整接收 Lovart 返回的任意数量结果。

**Architecture:** 工作台增强脚本负责将图片数量选择扩展为 Auto，并把 DOM 状态序列化为明确的 `count_mode/count` 契约。领域服务负责规范化和校验新旧快照；会话桥只负责准确显示选项。Lovart 适配层继续原样发送提示词且不发送数量限制，结果导入继续以 provider artifacts 为准。

**Tech Stack:** 浏览器原生 JavaScript、Node.js ESM、`node:test`、IMVIA 本地 HTTP/MCP 服务。

**Spec:** `docs/superpowers/specs/2026-08-23-image-count-auto.md`

## Global Constraints

- Auto 不解析、不改写原提示词，不限制、不截断 Lovart 返回结果。
- 图片默认 Auto；视频行为不变。
- 旧数字 count 快照保持兼容。
- 不执行 git commit、push、发布操作。

---

### Task 1: Auto 快照契约

**Files:**
- Modify: `test/workbench-service.test.mjs`
- Modify: `src/domain/workbench-service.js`

**Interfaces:**
- Consumes: `createWorkbenchSubmission({ snapshot, idempotency_key })`
- Produces: 规范化后的 `snapshot.settings.count_mode` 与 `snapshot.settings.count`

- [ ] 写失败测试：Auto 接受 `count: null`，旧数字 count 规范化为 fixed，并拒绝不一致组合。
- [ ] 运行 `node --test test/workbench-service.test.mjs`，确认因缺少规范化而失败。
- [ ] 添加 `normalizeWorkbenchCountSettings(mode, settings)`，只对图片快照扩展契约。
- [ ] 重跑测试并确认通过。

### Task 2: 会话桥摘要

**Files:**
- Modify: `test/bridge-session.test.mjs`
- Modify: `src/bridge/task-message.js`

**Interfaces:**
- Consumes: 已规范化 snapshot
- Produces: Auto 显示为 `设置：… · Auto` 的任务消息

- [ ] 写失败测试：Auto 消息包含 `Auto` 且不包含 `1个`。
- [ ] 运行 `node --test test/bridge-session.test.mjs`，确认失败。
- [ ] 实现 `countLabel(settings)`，同时支持 Auto 和旧数字快照。
- [ ] 重跑测试并确认通过。

### Task 3: 图片数量 UI 与 DOM 序列化

**Files:**
- Modify: `test/skill-contract.test.mjs`
- Modify: `workbench/dist/assets/imvia-result-workspace.js`
- Modify: `workbench/dist/index.html`

**Interfaces:**
- Consumes: 图片页“生成数量”下拉框和当前模式 DOM
- Produces: 图片默认显示 Auto；`readWorkbenchSubmission()` 返回 Auto 契约

- [ ] 写静态契约失败测试：增强脚本必须包含 Auto 安装逻辑、`count_mode` 和 nullable count，且不能用 `|| 1` 把 Auto 转成 1。
- [ ] 运行 `node --test test/skill-contract.test.mjs`，确认失败。
- [ ] 在增强脚本中安装图片数量 Auto 选项，模式切换时图片使用 Auto、视频保留原行为。
- [ ] 修改快照读取逻辑：Auto 输出 `{ count_mode: "auto", count: null }`，数字输出 fixed。
- [ ] 更新资源 cache-busting 版本并重跑测试。

### Task 4: 可变数量执行与结果回归

**Files:**
- Modify: `test/lovart-generation-orchestrator.test.mjs`
- Verify: `src/lovart/generation-orchestrator.js`

**Interfaces:**
- Consumes: Auto 工作台任务
- Produces: 原提示词、无 count 限制的 Lovart 调用，以及全部导入的 artifacts

- [ ] 写失败/契约测试：Auto 执行不向 generate 调用添加 count，也不改写提示词；模拟返回 3 张时全部导入。
- [ ] 运行定向测试确认契约。
- [ ] 若测试暴露固定数量逻辑，仅删除该限制；否则保持适配层不变。
- [ ] 运行 `node --test test/lovart-generation-orchestrator.test.mjs`。

### Task 5: 同步与浏览器验收

**Files:**
- Sync: 当前仓库到已安装 `imvia-studio` 插件缓存（排除运行数据、密钥与 `.git`）

**Interfaces:**
- Consumes: 已验证的工作区变更
- Produces: 当前 Codex 已安装插件可加载的 Auto 工作台

- [ ] 运行完整 `npm test`，确认无失败。
- [ ] 同步到当前已安装插件缓存，不提交仓库。
- [ ] 重新打开工作台并确认图片数量默认 Auto、下拉保留 1/2/4。
- [ ] 浏览器提交一个 Auto 快照，确认会话桥显示 Auto 且不限制结果数量。
