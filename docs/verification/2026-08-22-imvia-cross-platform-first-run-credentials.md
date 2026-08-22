# IMVIA Studio first-run credential verification

## Scope

This change keeps IMVIA Studio credentials independent from the existing
Lovart plugin. macOS uses `ai.imvia.studio.lovart` / `credentials`; Windows
uses `IMVIA.Studio.Lovart`. No credential values are recorded here.

## Repository evidence

- Branch: `codex/milestone-6-readonly-probe-design`
- Protocol boundary: `0eee2ee`
- Helper packaging: `bb2476d`
- Credential service and onboarding: `906c9a9`
- MCP/HTTP/workbench/docs: `7c1e7d3`
- Helper targets: `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64`

## Verified locally

Using the bundled Codex Node 24 runtime:

```text
node --test test/lovart-helper-manifest.test.mjs test/lovart-helper-client.test.mjs
node --test test/credential-helper-packaging.test.mjs
node --test test/lovart-credentials.test.mjs test/lovart-generation.test.mjs
node --test test/lovart-onboarding.test.mjs test/lovart-credential-migration.test.mjs
node --test test/mcp-lovart-connection.test.mjs test/mcp-workbench.test.mjs
node --test test/http-server.test.mjs test/mcp-health.test.mjs
node --test test/workbench-lovart-onboarding.test.mjs test/marketplace-policy.test.mjs
node --test test/mcp-probe.test.mjs test/probe-security.test.mjs
```

All focused suites pass. The complete Node suite has one pre-existing
environmental exception: the protected Lovart workspace is already dirty with
untracked files outside this repository. It was not modified or reset.

## Native build limitation

The current development environment has no `cargo` or `rustc`. Attempts to
install an isolated Rust toolchain were terminated by the host process before
installation completed. Therefore the Rust helper source, Windows/macOS
backend code, and four-target CI workflow are present but native compilation,
signing, notarization, and release digests remain unverified locally. The
protected release workflow must run `cargo test`, build each target, sign the
helpers, assemble `native/manifest.json`, and run
`npm run verify:credential-helpers` before distribution.

## Security observations

- Access Key and Secret Key are exchanged only over the helper's private NDJSON
  pipe and are never in MCP, HTTP, SSE, URLs, browser state, or logs.
- Candidate validation happens before helper commit, preserving the previous
  credential pair on rejection, cancellation, timeout, or network failure.
- First workbench open is single-flight; duplicate opens reuse one setup
  session. The status rail is connected-only.
- No code reads, migrates, overwrites, or infers the existing Lovart plugin's
  namespace or state.
