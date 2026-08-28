# IMVIA Studio：Codex 当前会话桥与 Lovart MCP 统一任务链路 Spec

- 文档状态：`APPROVED_FOR_IMPLEMENTATION`
- 日期：2026-08-23
- 目标版本：IMVIA Studio `0.4.x`（最终版本号在发布前确认）
- 适用范围：IMVIA Studio 本地 Codex 插件、右侧工作台、IMVIA 自有 Lovart 执行链路
- 编码许可：**已批准**。按本 Spec 实施；本轮只做本地代码改造和验证，不提交仓库、不发布、不重新安装。

## 1. 摘要

本次改造将 IMVIA Studio 从“工作台写入本地队列，Codex 代理持续调用 `imvia_wait_for_workbench_submission` 轮询”的模式，升级为“当前 Codex 任务挂载 MCP App 会话桥，由会话桥通过宿主 `ui/message` 把所有需要执行的工作台任务作为真实用户消息投递到当前会话”的模式。

目标主链路：

```text
IMVIA Studio 右侧工作台
  -> 本地可靠发件箱（只负责持久化和断线恢复）
  -> 当前 Codex 任务中挂载的 IMVIA Studio 会话桥 App
  -> Codex 宿主 ui/message（role=user）
  -> 当前 Codex 会话出现真实、可见的工作台任务消息
  -> Codex 立即确认收到
  -> Codex 调用 IMVIA Studio MCP 执行工具
  -> IMVIA 自有 Lovart 适配器执行上传、生成、查询、结果导入
  -> MCP 进度通知 + 本地 SSE 同步状态
  -> 当前 Codex 会话和工作台同时展示进度与结果
```

浏览器工作台不得直接触发 Lovart 副作用；独立的 Lovart 插件不得被读取、修改、导入或依赖。Codex 驱动 Lovart 的含义是：Codex 在当前会话中调用 IMVIA Studio 暴露的 MCP 工具，再由 IMVIA Studio 的独立 Lovart 适配器执行。

## 2. 问题定义

### 2.1 当前问题

当前实现存在以下结构性问题：

1. `imvia_open_workbench` 只返回 `workbench_url` 和 `submission_cursor`，没有挂载 MCP App 会话桥。
2. `/api/v1/workbench/submissions` 只创建本地 `queued_for_agent` 任务。
3. `imvia_wait_for_workbench_submission` 依赖当前 Codex 回合持续等待；回合结束、Codex 重启或等待未启动时，消息不会进入会话。
4. “已进入 Codex 会话桥”“Codex 已接收”等文字在真实宿主投递或 Codex 接收前出现，状态含义不准确。
5. 工作台显示“已发送给 Codex”，但当前会话中可能没有真实用户消息。
6. 工作台任务、Codex 接收状态和 Lovart 执行状态混在同一个 `job.status` 中，无法准确判断失败发生在投递、接收还是生成阶段。

### 2.2 根因

右侧工作台是普通 loopback 网页，不拥有当前 Codex 对话的宿主消息能力。只有挂载在当前 Codex 任务里的 MCP App View 才能通过宿主协议发送 `ui/message`。

因此，代理侧的 MCP 长轮询不是会话桥；本地队列也不是会话桥。真正的桥必须同时具备：

- 由打开工作台的 MCP 工具在当前任务中挂载；
- 持有与当前工作台实例对应的 `workbench_session_id`；
- 与宿主完成 `ui/initialize`；
- 调用宿主 `ui/message`；
- 对投递、接收和执行分别确认。

## 3. 目标

### 3.1 产品目标

1. 工作台内所有需要 Codex 或 Lovart 执行的任务，统一先进入打开它的当前 Codex 会话。
2. 用户在会话框中能看到真实工作台提交消息，以及 Codex 的真实回复。
3. Codex 收到消息后，通过 MCP 启动 Lovart 操作。
4. 图片、视频、编辑、素材、项目和费用相关状态持续返回当前会话，并同步到工作台。
5. Codex 或本地服务重启后，不重复执行已接收任务，也不丢失尚未投递任务。
6. 工作台永远不把“写入本地”描述成“Codex 已接收”。

### 3.2 工程目标

1. 移除代理长轮询作为主链路。
2. 使用标准 MCP Apps 工具/资源注册和 `ui/message`。
3. 会话、投递和执行拥有独立且可审计的状态机。
4. 所有有副作用的 Lovart 调用只能从模型可见的 MCP 执行工具进入。
5. 兼容当前本地 JSON 状态、SSE 和 Lovart 执行器，并通过迁移升级。
6. 支持多个 Codex 任务同时打开各自独立的 IMVIA Studio 工作台。

## 4. 非目标

本次不包括：

1. 重写整个 IMVIA Studio 前端或更换视觉设计系统。
2. 将工作台完整嵌入会话；完整工作台仍然在右侧浏览器面板。
3. 让浏览器直接调用 Lovart API、独立 Lovart 插件或任意生成服务。
4. 在 IMVIA Studio 与现有独立 Lovart 插件之间共享密钥、状态、进程或文件。
5. 自动批准 Lovart 费用。
6. 在断线时悄悄切换到 Codex ImageGen 或其他提供方。
7. 自动重放旧版本中含义不明确的 `queued_for_agent` 任务。
8. 在 Spec 审批前进行代码、构建、插件安装或仓库提交。

## 5. 拟定设计决策（待本 Spec 审批）

### D1. 当前任务绑定由 MCP App 能力实现

不持久化或猜测 Codex `thread_id`。会话桥 App 被宿主挂载在哪个 Codex 任务中，`ui/message` 就进入哪个任务。这是精确绑定，不使用“最近会话”推断。

### D2. 工作台是任务编辑器，不是执行器

工作台负责：

- 编辑草稿；
- 保存本地素材引用；
- 创建不可变任务快照；
- 把任务写入可靠发件箱；
- 展示本地状态和结果。

工作台不负责：

- 验证或创建 Lovart 项目；
- 上传 Lovart 素材；
- 发起 Lovart 生成；
- 查询生成状态；
- 确认费用。

### D3. Codex 通过 IMVIA Studio MCP 驱动 Lovart

标准执行入口为：

```text
Codex -> imvia_execute_workbench_submission -> IMVIA Lovart orchestrator -> Lovart
```

该路径满足“Codex 通过 MCP 驱动 Lovart”，同时保持 IMVIA Studio 与独立 Lovart 插件完全隔离。

### D4. 本地队列保留，但降级为可靠发件箱

本地持久化仍然必要，用于：

- 页面刷新；
- 会话桥短暂离线；
- Codex 或 MCP 进程重启；
- 幂等和审计。

它不得直接代表消息已进入 Codex。

### D5. 一条任务只有一个不可变执行快照

可见会话消息提供人类可读摘要和 `job_id`/`snapshot_digest`。真正执行时，MCP 工具按 `job_id` 读取服务端不可变快照，不让模型重新拼装参数，避免提示词、模型、附件或项目上下文发生漂移。

## 6. 术语

| 术语 | 定义 |
|---|---|
| Workbench Session | 一次 `imvia_open_workbench` 创建的工作台打开会话 |
| Bridge App | 挂载在当前 Codex 任务中的轻量 MCP App 卡片 |
| Bridge Presence | Bridge App 的注册、心跳和活动所有权 |
| Dispatch | 一个等待通过 `ui/message` 投递的任务消息 |
| Host Accepted | Codex 宿主接受了 `ui/message` 请求 |
| Codex Received | 当前 Codex 回合已经读取任务，并开始调用执行 MCP 工具 |
| Execution Job | Lovart 上传、提交、生成、确认和结果导入的持久化任务 |
| Reliable Outbox | 工作台与 Bridge App 之间的本地持久化发件箱 |

## 7. 目标架构

### 7.1 组件关系

```text
┌─────────────────────────────┐
│ Right-side Workbench        │
│ draft / assets / submit UI  │
└──────────────┬──────────────┘
               │ POST submission + session binding
               v
┌─────────────────────────────┐
│ Local HTTP + Outbox Store   │
│ immutable snapshot/dispatch │
└──────────────┬──────────────┘
               │ app-only MCP tools: claim/ack/release
               v
┌─────────────────────────────┐
│ MCP App Bridge Card         │
│ mounted in current task     │
└──────────────┬──────────────┘
               │ ui/message role=user
               v
┌─────────────────────────────┐
│ Current Codex Conversation  │
│ visible message + response  │
└──────────────┬──────────────┘
               │ model-visible MCP call
               v
┌─────────────────────────────┐
│ IMVIA Execution MCP         │
│ validate / upload / create  │
└──────────────┬──────────────┘
               │ fixed Lovart adapter
               v
┌─────────────────────────────┐
│ Lovart                      │
└──────────────┬──────────────┘
               │ progress/results
               v
       MCP progress + SSE
```

### 7.2 技术依赖

- 保留 `@modelcontextprotocol/sdk` 和 Zod。
- 新增并锁定 `@modelcontextprotocol/ext-apps`，实现 `registerAppTool`、`registerAppResource`、`RESOURCE_MIME_TYPE` 和 View 侧宿主通信。
- 初始实施建议锁定 `@modelcontextprotocol/ext-apps@1.7.5`；编码开始前再次验证它与当前 `@modelcontextprotocol/sdk@1.30.0` 的兼容性，随后冻结 lockfile。
- 官方参考：
  - [MCP Apps Quickstart](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/quickstart.md)
  - [MCP Apps Overview](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/overview.md)
  - [Build an MCP App](https://modelcontextprotocol.io/extensions/apps/build)
  - [`registerAppResource` API](https://apps.extensions.modelcontextprotocol.io/api/functions/server-helpers.registerAppResource.html)

## 8. 会话生命周期

### 8.1 打开工作台

`imvia_open_workbench` 必须：

1. 确保 loopback HTTP 服务健康。
2. 生成新的 `workbench_session_id` 和一次性 `open_token`。
3. 创建会话状态 `opening`。
4. 返回绑定该 session 的 `workbench_url`。
5. 通过 `_meta.ui.resourceUri` / `openai/outputTemplate` 挂载 Bridge App。
6. Bridge App 完成 `ui/initialize`、注册和首次心跳。
7. Bridge App 状态变为 `ready`。
8. 当前 Codex 任务显示“IMVIA Studio 会话桥接已就绪”。

`imvia_open_workbench` 返回时只能确认工作台 HTTP 服务已就绪，以及宿主已获得需要挂载的 App resource；在 Bridge App 完成第 6 步之前，不得声称会话桥已经就绪。

建议输出：

```json
{
  "workbench_state": "ready",
  "bridge_state": "mounting",
  "workbench_url": "http://127.0.0.1:<port>/workbench?imvia=live&session=<id>&open=<nonce>",
  "workbench_session_id": "uuid",
  "bridge_protocol_version": "imvia.conversation-bridge.v1",
  "placement": "right"
}
```

### 8.2 会话安全绑定

- HTTP 只绑定 `127.0.0.1`。
- `open_token` 为高熵、一次性、短期有效值，只用于首次建立 session cookie。
- 首次打开页面后，由服务端设置 `HttpOnly; SameSite=Strict; Path=/` 的临时工作台会话 cookie，并从后续 URL/页面状态中移除 token。
- `workbench_session_id` 是相关性 ID，不是 Lovart 凭据。
- HTTP 写接口校验 Origin、session cookie 和目标 session 状态。
- Bridge App 的 app-only MCP 工具必须同时验证 `bridge_id`、`workbench_session_id` 和 claim lease。
- AK/SK、原始 Lovart 响应和本地密钥文件路径不得进入 session、dispatch、会话消息或日志。

### 8.3 Bridge Presence

会话桥状态：

```text
opening -> ready -> stale -> closed
                 -> superseded
```

初始默认值：

- 心跳间隔：5 秒；
- 20 秒没有心跳：`stale`；
- dispatch claim lease：30 秒；
- 同一 session 只允许一个 active bridge；新 bridge 注册后旧 bridge 变为 `superseded`。

这些数值作为集中常量实现，测试使用 fake clock，不在 UI 中暴露配置。

## 9. 统一任务协议

### 9.1 Task Envelope

所有需要 Codex 执行的工作台任务使用统一 envelope：

```json
{
  "schema_version": "imvia.workbench-task.v1",
  "job_id": "uuid",
  "dispatch_id": "uuid",
  "workbench_session_id": "uuid",
  "task_type": "image.generate",
  "snapshot_digest": "sha256:...",
  "submitted_at": "ISO-8601",
  "activation": {
    "source": "workbench_action"
  },
  "summary": {
    "mode": "image",
    "model": "Image 2",
    "project_locator": "https://www.lovart.ai/canvas?projectId=...",
    "prompt": "...",
    "references": [
      { "id": "...", "label": "图片1", "kind": "image" }
    ],
    "settings": {
      "ratio": "3:4",
      "resolution": "2K",
      "count": 1
    }
  }
}
```

支持的初始 `task_type`：

- `image.generate`
- `video.generate`
- `result.follow_up`

项目验证或创建只是上述执行任务中的受控前置步骤，不是浏览器可独立触发的 Task Envelope。费用确认必须来自当前 Codex 会话中的明确回复，也不是工作台 Task Envelope。

后续扩展任务类型必须升级 schema 或保持向后兼容。

### 9.2 可见会话消息

Bridge App 投递的 `ui/message` 使用 `role: user`，正文格式固定、可读、不可误解：

```text
【IMVIA Studio 工作台提交】
任务已从当前工作台提交到本 Codex 会话。
job_id: <uuid>
类型：图片生成
模型：Image 2
项目：<locator or 自动创建>
参考素材：图片1、图片2
设置：3:4 · 2K · 1个
创意描述：<prompt>
snapshot_digest: <digest>

请先回复“已收到工作台任务，正在处理”，然后调用
imvia_execute_workbench_submission 执行该 job_id，并持续同步 Lovart 状态。
```

附件不以完整 base64 填入文本。消息可附带最多一张受控缩略图；执行工具始终从受管本地附件引用读取原始素材。

### 9.3 不变量

1. `job_id` 一经创建不可变化。
2. `snapshot_digest` 必须覆盖提示词、模型、设置、项目定位和附件引用。
3. 同一个 `dispatch_id` 至多成功调用一次宿主 `ui/message`。
4. 宿主接受消息不等于 Codex 已接收。
5. 只有 `imvia_execute_workbench_submission` 被当前会话调用后，才可写入 `codex_received_at`。
6. 同一个 `job_id` 的 Lovart 初始提交最多一次；重试必须走幂等恢复，不得创建第二个任务。
7. 费用确认不随任务、父任务或旧会话继承。

## 10. 状态模型

### 10.1 分离投递与执行状态

新增独立字段，禁止再用一个状态表达两条生命周期：

```json
{
  "delivery": {
    "state": "pending_bridge",
    "session_id": "...",
    "dispatch_id": "...",
    "bridge_id": null,
    "claim_token": null,
    "claimed_at": null,
    "lease_expires_at": null,
    "host_accepted_at": null,
    "codex_received_at": null,
    "attempt_count": 0,
    "last_error": null
  },
  "execution": {
    "state": "not_started",
    "attempt": 1,
    "lovart_thread_id": null,
    "last_progress_at": null,
    "error": null
  }
}
```

### 10.2 投递状态机

```text
pending_bridge
  -> claimed
  -> host_accepted
  -> codex_received

claimed -> pending_bridge          lease 到期或显式释放
pending_bridge -> delivery_failed  非重试错误
host_accepted -> delivery_uncertain  宿主接受后进程中断，等待人工/幂等恢复
任意未执行状态 -> cancelled
```

### 10.3 执行状态机

```text
not_started
  -> accepted
  -> uploading
  -> submitted_to_lovart
  -> awaiting_cost_confirmation | generating
  -> importing_results
  -> succeeded | partially_succeeded | failed | cancelled | declined
```

### 10.4 用户可见状态文案

| 内部事实 | 工作台文案 |
|---|---|
| Bridge ready, no job | `工作台已连接 · 会话桥已就绪` |
| `pending_bridge` | `任务已保存，等待发送到当前 Codex 会话` |
| `claimed` | `正在发送到当前 Codex 会话` |
| `host_accepted` | `消息已进入当前 Codex 会话，等待 Codex 接收` |
| `codex_received` | `Codex 已接收，正在处理` |
| `uploading` | `Codex 正在通过 MCP 准备并上传素材` |
| `submitted_to_lovart` | `已通过 MCP 提交 Lovart` |
| `generating` | `Lovart 正在生成` |
| `awaiting_cost_confirmation` | `等待你在当前 Codex 会话确认费用` |
| bridge stale/offline | `会话桥未连接，任务尚未发送` |

禁止在 `host_accepted` 之前显示“已发送”，禁止在 `codex_received` 之前显示“Codex 已接收”。

## 11. MCP 工具与资源契约

### 11.1 MCP App Resource

新增：

```text
ui://imvia-studio/conversation-bridge-v1.html
```

资源只渲染轻量状态卡，不渲染完整工作台。它包含：

- 会话桥状态；
- 当前绑定工作台 session；
- 待投递任务数量；
- 当前投递任务摘要；
- 离线或失败时的明确原因；
- 必要时的“重新发送”用户手势按钮。

### 11.2 `imvia_open_workbench`

模型可见。调用时请求宿主挂载 Bridge App，并返回第 8.1 节输出。工具返回时 `workbench_state` 可以是 `ready`，但 `bridge_state` 只能是 `mounting`；只有 App 完成初始化、注册和首次心跳后，桥状态才变成 `ready`。

MCP 元数据至少包含：

```json
{
  "ui": {
    "resourceUri": "ui://imvia-studio/conversation-bridge-v1.html",
    "visibility": ["model", "app"]
  },
  "openai/outputTemplate": "ui://imvia-studio/conversation-bridge-v1.html",
  "openai/widgetAccessible": true
}
```

### 11.3 App-only bridge tools

以下工具设置 `visibility: ["app"]`，不污染模型工具列表：

#### `imvia_register_conversation_bridge`

输入：`bridge_id`、`workbench_session_id`、`connected_at`。

输出：`active`、`bridge_id`、`session_id`、`last_seen_at`、`pending_count`。

#### `imvia_heartbeat_conversation_bridge`

刷新活动桥心跳。旧桥或错误 session 返回 `active: false`。

#### `imvia_claim_next_workbench_dispatch`

只领取绑定当前 session 的下一条 FIFO dispatch，返回 `claim_token` 和 lease。

#### `imvia_mark_dispatch_host_accepted`

只记录宿主已接受 `ui/message`。不得写 `codex_received_at`。

#### `imvia_release_dispatch_claim`

发送失败时释放 claim，记录经过脱敏的错误代码和重试次数。

#### `imvia_get_bridge_status`

返回当前桥、session、队列和最后错误的脱敏摘要。

### 11.4 模型可见执行工具

#### `imvia_execute_workbench_submission`

保留现有工具名，收紧契约：

```json
{
  "job_id": "uuid",
  "snapshot_digest": "sha256:..."
}
```

调用时必须原子完成：

1. 验证 job、digest、activation 和 delivery；
2. 将 `delivery.state` 从 `host_accepted` 更新为 `codex_received`；
3. 写入 `codex_received_at`；
4. 将 execution 更新为 `accepted`；
5. 继续项目解析、素材上传和 Lovart 执行；
6. 通过 MCP progress notifications 汇报里程碑；
7. 通过持久化状态触发工作台 SSE 更新。

重复调用相同 job 必须返回已有执行状态或恢复轮询，不重复上传/提交。

### 11.5 旧轮询工具

`imvia_wait_for_workbench_submission`：

- 从技能主流程中移除；
- 第一阶段保留但标记 deprecated，仅用于旧客户端诊断；
- 不再允许把该工具处于等待状态描述为“会话桥已挂载”；
- 新桥稳定并完成兼容验证后，在后续大版本删除。

## 12. HTTP API 调整

### 12.1 新增/调整接口

#### `GET /api/v1/workbench/session`

返回当前浏览器 session 的脱敏状态：

```json
{
  "session_id": "uuid",
  "bridge_state": "ready",
  "bridge_last_seen_at": "ISO-8601",
  "pending_count": 0
}
```

#### `POST /api/v1/workbench/submissions`

请求继续包含 `snapshot` 和 `idempotency_key`，session 从受保护 cookie 解析，不接受浏览器任意指定其他 session。

返回只描述真实状态：

```json
{
  "job_id": "uuid",
  "dispatch_id": "uuid",
  "delivery_state": "pending_bridge",
  "status_message": "任务已保存，等待发送到当前 Codex 会话"
}
```

#### `GET /api/v1/jobs/:jobId/delivery`

返回投递和执行的脱敏状态，供页面恢复和测试使用。

### 12.2 禁止浏览器发起的 Lovart 副作用

以下现有浏览器路径不得再作为工作台主链路：

- `POST /api/v1/generations`
- 浏览器直接调用项目创建/验证副作用接口
- 浏览器直接执行 `follow-ups`

迁移方式：

- 工作台按钮统一创建 workbench submission；
- 项目地址只做本地语法归一化和记忆；
- 继续编辑也生成新的 Task Envelope，先进入 Codex 会话；
- 真正的项目验证、创建、上传、生成和 follow-up 只在模型可见 MCP 工具中执行。

只读状态、素材本地上传、草稿保存、SSE 和受管结果读取继续保留 HTTP 接口。

## 13. 端到端流程

### 13.1 正常图片/视频生成

1. 用户在当前 Codex 任务中打开 IMVIA Studio。
2. `imvia_open_workbench` 挂载 Bridge App 并返回工作台 URL。
3. Codex 打开右侧工作台。
4. Bridge App 注册、心跳，显示已就绪。
5. 用户填写参数并点击提交。
6. HTTP 服务创建不可变 job + dispatch，状态 `pending_bridge`。
7. Bridge App claim dispatch。
8. Bridge App 调用 `ui/message`，当前会话出现真实用户消息。
9. 宿主接受后记录 `host_accepted`。
10. Codex 回复“已收到工作台任务，正在处理”。
11. Codex 调用 `imvia_execute_workbench_submission`。
12. 工具记录 `codex_received`，然后解析项目、上传素材并调用 Lovart。
13. 工具持续报告进度；Codex 在当前会话同步关键状态。
14. 本地状态通过 SSE 更新工作台。
15. 结果导入完成后，会话给出结果，工作台展示受管预览。

### 13.2 费用确认

1. Lovart 返回费用确认。
2. 执行工具持久化 `awaiting_cost_confirmation` 并返回金额、单位、job、attempt 和 fingerprint。
3. Codex 在当前会话询问用户，不由 Bridge App 或工作台自动确认。
4. 用户明确接受后，Codex 调用现有费用决策/确认 MCP 工具。
5. 确认一次性消费；失败需要新的明确授权，不能自动重试。

### 13.3 会话桥离线

1. 工作台仍可编辑草稿。
2. 提交按钮显示“会话桥未连接”；用户提交时可保存到 outbox，但必须显示“尚未发送”。
3. 重新在当前 Codex 任务打开插件后，新 Bridge App 领取未投递任务。
4. 已 `host_accepted` 的任务不自动重发；进入 `delivery_uncertain` 时必须按幂等记录恢复或由用户选择重新投递。

### 13.4 Codex/MCP 重启

- 新进程使用新端口和新 session。
- 旧 bridge heartbeat 自动过期。
- 未 host-accepted 的 pending dispatch 可在用户重新打开工作台后重新绑定新 session。
- 已 host-accepted 但未 codex-received 的 dispatch 不自动重复发送，显示“投递状态待确认”。
- 已 codex-received 的 execution 通过 `job_id`、Lovart thread 和幂等键恢复，不创建第二个 Lovart 请求。

### 13.5 多任务

- 每个 session 使用 FIFO。
- 同一 session 同时最多一个未确认 dispatch。
- 上一个 dispatch 到达 `codex_received`、失败或取消后，桥才发送下一条。
- 不同 Codex 任务的 session 完全隔离，可并行。

## 14. Codex 技能协议调整

`skills/imvia-studio/SKILL.md` 将改为：

1. 打开工作台后不再要求代理调用长轮询。
2. 必须验证 `imvia_open_workbench` 返回 `workbench_state: ready` 和 session；不得把初始 `bridge_state: mounting` 描述为桥已就绪。
3. 必须打开返回的右侧工作台 URL。
4. 工作台任务通过 MCP App `ui/message` 作为新用户消息重新进入当前任务。
5. 收到 `[IMVIA Studio 工作台提交]` 后立即给出可见确认。
6. 只调用一次 `imvia_execute_workbench_submission`，使用消息中的 job/digest。
7. 不重写不可变 prompt，不重新创建 job。
8. 把 MCP 进度中的接收、上传、提交、生成、费用、导入、失败和完成同步给用户。
9. 当 bridge 不支持或离线时，禁止声称任务已经进入会话。

## 15. 进度同步策略

### 15.1 当前 Codex 会话

Codex 至少在以下节点产生可见消息：

- 已收到任务；
- 开始准备/上传素材；
- 已提交 Lovart；
- 需要费用确认；
- Lovart 生成中（仅在状态变化或合理时间间隔更新，避免刷屏）；
- 完成、部分完成或失败。

### 15.2 工作台

- 继续使用本地 SSE `job.updated` / `artifact.imported`；
- 增加 `bridge.updated` / `delivery.updated`；
- 页面刷新后从持久化状态恢复；
- toast 只用于短反馈，长期状态必须在固定状态区域展示；
- toast 不得作为唯一的错误或成功证据。

## 16. 持久化与迁移

### 16.1 Schema 升级

本地状态由 schema v2 升级为 v3，新增：

- `workbench_sessions[]`
- `dispatches[]` 或与 job 一对一的 delivery 记录
- `job.delivery`
- `job.execution`
- bridge 审计事件

### 16.2 旧任务迁移

- 已成功/失败/取消的旧任务保留原状态并生成只读 execution 投影。
- `direct_generation: true` 的旧任务按当前事实映射为已接收或执行中。
- 未执行的旧 `queued_for_agent` 任务标记 `legacy_pending_review`，不自动发送、不自动调用 Lovart，避免重复生成或产生费用。
- UI 允许用户查看旧任务，并明确要求重新提交一个新版本任务快照。

### 16.3 存储安全

- 私有状态目录和文件继续使用最小权限。
- dispatch 不包含凭据。
- 错误只持久化稳定 code 和脱敏 message。
- prompt 和受管附件引用可以持久化，但不得写入系统日志或 MCP 工具描述。

## 17. 错误模型

新增稳定错误码：

| 错误码 | 含义 | 是否自动重试 |
|---|---|---|
| `BRIDGE_UNAVAILABLE` | 当前 session 没有活动 Bridge App | 否，等待重新打开 |
| `BRIDGE_SUPERSEDED` | 当前桥已被新桥替代 | 否 |
| `HOST_MESSAGE_UNSUPPORTED` | Codex 宿主不支持 `ui/message` | 否，禁止降级伪发送 |
| `DISPATCH_LEASE_CONFLICT` | dispatch 被其他活动桥领取 | 是，等待 lease |
| `DISPATCH_DELIVERY_FAILED` | 宿主拒绝或发送失败 | 仅显式/有界重试 |
| `DELIVERY_STATE_CONFLICT` | 执行工具在错误投递状态被调用 | 否，重新读取状态 |
| `SNAPSHOT_DIGEST_MISMATCH` | 消息与持久化快照不一致 | 否，安全停止 |
| `SESSION_EXPIRED` | 工作台 session 已失效 | 否，重新打开工作台 |

发送前失败可以安全释放 lease；宿主已接受后的未知结果不得盲目重发。

## 18. 文件级实施计划

### 新增

```text
src/bridge/
  bridge-resource.js          MCP App HTML/JS 资源构建
  bridge-session-service.js   session、presence、heartbeat、接管
  dispatch-service.js         outbox、claim、lease、ack、release
  task-message.js             固定可见消息与摘要构建
  constants.js                TTL、lease、协议版本

test/
  bridge-session.test.mjs
  bridge-dispatch.test.mjs
  bridge-resource.test.mjs
  bridge-message.test.mjs
  bridge-e2e.test.mjs
```

### 修改

```text
package.json / pnpm-lock.yaml
  增加并锁定 MCP Apps 依赖

src/index.js
  注册 MCP App resource、桥工具、升级 open_workbench 输出、调整 execute 接收确认

src/http/server.js
  session bootstrap、submission 绑定、delivery 状态接口、Origin/cookie 校验、SSE 事件

src/domain/workbench-service.js
  v3 状态、delivery/execution 分离、迁移、准确状态文案

src/lovart/generation-orchestrator.js
  只从 MCP 执行入口启动、幂等恢复、进度映射

workbench/dist/assets/imvia-result-workspace.js
  session/bridge 状态、统一提交、准确按钮和固定状态展示、follow-up 改走会话桥

workbench/dist/index.html
  更新受控扩展脚本版本；不修改主哈希 bundle

skills/imvia-studio/SKILL.md
  移除代理等待主链路，定义真实会话消息处理协议

.codex-plugin/plugin.json / README.md
  更新能力说明和工具清单
```

前端当前只有已构建 bundle，因此本次只修改现有、可维护的 IMVIA 扩展脚本，不直接改写压缩主 bundle。若后续取得原始前端源码，再把扩展逻辑回迁源码并重新构建。

## 19. 测试计划

### 19.1 单元测试

- session 创建、过期、接管和隔离；
- heartbeat fake clock；
- FIFO dispatch；
- claim lease、释放、过期和冲突；
- host accepted 与 codex received 严格分离；
- message 格式、摘要、digest 和特殊字符；
- 幂等提交和 digest 冲突；
- v2 -> v3 数据迁移；
- 凭据、路径和原始上游数据不进入输出。

### 19.2 MCP 集成测试

- `imvia_open_workbench` 返回 session 并关联 `ui://` resource；
- open 工具只报告工作台 ready / 桥 mounting，Bridge App 首次心跳后才报告桥 ready；
- resource MIME、CSP 和脚本完整；
- App-only 工具对模型不可见、对 App 可调用；
- 模拟 `ui/initialize` 和 `ui/message`；
- `ui/message` 成功才写 `host_accepted`；
- 执行工具调用才写 `codex_received`；
- 重复执行不产生第二次 Lovart submit。

### 19.3 HTTP/SSE 集成测试

- session cookie 和 Origin 校验；
- 无 session、过期 session、错误 session 被拒绝；
- submission 返回真实 delivery 状态；
- `bridge.updated` / `delivery.updated` / `job.updated` 顺序；
- 页面刷新恢复状态；
- 多 session 隔离。

### 19.4 Lovart 隔离测试

- 桥和 UI 测试使用 fixture/mock，真实 Lovart 请求为零；
- HTTP 工作台提交不触发 Lovart；
- 只有执行 MCP 工具可以启动 Lovart；
- 独立 Lovart 插件受保护路径无变化；
- AK/SK 不出现在 MCP 参数、HTTP body、任务、日志和测试快照。

### 19.5 Codex 桌面手工验收

1. 新任务中打开工作台，会话出现“桥接已就绪”卡片。
2. 工作台提交图片任务，当前会话出现真实用户消息。
3. Codex 返回可见“已收到，正在处理”。
4. Codex 调用 MCP，工作台依次显示接收、上传、Lovart 提交和生成状态。
5. 完成后会话和工作台均能查看结果。
6. 视频任务重复同一流程。
7. 继续编辑先进入当前会话，再执行 Lovart。
8. 费用任务停在确认，未经会话明确同意零确认调用。
9. 关闭 Bridge App 后，工作台不得显示“已发送”。
10. 重启 Codex 后重新打开，旧桥过期、新桥就绪、未投递任务可恢复。
11. 连续提交两个任务，按顺序进入同一会话且不重复。
12. 两个 Codex 任务同时打开工作台，消息不串会话。

## 20. 验收标准

以下条件必须全部满足，才能认定改造完成：

1. 代理不再依赖 `imvia_wait_for_workbench_submission` 才能收到工作台任务。
2. 每个工作台执行任务都在当前 Codex 会话出现真实 `role=user` 消息。
3. 没有 Bridge App 时，工作台明确显示未连接且不谎报已发送。
4. `host_accepted` 与 `codex_received` 有不同时间戳和状态。
5. Codex 仅通过 MCP 启动 Lovart 副作用。
6. 浏览器提交、项目保存和素材本地上传本身产生零 Lovart 请求。
7. 所有执行使用服务端不可变快照，提示词不被重新改写。
8. 同一 job 重试不会重复 Lovart 提交或费用确认。
9. 生成进度能同时到达当前 Codex 会话和工作台。
10. 重启、桥离线、多会话和多任务测试通过。
11. 独立 Lovart 插件和其凭据/状态未被修改。
12. 全量自动化测试、插件校验和本地 Codex 手工验收通过。
13. 用户在本地验收确认前不提交仓库、不发布。

## 21. 分阶段实施计划

### Phase 0：Spec 审批

- 用户评审本文件；
- 解决第 24 节待确认项；
- 用户明确回复批准后才能进入 Phase 1。

### Phase 1：会话桥底座（不接 Lovart）

- 添加 MCP Apps 依赖；
- 实现 resource、Bridge App、session、presence、heartbeat；
- 实现 outbox 和 `ui/message`；
- 用模拟任务验证当前会话真实消息；
- 此阶段禁止真实 Lovart 请求。

### Phase 2：统一工作台提交

- 图片、视频和继续编辑全部生成 Task Envelope；
- UI 接入 bridge/delivery 状态；
- 移除误导文案；
- HTTP Lovart 副作用退出工作台主链路。

### Phase 3：MCP 执行与进度

- 收紧 `imvia_execute_workbench_submission`；
- 接入 delivery/execution 原子转换；
- 接入 Lovart orchestrator；
- MCP progress + SSE 双通道同步；
- 完成费用确认和结果导入路径。

### Phase 4：恢复、迁移与安全

- v2 -> v3 迁移；
- 重启恢复、桥接管、lease、幂等；
- 多 session 隔离；
- Origin、cookie、CSP 和脱敏测试。

### Phase 5：本地集成验收

- 运行全量离线测试；
- 在本地 Codex 安装开发包；
- 按第 19.5 节逐项验收；
- 将结果和仍存在的限制交给用户确认。

### Phase 6：发布（单独授权）

- 只有用户确认本地验收通过后，才允许提交仓库；
- 只有用户再次明确要求发布/重装后，才打包并安装；
- 不把“代码写完”当作“发布授权”。

## 22. 回滚方案

- 会话桥以独立 resource、服务和状态字段实现，避免侵入 Lovart 核心适配器。
- 发布前保存上一已安装插件版本号和包。
- 新版本启动失败时可重新安装上一版本；不删除用户任务和受管结果。
- v3 状态迁移先保留原字段，至少一个稳定版本内不做破坏性清理。
- 禁止使用会导致用户工作区或凭据丢失的重置方案。

## 23. 可观测性与隐私

记录：

- session/bridge 创建、接管、过期；
- dispatch 创建、claim、host accepted、codex received；
- execution 状态和稳定错误码；
- job/delivery/dispatch ID；
- 时间戳和重试次数。

不记录：

- AK/SK；
- 原始密钥文件内容或路径；
- 完整 Lovart 原始响应；
- 素材二进制；
- 无必要的完整 prompt 日志。

UI 和 MCP 返回只使用脱敏、最小化字段。

## 24. 已批准的实施决策

本次批准采用以下默认值：

1. **MCP 路由**：Codex 调用 IMVIA Studio MCP 的执行工具，再由 IMVIA 自有 Lovart 适配器驱动 Lovart；不调用或修改独立 Lovart 插件。建议：确认。
2. **桥离线提交**：允许保存到本地 outbox，但必须显示“尚未发送”；重新打开当前工作台后自动继续投递。建议：确认。
3. **宿主已接受但 Codex 未确认的任务**：不自动重复发送，显示“投递状态待确认”，避免重复消息和生成。建议：确认。
4. **多任务策略**：同一 session 按 FIFO，一次只允许一个尚未 `codex_received` 的消息。建议：确认。
5. **旧 `queued_for_agent` 任务**：不自动执行，标记旧版本待复核，避免意外费用。建议：确认。
6. **发布纪律**：完成本地验收后另行请求提交/发布授权。建议：确认。

## 25. 审批记录

批准结论：用户已明确批准按建议默认值实施。发布、提交和重新安装仍需另行授权。
