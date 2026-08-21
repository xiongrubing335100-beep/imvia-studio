# Milestone 6 Lovart Read-Only Probe Design

Date: 2026-08-20

Status: Approved in conversation; awaiting written-spec review

Repository: `xiongrubing335100-beep/imvia-studio`

Related issue: [#2](https://github.com/xiongrubing335100-beep/imvia-studio/issues/2)

## 1. Objective

Milestone 6 adds one narrowly scoped, authenticated, read-only Lovart
connectivity probe to IMVIA Studio. The probe may establish whether the
official Lovart service is reachable, whether a dedicated credential reference
authenticates, and which models already supported by the local workbench appear
available upstream.

The milestone does not upload a file, create or modify a Lovart project, read
project or thread metadata, submit a prompt, generate an artifact, confirm a
cost, query a balance, or change an account setting.

## 2. Product Decisions

The following decisions are fixed for this milestone:

- A probe runs only after an explicit request in the current user session.
- Each authorization permits one network attempt and expires after two minutes.
- Credentials are addressed through fixed, opaque macOS Keychain references.
- Credential values never enter MCP arguments, MCP results, process arguments,
  inherited environment variables, logs, fixtures, persistent state, or Git.
- The only upstream operation is the official `query-mode` contract.
- The response is used only for reachability, authentication, and the
  intersection with the existing workbench model table.
- Billing mode and the raw upstream response are discarded.
- Failures do not retry automatically.
- Results are advisory. They do not mutate the local capability table, block
  task preparation, or unlock generation.
- The feature is disabled by default and supports macOS only in this milestone.

## 3. Non-Goals

Milestone 6 does not include:

- real upload, generation, confirmation, result, status, project, or thread
  operations;
- account balance, quota, billing-mode, or identity display;
- marketplace installation or workbench UI changes;
- migration, extraction, display, or logging of an existing Lovart secret;
- modification, import, execution, configuration, or reconnection of the
  existing Lovart plugin;
- arbitrary endpoints, proxies, redirects, TLS bypasses, user-selected models,
  background polling, or automatic refresh;
- Linux or Windows credential support;
- automatic synchronization of the local model table with Lovart.

## 4. Contract Provenance

The design was derived by read-only inspection of the existing protected
Lovart plugin and its linked official upstream source. Runtime code must not
depend on the protected plugin.

Pinned contract source:

- upstream: [lovartai/lovart-skill](https://github.com/lovartai/lovart-skill)
- Skill version: `1.0.11`
- vendored client SHA-256:
  `39c68e32c2262f7f1b3890f684e33b149f9da3d5577fc591b7b4e640a87e4878`
- vendored Skill SHA-256:
  `561bba809f4ea2e4c4bbb1c02a34e494d21bb688e7a336a058156c26e71bd9d3`
- authenticated operation: `POST /v1/openapi/mode/query`
- official origin: `https://lgw.lovart.ai`

The upstream client describes `query_mode()` as returning the current mode and
available models. IMVIA discards the mode and accepts model availability only
when the response matches the strict schema implemented from this pinned
contract. A future upstream hash or schema change requires review; it never
updates the mapping automatically.

The upstream contract does not guarantee a service version field. IMVIA
therefore returns `service_version: null` unless the pinned schema later gains
an explicitly documented version field through a reviewed change.

## 5. Alternatives Considered

### 5.1 Wrap the existing Lovart MCP

This would be the fastest route, but it would make IMVIA depend on a plugin
that also exposes upload, generation, confirmation, projects, and threads. It
would violate isolation and provide far more authority than the probe needs.
This approach is rejected.

### 5.2 Reuse the complete official Python client

The client already implements signing and `query-mode`, but also contains
write operations, generic request behavior, configurable origins, retry logic,
and a TLS verification opt-out. Shipping that authority for a one-operation
probe conflicts with least privilege. This approach is rejected.

### 5.3 Build a purpose-specific probe process

The selected design implements one fixed operation in an isolated process. It
has no generic command surface and no generation methods. This requires more
code than wrapping the existing plugin, but makes the security boundary small,
auditable, and testable.

## 6. Architecture

```text
explicit current-session request
        |
        v
imvia_authorize_lovart_probe
        |
        v
single-use, two-minute authorization
        |
        v
imvia_probe_lovart_capabilities
        |
        +-- atomically consume authorization and record pending attempt
        |
        v
isolated LovartReadOnlyProbe process
        |
        +-- retrieve fixed Keychain items inside the child process
        +-- sign one fixed HTTPS request
        +-- POST https://lgw.lovart.ai/v1/openapi/mode/query
        +-- validate bounded response
        +-- discard billing mode and raw response
        |
        v
CapabilityNormalizer
        |
        +-- intersect with the local workbench table
        +-- ignore unknown upstream models
        |
        v
redacted summary and audit event
```

The existing 12 MCP tools retain their schemas and behavior. Milestone 6 adds
two tools, bringing the inventory to 14. No existing tool gains network or
credential authority.

## 7. Components

### 7.1 ProbeAuthorizationService

This component owns single-use authorization records. It provides local-only
creation, validation, atomic consumption, expiry, and idempotency. It has no
Keychain or network capability.

An authorization record contains:

```json
{
  "id": "uuid",
  "kind": "lovart_capability_probe",
  "source": "user:current_session",
  "reason": "user-visible non-empty text",
  "policy_version": "lovart-readonly-probe-v1",
  "issued_at": "canonical UTC timestamp",
  "expires_at": "canonical UTC timestamp",
  "consumed_at": null,
  "idempotency_key": "non-empty string"
}
```

Consumption and creation of a pending attempt occur in one atomic store update
before Keychain access or networking. Expired, consumed, mismatched, or
concurrently claimed authorizations never reach the child process.

### 7.2 LovartReadOnlyProbe

The probe is a purpose-specific child process. The production entry point has
no parameters for origin, path, method, proxy, redirect behavior, retry count,
TLS verification, credentials, or model selection.

Fixed transport policy:

- origin: `https://lgw.lovart.ai`;
- method and path: `POST /v1/openapi/mode/query`;
- request body: `{}`;
- redirects: rejected;
- proxies inherited from the parent environment: removed;
- TLS certificate and hostname verification: mandatory;
- retry count: zero;
- total timeout: eight seconds;
- maximum response body: 65,536 bytes;
- accepted response content: UTF-8 JSON object only.

The child process directly resolves two fixed IMVIA-specific Keychain items.
It signs the request in the same process and returns only the normalized probe
envelope. Secrets, signing headers, timestamps used for signing, raw bodies,
and account identifiers never cross the child-process boundary.

The Keychain identifiers are fixed and non-secret:

- service: `ai.imvia.studio.lovart-readonly`;
- account: `access-key`;
- account: `secret-key`.

Credential provisioning is a separate user-run helper that writes the fixed
Keychain items through a system-protected input flow. It is not an MCP tool.
Codex cannot supply, inspect, return, or log the entered values.
The user-facing command is `pnpm run configure:lovart-readonly`; it must open
protected system input and must not accept a credential through command-line
arguments, environment variables, redirected stdin, or a configuration file.

### 7.3 CapabilityNormalizer

The normalizer accepts a validated in-memory response and emits only the
intersection with `MODEL_CAPABILITIES` in the workbench service. Upstream
models absent from the local table are ignored. Local entries without an
unambiguous official mapping remain `unknown`; they are not guessed.

The pinned source does not publish a complete response schema. The first
implementation therefore recognizes only this conservative shape:

```json
{
  "unlimited": true,
  "available_models": {
    "IMAGE": ["official_tool_identifier"],
    "VIDEO": ["official_tool_identifier"]
  }
}
```

`unlimited` is required to be a boolean and is immediately discarded.
`available_models` is required to be an object whose recognized category
values are arrays of strings. Additional categories and identifiers are
ignored. Missing `available_models`, a different field name, or a different
shape yields `capability_status: "unknown"`; the implementation must not scan
arbitrary response strings or add fallback parsers. This schema is a
fail-closed parser contract, not a claim that every upstream deployment
currently returns the shape.

The initial conservative mapping is:

| Workbench model | Official tool identifier | Mapping status |
|---|---|---|
| Seedance 2.5 | `generate_video_seedance_v2_5` | exact |
| Seedance 2.0 VIP | none | unknown |
| Seedance 2.0 Fast | `generate_video_seedance_v2_0_fast` | exact |
| Minimax H3 | `generate_video_minimax_h3` | exact, case-normalized display |
| Kling 3.0 | `generate_video_kling_v3` | exact display |
| Kling 3.0 Omni | `generate_video_kling_v3_omni` | exact display |
| Seedream 4.0 | `generate_image_seedream_v4` | exact version alias |
| Seedream 3.0 | none | unknown |
| Seedream 3.0 Fast | none | unknown |
| Image 2 | none | unknown |
| Nano Banana Pro | `generate_image_nano_banana_pro` | exact |
| Nano Banana 2 | `generate_image_nano_banana_2` | exact |
| Seedream 5.0 | none | unknown |
| Seedream 5.0 Lite | `generate_image_seedream_v5` | exact display |
| Midjourney | `generate_image_midjourney` | exact |

`unknown` is intentionally distinct from `unavailable`. `unavailable` means a
recognized official identifier was absent from a valid availability list.
`unknown` means the contract did not establish a safe mapping or availability
answer.

### 7.4 ProbeSummaryStore

Probe state is isolated from the M5 workbench schema in:

```text
.imvia-studio-dev/lovart-probe-state-v1.json
```

The file is created with mode `0600`. It stores authorizations, pending attempt
records, redacted results, and audit events. It never stores a raw response,
request headers, signatures, credentials, account identifiers, project data,
thread data, billing mode, or balance.

Results expire after five minutes. Expired summaries remain available as
`stale` history but never trigger an automatic refresh.

The root object contains `version: 1` and `enabled: false` when first created.
Only the user-run command `pnpm run enable:lovart-readonly-probe` may set
`enabled` to `true`; MCP tools cannot enable the feature. The corresponding
disable command sets it back to `false` without deleting audit history.

## 8. MCP Contracts

### 8.1 `imvia_authorize_lovart_probe`

Purpose: record the user's explicit current-session request without networking.

Input:

```json
{
  "source": "user:current_session",
  "reason": "Check read-only Lovart connectivity and workbench capabilities.",
  "idempotency_key": "caller-supplied stable key"
}
```

Output:

```json
{
  "authorization_id": "uuid",
  "policy_version": "lovart-readonly-probe-v1",
  "issued_at": "canonical UTC timestamp",
  "expires_at": "canonical UTC timestamp",
  "consumed": false
}
```

The Skill contract must require a user request in the current conversation
before this tool is called. A queued job, earlier approval, fixture decision,
or general permission to use IMVIA does not count.

### 8.2 `imvia_probe_lovart_capabilities`

Purpose: consume one authorization and perform at most one read-only request.

Input:

```json
{
  "authorization_id": "uuid",
  "idempotency_key": "caller-supplied stable key"
}
```

The input intentionally has no origin, URL, path, method, credential,
credential reference, retry, TLS, proxy, model, project, thread, or account
field.

Successful output:

```json
{
  "reachable": true,
  "authenticated": true,
  "service_version": null,
  "capability_status": "available",
  "workbench_models": [
    {
      "name": "Seedance 2.5",
      "mode": "video",
      "availability": "available"
    }
  ],
  "checked_at": "canonical UTC timestamp",
  "expires_at": "canonical UTC timestamp",
  "policy_version": "lovart-readonly-probe-v1"
}
```

`authenticated` is tri-state: `true` for a validated success, `false` only for
an explicit authentication rejection, and `null` for network, TLS, timeout, or
schema failures. This prevents false conclusions.

An idempotent replay returns the previously stored redacted result and performs
zero Keychain and network operations.

## 9. Failure Semantics

| Condition | Stable error code | Network attempts | Automatic retry |
|---|---|---:|---:|
| Feature disabled | `PROBE_DISABLED` | 0 | no |
| Unsupported platform | `PLATFORM_UNSUPPORTED` | 0 | no |
| Missing, expired, consumed, or mismatched authorization | `PROBE_AUTHORIZATION_INVALID` | 0 | no |
| Keychain item missing or access denied | `CREDENTIAL_REFERENCE_UNAVAILABLE` | 0 | no |
| DNS, connection, or timeout failure | `UPSTREAM_UNREACHABLE` | at most 1 | no |
| TLS failure or redirect | `UPSTREAM_SECURITY_REJECTED` | at most 1 | no |
| HTTP 401 or 403 | `AUTHENTICATION_FAILED` | 1 | no |
| HTTP 429 | `UPSTREAM_RATE_LIMITED` | 1 | no |
| HTTP 5xx | `UPSTREAM_UNAVAILABLE` | 1 | no |
| Oversized, invalid JSON, or invalid root envelope | `UPSTREAM_SCHEMA_UNRECOGNIZED` | 1 | no |
| Local durable write failure | `STORE_UNAVAILABLE` | at most 1 | no |

A valid authenticated response without a recognized model list is a successful
connectivity probe with `capability_status: "unknown"`. It does not become a
schema guess or an empty availability list.

If the final store write fails, the durable pending attempt remains consumed.
The same authorization cannot repeat the request. Recovery requires a new
explicit current-session authorization.

## 10. Threat Model and Controls

| Threat | Required control |
|---|---|
| Secret leakage | Secrets never enter parent-process inputs, outputs, environment, logs, state, fixtures, or Git |
| SSRF or arbitrary endpoint access | Compile-time fixed origin, port, method, and path; no transport parameters |
| Accidental write or billable operation | Probe binary contains only the one allowlisted operation |
| TLS downgrade | Mandatory certificate and hostname verification; no insecure option |
| Unauthorized or replayed request | Explicit two-minute authorization, atomic consume-before-attempt, idempotency binding |
| Retry amplification | Zero automatic retries and at most one request per authorization |
| Response abuse | 64 KiB limit, strict JSON schema, allowlisted model IDs, raw-body disposal |
| Capability poisoning | Intersection with versioned local table; unknown upstream entries ignored |
| Stale result | Five-minute TTL and explicit `stale` state; no background refresh |
| Existing plugin interference | No runtime imports, execution, writes, configuration, state reads, or output reuse |
| Command injection | No shell; fixed executable, arguments, operation, and Keychain item identifiers |
| Audit leakage | Fixed redacted audit schema; no headers, signatures, raw response, identity, or mode |

## 11. Testing Strategy

All automated tests use fake Keychain and fake transport providers. CI must
never call the real Lovart origin.

### 11.1 Authorization tests

- feature-disabled requests return `PROBE_DISABLED` with zero calls;
- authorizations expire after two minutes;
- a record can be consumed exactly once;
- concurrent claims allow one winner;
- stale, mismatched, and replayed requests produce zero Keychain and network
  calls;
- idempotent replay returns the stored summary with zero side effects.

### 11.2 Transport-boundary tests

- the request is exactly the fixed origin, method, path, and empty body;
- redirects, proxy inheritance, TLS downgrade, and custom destinations fail;
- timeout, 429, and 5xx responses do not retry;
- every authorization produces at most one request;
- oversized and non-JSON responses stop safely;
- production code exposes no generic request or endpoint option.

### 11.3 Credential-isolation tests

- only a fake Keychain provider is used;
- missing credentials result in zero network calls;
- marker secrets never appear in process arguments, inherited environment,
  stdout, stderr, MCP envelopes, state files, or audit events;
- child failures never return signing headers or account identifiers.

### 11.4 Capability tests

- only mapped workbench models are emitted;
- unknown upstream models are ignored;
- missing mapped models are `unavailable`;
- ambiguous local models are `unknown`;
- unknown response structures are not guessed;
- mode, balance, identity, and raw `detail` never persist.

### 11.5 MCP and regression tests

- the server exposes exactly 14 tools;
- the original 12 tools retain their schemas and behavior;
- disabled, authorized, successful, rejected, timed-out, and replayed probe
  flows have stable structured envelopes;
- all existing 86 tests continue to run;
- plugin validation passes;
- static checks reject imports, execution, or writes involving the existing
  Lovart plugin;
- protected-path verification passes before and after implementation.

## 12. Acceptance Criteria

Milestone 6 implementation is acceptable only when:

- CI reports zero failures;
- the original workspace-only live fingerprint test is the only permitted skip
  in a standalone clone;
- every negative authorization and credential test proves a real-request count
  of zero;
- every successful authorization proves a request count of at most one;
- no secret or raw upstream response appears in Git, logs, tests, MCP output,
  or state;
- all M5 fixture, cost-confirmation, iteration, and state-machine behavior is
  unchanged;
- availability remains advisory and does not mutate task behavior;
- the existing Lovart protected-path manifest remains identical;
- no production upload, generation, confirmation, project, thread, result, or
  status adapter exists.

## 13. Rollback

The probe feature flag defaults to disabled. Disabling it makes both new tools
return `PROBE_DISABLED` before Keychain or network access. Probe state is stored
outside the M5 workbench schema, so rollback requires no workbench migration and
does not alter existing jobs, drafts, artifacts, or fixture decisions.

The redacted probe-state file may remain for audit history. Deleting it is not
required for rollback and is outside automated rollback behavior.

## 14. Release Gates

Release proceeds in this order:

1. merge this reviewed design document;
2. write and approve a detailed implementation plan;
3. implement with fake Keychain and fake transport only;
4. pass automated tests, plugin validation, security review, and protected-path
   verification;
5. obtain separate user authorization for one real read-only probe;
6. provision the dedicated Keychain items through the user-run protected flow;
7. enable the feature locally and execute one probe;
8. verify the redacted summary and protected-path fingerprint;
9. restore the default-disabled setting;
10. stop without upload, generation, confirmation, or other Lovart integration.

No approval in this design phase authorizes step 5 or any billable operation.
