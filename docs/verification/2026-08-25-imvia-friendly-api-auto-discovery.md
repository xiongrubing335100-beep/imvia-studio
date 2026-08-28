# Friendly API auto-discovery verification — 2026-08-25

## Scope and source revision

- Workspace: `/Users/a1234/Documents/ChatGPT/imvia stuio`
- Source revision at verification: `2029d10` (the current `HEAD` when this
  record was prepared)
- Test runtime: `/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`
  because `node` is not on this shell's `PATH`.
- No real provider, native credential store, or Lovart network call was made.
  All provider HTTP/E2E coverage used controlled local fixtures. The temporary
  loopback permission was limited to `127.0.0.1` test listeners.

## Contract and focused gates

1. Added the friendly external-provider skill contract, then ran:

   ```text
   node --test test/skill-contract.test.mjs
   ```

   The intentional RED run had 7 passed and 1 failed: the missing `API address
   and API Key` phrase. After the minimal skill update, the same command passed
   **8/8**. The contract states that a modern connection takes only optional
   name, API address, and API Key; the external model ID is selected from the
   discovered catalog; `imvia_execute_workbench_submission` uses the frozen
   provider adapter; and an external job never calls or falls back to Lovart.

2. Updated `test:providers` to include `test/model-catalog.test.mjs` and
   `test/openai-compatible-images.test.mjs`. `pnpm test:providers` expands the
   intended command but cannot start because the shell has no `node` on `PATH`.
   The identical bundled-Node command passed **101/101** after the scoped
   local-loopback rerun. The initial sandbox-only execution had 98 passed and
   three `listen EPERM` fixture failures; it made no network request.

3. The requested focused source/skill command passed **38/38**:

   ```text
   node --test test/provider-url-security.test.mjs test/model-catalog.test.mjs \
     test/provider-discovery.test.mjs test/openai-compatible-images.test.mjs \
     test/provider-connection-service.test.mjs test/skill-contract.test.mjs
   ```

4. `git diff --check` passed.

5. After the late Task 1/6 transport and test-provider corrections, the
   current-tree verification passed **152/152**. The release fixes preserve the
   adapter boundary for connection testing: a modern record resolves only its
   exact pinned trusted adapter (`adapter_id` and `adapter_version`), invalid
   adapter identity returns stable `VALIDATION_FAILED`, and it never falls
   through to legacy generic mappings. Legacy `custom-rest` remains on generic
   REST validation, with its historical `{ accepted: true, code: "CONNECTED" }`
   response normalized to `status: "connected"`. The associated HTTP and MCP
   regressions retain the correct execution inputs for both record kinds.

## Required feature evidence

- The friendly provider UI tests cover only the API-name/API-address flow and
  assert that modern connections expose no JSON controls.
- `test/openai-compatible-images.test.mjs` passed its read-only discovery
  cases, including `discovers OpenAI-compatible models with read-only GET
  requests` and ordered model candidates.
- The model-catalog, selector, HTTP/E2E, and adapter tests passed while
  preserving the raw model ID/name across discovery, selection, snapshot, and
  frozen adapter submission.
- Connection lifecycle tests passed the catalog-refresh-without-execution-
  invalidation case, while execution tests passed the configuration-revision
  rejection cases.
- The modern external E2E and router fixtures passed with zero Lovart fallback,
  including external adapter authentication failure. The generic-provider
  failure fixture also passed its zero-Lovart assertion.
- Migration coverage passed: `migrates the existing state file, makes a private
  backup, and preserves legacy custom REST mappings`; legacy `custom-rest`
  remains executable through its generic connector fixture.
- Public result and snapshot tests passed their redaction assertions. This
  record intentionally contains no API key, authorization header, credential
  value, or raw native-helper stderr.

## Native and repository gates

- `cargo test --manifest-path native/credential-helper/Cargo.toml` could not
  start: `cargo` is not installed in this environment. No toolchain or
  dependency installation was attempted.
- `pnpm test` cannot start for the same shell-level missing-`node` condition.
  The equivalent full bundled-Node suite completed with **576 passed, 10
  failed**. The failures are unrelated baseline/protection failures that were
  not repaired in this task:
  - `native setup owns secure fields and a private local file store`
  - `starts the independent imvia-studio MCP and responds to imvia_health`
  - `MCP exposes exactly two new probe tools and preserves all original schemas`
  - `MCP recursively redacts sensitive domain and bridge error details`
  - `MCP reads, patches, prepares, and lists only its local workbench state`
  - `every production security-boundary file matches its reviewed digest`
  - `index probe integration matches its reviewed digest except for plugin version`
  - `reviewed files keep exact imports and least-authority structure`
  - `probe-related tests cannot fall through to a real network implementation`
  - `current Lovart protected paths still match the recorded baseline`
- The protected-path suite passed 9/10 fixture/package checks; the final live
  baseline comparison failed because its recorded external Lovart worktree
  contents differ (including Git worktree metadata and installed dependencies).
  That protected location was not modified.
- `plugin-creator/scripts/validate_plugin.py` is blocked before validation by
  `ModuleNotFoundError: No module named 'yaml'`. No validator findings were
  produced, and no Python dependency was installed.

## Final release installation and cache comparison

The Task 10 cachebuster first produced `0.3.0+codex.20260825143724`. After the
late Task 1/6 fixes, the release cache was refreshed, reinstalled, and verified
as final version **`0.3.0+codex.20260825152805`** at:

```text
/Users/a1234/.codex/plugins/cache/personal/imvia-studio/0.3.0+codex.20260825152805
```

Current workspace/cache SHA-256 comparisons match for the manifest, skill,
`provider-discovery.js`, `model-catalog.js`, `provider-execution-router.js`,
`src/http/server.js`, `src/index.js`, the provider-connections workbench asset,
and the provider HTTP/MCP workbench regression tests. This is a file-content
verification only. A new Codex task is still required to exercise the
reinstalled skill and MCP process; this task's older process is not evidence
that the final package is loaded.
