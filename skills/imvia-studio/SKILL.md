---
name: imvia-studio
description: Use when the user explicitly selects or @-mentions IMVIA Studio, names IMVIA Studio, or asks to open or launch the IMVIA Studio workbench; not for Imvia Layer or UI/poster layer splitting.
---

# IMVIA Studio

## Open the web workbench

IMVIA Studio and Imvia Layer are separate plugins. A request that names,
selects, or links `plugin://imvia-studio@personal` is identity-bound to this
skill, even when its remaining text only says "open the workbench". Never route such a request to Imvia Layer. Use Imvia Layer only when the user explicitly
names it or asks to split a UI or poster into layers.

When the user asks to open, launch, or use IMVIA Studio, call
`imvia_open_workbench` with `{}`. It returns a local `workbench_url`.
Immediately call `codex_app__open_in_codex` with
`{ placement: "right", target: { type: "browser", url: workbench_url } }`.
This opens the bundled IMVIA Studio workbench in Codex's right-side browser
panel. Do not ask the user to start a terminal, paste a URL, or run a local
server command. The page uses the same local IMVIA state and HTTP/SSE service
as the MCP tools. The original Lovart plugin remains independent.

For a modern external API connection, configure only an optional API name plus
the API address and API Key; the key stays in the IMVIA-owned secure credential
dialog and never enters chat or a workbench JSON form. Choose the external model
ID only from that connection's discovered model catalog. Do not invent a model
ID or manually configure protocol, endpoint, capability, or request-mapping
fields.

Keep the current task active after opening the panel. `imvia_open_workbench`
creates a durable workbench session and mounts the MCP Apps conversation bridge;
its initial `bridge_state` is `mounting`, not “connected”. The bridge registers
with `imvia_register_conversation_bridge`, sends each claimed workbench message
through the host `ui/message` channel, and marks delivery only after the Codex
host accepts that message. Do not poll the old
`imvia_wait_for_workbench_submission` tool as the primary handoff mechanism and
do not describe a browser-side queue write as a delivered Codex message.

When a bridge message arrives, read the immutable task envelope's frozen
`provider_id`, `provider_label`, `connection_id`, and `snapshot_digest` before
choosing any provider-specific wording or action. Immediately return a visible
assistant update such as “已收到工作台任务，正在准备调用 <provider_label>”，then
summarize the envelope and call `imvia_execute_workbench_submission` with the
exact `job_id` and `snapshot_digest`. Never create a second job with
`imvia_generate` for the same workbench submission. For an external provider,
never call a Lovart tool or capability: the execution tool must route only to
the frozen API connection through its frozen provider adapter, and a failure
must remain an external-provider failure. Never call or fall back to Lovart for an external provider job. Call Lovart only when the immutable snapshot's
`provider_id` is exactly `lovart`.

The execution tool reports MCP progress notifications. Relay those updates in
the current Codex task while the work is running: receipt/acceptance, asset
upload, selected-provider submission, generating/polling, result import,
failure, or cost confirmation. Do not end the task with only
`queued_for_agent`; the user must see a current status message. A pending cost
is a hard stop: show the amount and unit, then wait for an explicit
current-session decision.

The workbench button only writes an immutable task envelope to the local durable
outbox. It never calls a generation provider directly. Saving a project address
only normalizes and remembers it locally; validation, uploads, generation, and
all provider side effects begin only when Codex executes the received submission
through the MCP tool. The button click explicitly activates only the provider
frozen in that task snapshot. An external `provider_id` activates only its
configured API connection and blocks Lovart; `provider_id: lovart` activates
only Lovart. If execution returns a pending cost, stop and ask for the required
current-session decision under the cost-confirmation rules below.

## Milestone 5 fixture-only gate

Never call an installed or real Lovart MCP tool in Milestone 5. Use only a test-provided adapter explicitly labelled `fixture` or `mock_lovart`. If no such adapter is present, stop and report that Milestone 5 cannot execute. Never inspect, configure, reconnect, or fall back to Lovart, and never read credentials.

## Read, suggest, confirm, snapshot

Read with `imvia_get_state` and `imvia_list_pending_jobs`. Suggestions may revision-patch an editable draft with `imvia_patch_workbench`; after workbench confirmation, re-read and prepare exactly one immutable snapshot with `imvia_prepare_generation`. Do not treat queued_for_agent as cost approval.

## Execute the immutable snapshot

Use the mock `lovart_upload` semantics in stable prompt-token order, write `uploading`, then use mock `lovart_generate` semantics with `snapshot.prompt.text` byte-for-byte. Never rewrite a prepared prompt.

## Cost confirmation hard stop

On fixture cost, write `awaiting_cost_confirmation` and display job ID, attempt, amount, unit, and checked time in the current conversation. Before explicit acceptance, mock `lovart_confirm` count must remain zero. Ambiguous, stale, mismatched, inherited, or old-session answers do not count.

For explicit acceptance, call `imvia_record_cost_decision`, then `imvia_claim_cost_decision`, then mock `lovart_confirm` exactly once, then `imvia_update_job` to `generating`. For explicit decline, record `declined` and never call mock `lovart_confirm`. Never auto-retry a consumed decision.

If mock `lovart_confirm` fails, use `imvia_update_job` to persist `confirmation_failed` evidence against the exact claimed decision while remaining in `awaiting_cost_confirmation`, then stop. A retry requires a new explicit current-session acceptance, a new idempotency key, a new decision ID, and a new claim. Never reuse the failed decision.

## Status, billing, results, iteration

Write fixture status through `imvia_update_job`. Cache only sourced billing mode with `imvia_update_account_status`; unknown balance and unit stay null with `UPSTREAM_CAPABILITY_UNAVAILABLE`. Import only already-managed local fixture artifacts through `imvia_import_result`. Continue through `imvia_create_iteration`; reuse a thread only from the direct parent chain, and never inherit cost approval.

## Stop conditions

On revision/status conflict, unknown response, missing mock adapter, or failed confirmation, stop, re-read local state when safe, and explain the state. Do not skip a state, blindly replay a side effect, connect to real Lovart without the Milestone 7 user action, install a marketplace entry, or advance a fixture job into live execution.

## Lovart activation and provider isolation

Keep Codex's native generation capability and IMVIA/Lovart in separate provider
contexts. A request may use Lovart only when the user explicitly addresses the
plugin with `@`, names Lovart or IMVIA Studio, asks to use the Lovart plugin, or
continues a clearly related active Lovart task with a parent job or artifact.
Clicking a workbench action such as **发送生成** or **继续编辑** is an explicit
selection of the provider frozen in the immutable task snapshot. The workbench
first sends that immutable summary to Codex; Codex then executes that exact job
with `imvia_execute_workbench_submission`. An external provider selection must
never activate or fall back to Lovart. A Lovart selection remains task-scoped
and is stored as `workbench_action` on that submission.

If the user only asks for a generic image or video, use Codex's native ImageGen
or video capability. A saved key, a connected status, an active Lovart project,
or an earlier Lovart request alone never activates Lovart. A continuation is
valid only with `parent_job_id` or `artifact_id`; ambiguous context uses the
Codex default capability. Never call both providers for one request.

Never silently fall back between providers: a Lovart failure stays a Lovart
failure, and a Codex ImageGen failure stays a Codex failure. Never auto-confirm
costs, change the selected provider, or put AK/SK into activation, prompt,
project, job, HTTP, or MCP data.

## Milestone 6 read-only Lovart probe

The user must explicitly request the read-only probe in the current conversation. General permission, a queued job, earlier approval, or a fixture decision is insufficient. Call `imvia_authorize_lovart_probe` before `imvia_probe_lovart_capabilities`.

Codex must never run `pnpm run configure:lovart-readonly`, `pnpm run enable:lovart-readonly-probe`, or `pnpm run disable:lovart-readonly-probe` for the user. If the probe is disabled, stop and ask the user to run the required setup or enable command themselves.

One explicit request in the current conversation permits exactly one fresh authorization and one probe attempt. After any failure or consumed authorization, never change an idempotency key, re-authorize, or retry; stop and await a new explicit request in the current conversation.

Feature disabled, unsupported platform, invalid, expired, or consumed authorization, or a missing credential reference must produce zero Lovart requests. An idempotent completed replay must perform zero Keychain reads and zero Lovart requests.

The probe is advisory and must not alter job, draft, artifact, cost, iteration, or execution behavior. Never upload, generate, confirm, query projects, threads, status, results, or balance; never expose AK/SK; and never call the existing Lovart plugin.

## Independent first-run Lovart onboarding

The first workbench open may start IMVIA credential onboarding when IMVIA
credentials are missing. This setup uses the bundled signed native helper on
macOS or Windows; users never need Swift, Xcode, Command Line Tools, a
PowerShell module, or another developer tool. Credential onboarding never
activates upload, project creation, generation, confirmation, or cost approval.

IMVIA Studio never reads, migrates, overwrites, or infers credentials or state
from the existing Lovart plugin. Its macOS namespace is
`ai.imvia.studio.lovart` / `credentials`; its Windows target is
`IMVIA.Studio.Lovart`. The workbench status rail shows Lovart only when this
independent IMVIA connection is established.

## Explicit Lovart workflow

When the user explicitly asks to connect Lovart, call `imvia_connect_lovart` with
an empty object. The tool opens the native secure dialog; never ask the user to
paste AK/SK into chat, MCP arguments, environment variables, or a file. The
result is redacted. `imvia_lovart_status` reads only the redacted local state.

The bundled workbench starts onboarding on first open. **重试连接** and
**更换密钥** reopen the same native secure dialog; the connected-only status
rail is informational and credentials never enter browser state or HTTP
arguments. `imvia_disconnect_lovart` is an explicit action that deletes only
the IMVIA-owned credential item.

After a connected result, resolve the project with
`imvia_list_lovart_projects`, `imvia_select_lovart_project`, or
`imvia_create_lovart_project` as needed, then call `imvia_generate` with the
user's original prompt, an explicit `activation`, and an idempotency key. If no
project was selected, the first request creates one and later requests reuse
the active project until the user selects another. It may return
`pending_confirmation`; show the amount and unit and wait for an explicit
current-session acceptance before calling `imvia_confirm_generation` with the
exact job, attempt, fingerprint, and decision. Never auto-confirm, auto-retry
a consumed action, or expose credential values. The existing Lovart plugin
remains independent: do not import, execute, configure, reconnect, or modify
it.

The launcher uses a portable proxy policy: `IMVIA_PROXY_MODE=auto` (the
default) honors standard proxy variables, then uses the macOS system HTTPS
proxy only when no standard proxy is present, and otherwise connects directly.
`direct`, `env`, and `system` modes are available for explicit deployments. Do
not ask the user to disable a VPN or enter proxy settings into chat.
