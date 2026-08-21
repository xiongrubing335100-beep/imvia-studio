# IMVIA Studio MCP

IMVIA Studio is an independent local MCP plugin. Version 0.3.0 keeps the
Milestone 5 fixture-only orchestration, keeps the optional Milestone 6
read-only Lovart capability probe, and adds a Milestone 7 no-terminal Lovart
connection and creation path. The MCP Server ID remains
`imvia-studio`.

The MCP launcher uses a portable proxy policy. By default (`IMVIA_PROXY_MODE=auto`)
it honors standard `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` variables, then checks
the macOS system HTTPS proxy only when no standard proxy is present, and falls
back to a direct connection when neither exists. Nothing is hard-coded or
persisted. Set `IMVIA_PROXY_MODE=direct` to force direct access, `env` to use
only standard proxy variables, or `system` to use only the macOS system proxy.

> Installation, dependency installation, and automated tests do not authorize
> a live Lovart probe or creation. They do not provision credentials, upload,
> generate, confirm a cost, or contact Lovart. A user must explicitly choose
> the connection or creation action in the current workbench session.

## Open the bundled workbench

The plugin includes the existing IMVIA Studio web workbench as an independent
static bundle. When a user asks to open or use IMVIA Studio, call
`imvia_open_workbench`, then open its returned `workbench_url` in Codex's
right-side browser panel. The bundled page is served by the same loopback
service as the MCP and uses the live local adapter (`?imvia=live`). No
terminal, URL copy/paste, or separate frontend server is required.
Its **连接 Lovart** control uses the same native credential flow as
`imvia_connect_lovart`; only a redacted status is returned to the page.

## Architecture and scope

The existing workbench path remains local and fixture-only:

```text
12 existing MCP tools -> local workbench service -> .imvia-studio-dev local state
```

The user-facing Lovart path is separate and starts only from an explicit
workbench action:

```text
imvia_connect_lovart
  -> native password-style dialog
  -> IMVIA-owned Keychain item
  -> fixed Lovart mode check
  -> redacted connected/not-connected status
  -> imvia_generate / imvia_confirm_generation when the user asks to create
```

The optional probe is isolated from that workbench path:

```text
explicit request in the current conversation
  -> imvia_authorize_lovart_probe
  -> single-use authorization (expires after 2 minutes)
  -> imvia_probe_lovart_capabilities
  -> atomically consumed authorization and durable pending attempt
  -> isolated child process: fixed macOS Keychain references + one signed request
  -> strict capability normalizer
  -> redacted advisory summary (expires after 5 minutes)
```

The probe supports macOS only and requires two dedicated items in macOS
Keychain under the fixed service `ai.imvia.studio.lovart-readonly` and fixed
accounts `access-key` and `secret-key`. Credential values and the raw response
remain inside the child process: they are not MCP inputs or outputs, process
arguments, inherited environment, logs, fixtures, persistent state, or Git.
The implementation does not import, execute, configure, reconnect, inspect, or
write to the existing Lovart plugin.

The request boundary is fixed: at most one HTTPS `POST` to
`https://lgw.lovart.ai/v1/openapi/mode/query` with body `{}`. There are zero
redirects, zero automatic retries, mandatory TLS certificate and hostname
verification, an 8-second total timeout, and a 65,536-byte response cap. The
probe never uploads or generates, confirms a cost, or queries projects,
threads, status, results, balance, billing, quota, or identity.

Probe results are advisory. They do not change the local model table or any
job, draft, artifact, cost, iteration, preparation, or execution behavior.
`available`, `unavailable`, and `unknown` stay distinct; unknown upstream model
identifiers are ignored.

## Tool inventory

The MCP server exposes exactly 19 tools. The original 12 retain their schemas
and fixture-only behavior:

- `imvia_claim_cost_decision`
- `imvia_create_iteration`
- `imvia_get_account_status`
- `imvia_get_state`
- `imvia_health`
- `imvia_import_result`
- `imvia_list_pending_jobs`
- `imvia_patch_workbench`
- `imvia_prepare_generation`
- `imvia_record_cost_decision`
- `imvia_update_account_status`
- `imvia_update_job`

Milestone 6 adds:

- `imvia_authorize_lovart_probe`
- `imvia_probe_lovart_capabilities`

Milestone 7 adds the no-terminal user flow:

- `imvia_connect_lovart`
- `imvia_lovart_status`
- `imvia_generate`
- `imvia_confirm_generation`

The workbench entry point is:

- `imvia_open_workbench`

## No-terminal Lovart workflow

Click **连接 Lovart** in the workbench (or call `imvia_connect_lovart` with
`{}`). IMVIA opens a native macOS password-style dialog; enter the two Lovart keys there and choose
**Connect**. The values are stored only in the IMVIA-owned Keychain item
`ai.imvia.studio.lovart` and are never accepted as MCP arguments or returned
to chat. The result contains only `connected`, `not_connected`, or a stable
redacted error code.

After the result is `connected`, call `imvia_generate` with a prompt. It
returns completed artifacts, an aborted/timeout status, or
`final_status: "pending_confirmation"` with the estimated cost. Do not call
`imvia_confirm_generation` until the user explicitly accepts that cost in the
current conversation. Confirmation is never automatic.

If the connection is already configured, `imvia_lovart_status` reads the
local redacted status without opening a dialog. The `configure:lovart` script
is a developer fallback only; ordinary users should not need a terminal.

## Probe setup and feature state

The probe state defaults to `enabled: false`. Only a user may run these local
commands; they are not MCP tools, and Codex must not run them on the user's
behalf:

```sh
pnpm run configure:lovart-readonly
pnpm run enable:lovart-readonly-probe
pnpm run disable:lovart-readonly-probe
```

The configuration command uses macOS protected system input and accepts no
credential through command-line arguments, environment variables, redirected
stdin, or a configuration file. Enabling does not authorize a request. Even
when enabled, the user must explicitly request the read-only probe in the
current conversation; general permission, a queued job, earlier approval, or
a fixture decision is insufficient.

## MCP probe contracts

`imvia_authorize_lovart_probe` records the current-conversation request without
Keychain access or networking. Its strict input is:

```json
{
  "source": "user:current_session",
  "reason": "non-empty user-visible reason",
  "idempotency_key": "caller-supplied stable key"
}
```

It returns `authorization_id`, `policy_version`, `issued_at`, `expires_at`, and
`consumed: false`. The authorization expires after two minutes and is valid for
one atomic consumption only.

`imvia_probe_lovart_capabilities` must be called after authorization. Its strict
input is:

```json
{
  "authorization_id": "authorization returned above",
  "idempotency_key": "caller-supplied stable key"
}
```

It accepts no endpoint, URL, method, credential, retry, TLS, proxy, model,
project, thread, or account parameter. Success returns only `reachable`,
`authenticated`, `service_version`, `capability_status`, the 15-entry
`workbench_models` intersection, `checked_at`, `expires_at`, and
`policy_version`; `service_version` is `null` because the pinned contract does
not provide one. A completed idempotent replay returns the stored redacted
summary with zero Keychain reads and zero Lovart requests.

`authenticated` is tri-state: `true` only for a validated authenticated
success, `false` only for an explicit HTTP 401/403 authentication rejection,
and `null` for credential, network, TLS, timeout, rate-limit, upstream, schema,
or store failures. Disabled, unsupported-platform, and invalid-authorization
errors occur before authentication is attempted. A valid authenticated
response without a recognized model list succeeds with
`capability_status: "unknown"`.

## Stable probe errors

No failure retries automatically.

| Condition | Stable code | Lovart requests |
|---|---|---:|
| Feature disabled | `PROBE_DISABLED` | 0 |
| Unsupported platform | `PLATFORM_UNSUPPORTED` | 0 |
| Missing, expired, consumed, or mismatched authorization | `PROBE_AUTHORIZATION_INVALID` | 0 |
| Keychain item missing or access denied | `CREDENTIAL_REFERENCE_UNAVAILABLE` | 0 |
| DNS, connection, or timeout failure | `UPSTREAM_UNREACHABLE` | at most 1 |
| TLS failure or redirect | `UPSTREAM_SECURITY_REJECTED` | at most 1 |
| HTTP 401 or 403 | `AUTHENTICATION_FAILED` | 1 |
| HTTP 429 | `UPSTREAM_RATE_LIMITED` | 1 |
| HTTP 5xx or other rejected HTTP status | `UPSTREAM_UNAVAILABLE` | 1 |
| Oversized response, invalid JSON, or invalid root envelope | `UPSTREAM_SCHEMA_UNRECOGNIZED` | 1 |
| Local durable write failure | `STORE_UNAVAILABLE` | at most 1 |

Feature disabled, unsupported platform, invalid/expired/consumed authorization,
and missing credential references are checked before a Lovart request. A final
store-write failure leaves the authorization consumed, so it cannot repeat the
request.

## Isolated state and lock recovery

Probe authorization, attempt, redacted result, and redacted audit state lives
only at `.imvia-studio-dev/lovart-probe-state-v1.json`, separate from the M5
workbench schema. The directory is private and the file is mode `0600`.
Disabling preserves audit history; five-minute summaries may remain as stale
history but never refresh automatically.

State locking fails closed. An active, abandoned, incomplete, or
ownership-changed lock does not permit state mutation. If a lock appears
abandoned, a human must verify the owning process and lock provenance before
any recovery. IMVIA never automatically deletes an abandoned lock.

## Fixture-only orchestration

Only test-provided adapters labelled `fixture` or `mock_lovart` may model the
Lovart upload, generation, and confirmation steps. The prepared prompt is used
byte-for-byte, and stable prompt-token references determine upload order.

Cost decisions are single-use: record the explicit decision, claim it, then
confirm the fixture cost exactly once before generating. A queued job is not
cost approval. A failed fixture confirmation is persisted against the claimed
decision; retry requires a new current-session acceptance, idempotency key,
decision ID, and claim. Account status caches only sourced billing mode;
unavailable balance and unit values remain `null` with
`UPSTREAM_CAPABILITY_UNAVAILABLE`.

Fixture checked times use canonical UTC ISO text with millisecond precision
and allow at most five minutes of clock skew into the future. Optional expiry
times must use the same form and cannot precede their checked time.

Iterations may reuse a thread only from the direct parent chain and never
inherit a prior cost approval. Result import accepts only already-managed local
fixture artifacts.

## Offline verification

Run all installation and test commands from an explicitly selected standalone
repository root: the directory that contains this `README.md` and
`package.json`.

```sh
cd /absolute/path/to/imvia-studio
pnpm install --frozen-lockfile
pnpm run test:orchestration
pnpm run test:probe
pnpm run test:mcp
pnpm test
python3 /Users/a1234/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

These commands are offline verification contracts: their fake providers must
make zero real Lovart requests. Running them, including dependency
installation, does not authorize a live probe or generation and does not
authorize either user-run setup/enable command.

The protected-path baseline belongs to the original development workspace.
From the independent IMVIA repository root, where the verifier can resolve all
three protected roots through one of its two supported layouts, run:

```sh
cd /absolute/path/to/imvia-studio
pnpm run verify:protected-paths
```

The read-only verifier covers `lovart-codex-plugin`,
`lovart-local-marketplace`, and `lovart-output`; it fails on added, removed,
changed, or retargeted entries. It does not authorize inspection or use of
credentials, plugin execution, a live probe, or generation.
