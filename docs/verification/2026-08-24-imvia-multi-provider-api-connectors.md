# Multi-provider API connectors — verification record

Date: 2026-08-25

## Fake-provider end-to-end proof

`test/provider-e2e.test.mjs` runs an injected generic provider through the
public workbench boundary.  It submits an external-provider snapshot over
HTTP, claims it through the session bridge, executes exactly that job through
the MCP workbench execution tool, and verifies the provider-side call order is
one submit, one poll, and one import.  A second execution request does not
issue another provider call.

The fixture returns and imports three distinct artifacts: two images and one
video. The test observes submitted (5%), generating (65%), and completed
progress over both the MCP progress callback and parsed `job.updated` /
`job.progress` SSE events, then verifies the persisted job has completed
progress and the frozen public provider label.

The serialized HTTP response, SSE payload and parsed events, MCP progress
payloads, persisted job state, and MCP tool result are checked against the
injected credential value and credential-shaped keys. No credential value,
field name, reference, access key, or secret key is present in those public
surfaces. The test uses an injected in-memory credential reader only; it does
not call a native credential helper or trigger a credentials dialog.

## Commands and results

The package gate is present as:

```text
pnpm test:providers
```

In this desktop verification environment the bundled `pnpm` shell could not
resolve `node` (`sh: node: command not found`).  The equivalent command was
therefore run directly with Codex's bundled Node runtime and passed (51 tests,
including the fake-provider HTTP/SSE/MCP E2E and provider UI/selection suites):

```text
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test --test-reporter=dot test/provider-*.test.mjs \
  test/workbench-provider-selection.test.mjs \
  test/workbench-provider-ui.test.mjs test/provider-e2e.test.mjs
```

`test/skill-contract.test.mjs` was then included in the adjacent orchestration
suite and passed there.

The local loopback listener is intentionally part of the E2E.  It is blocked
by the default sandbox (`listen EPERM`), but passed when executed with the
scoped local-loopback test permission; no external network service was used.

The orchestration-adjacent bundled-node suite ran 60 checks successfully. Two
pre-existing `agent-workflow` checks still expect the former upload ordering;
they do not exercise the fake provider or its routing. The protection suite
ran 9 checks successfully. Its one `protected-paths` baseline check remains
blocked by pre-existing dirty/generated files in the unrelated
`lovart-codex-plugin/.worktrees/lovart-local-macos-credentials` worktree.  The
failure reports that external baseline drift rather than a connector change.

Finally, `git diff --check` passed.

## Platform-dependent helper result

No platform-native credential helper was invoked by this fake-provider test:
the credential reader is deliberately injected so that the proof can verify
backend-only use and public redaction without opening any macOS keychain
prompt.  Native-helper verification remains a separate platform integration
concern.
