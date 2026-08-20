import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probeDirectory = path.join(packageDirectory, "src/probe");
const productionScriptPaths = [
  "scripts/configure-lovart-readonly.swift",
  "scripts/set-lovart-readonly-probe.mjs",
];
const allowedBoundaryConstantKeys = new Set([
  "CREDENTIAL_REFERENCE_UNAVAILABLE",
  "UPSTREAM_UNREACHABLE",
  "UPSTREAM_SECURITY_REJECTED",
  "AUTHENTICATION_FAILED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_SCHEMA_UNRECOGNIZED",
  "STORE_UNAVAILABLE",
]);

async function recursiveFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return recursiveFiles(entryPath, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [entryPath] : [];
  }));
  return nested.flat().sort();
}

async function readNamedSources(paths) {
  return Promise.all(paths.map(async (relativePath) => ({
    path: relativePath,
    source: await readFile(path.join(packageDirectory, relativePath), "utf8"),
  })));
}

async function readProductionSources() {
  const probePaths = (await recursiveFiles(probeDirectory, ".js"))
    .map((filePath) => path.relative(packageDirectory, filePath));
  return readNamedSources([...probePaths, "src/index.js", ...productionScriptPaths]);
}

function maskLiteralsAndComments(source) {
  let result = "";
  let index = 0;
  const masked = (character) => character === "\n" || character === "\r" ? character : " ";
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") result += " ", index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += masked(source[index]);
        index += 1;
      }
      if (index < source.length) result += "  ", index += 2;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      const quote = character;
      result += " ";
      index += 1;
      while (index < source.length) {
        const current = source[index];
        result += masked(current);
        index += 1;
        if (current === "\\" && index < source.length) {
          result += masked(source[index]);
          index += 1;
        } else if (current === quote) {
          break;
        }
      }
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

function extractBalanced(source, openingIndex, open = "(", close = ")") {
  assert.equal(source[openingIndex], open);
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) depth -= 1;
    if (depth === 0) return source.slice(openingIndex + 1, index);
  }
  throw new Error(`Unbalanced ${open}${close} group`);
}

function normalizedIdentifier(value) {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function objectKeys(source) {
  const code = maskLiteralsAndComments(source);
  const keys = [];
  for (const match of code.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/gm)) keys.push(match[1]);
  for (const match of code.matchAll(/\b(?:state|record|attempt|summary|envelope|result)\.([A-Za-z_$][\w$]*)\s*=/g)) {
    keys.push(match[1]);
  }
  return keys;
}

function assertNoForbiddenKeys(source, forbidden, label) {
  for (const key of objectKeys(source)) {
    if (allowedBoundaryConstantKeys.has(key)) continue;
    const normalized = normalizedIdentifier(key);
    assert.equal(
      forbidden.some((word) => normalized === word || normalized.startsWith(`${word}_`) || normalized.endsWith(`_${word}`)),
      false,
      `${label} exposes forbidden field ${key}`,
    );
  }
}

test("production probe has no protected Lovart dependency or expanded operation authority", async () => {
  const production = await readProductionSources();
  const protectedReferences = [
    "lovart-codex-plugin",
    "/lovart插件",
    ".codex/plugins/cache/lovart",
    ".worktrees/lovart-local",
  ];
  for (const { path: sourcePath, source } of production) {
    for (const forbidden of protectedReferences) {
      assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `${sourcePath}: ${forbidden}`);
    }
  }

  const probeSources = production.filter(({ path: sourcePath }) => sourcePath.startsWith("src/probe/"));
  const forbiddenOperation = /^(?:upload|generate|confirm|create_?project|create_?thread|query_?result|query_?status|query_?balance)$/i;
  const forbiddenGenericRequest = /^(?:request|send_?request|execute_?request|request_?operation)$/i;
  for (const { path: sourcePath, source } of probeSources) {
    const code = maskLiteralsAndComments(source);
    for (const match of code.matchAll(/\bexport\s+(?:(?:async\s+)?function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      assert.doesNotMatch(match[1], forbiddenOperation, `${sourcePath}: forbidden operation export ${match[1]}`);
      assert.doesNotMatch(match[1], forbiddenGenericRequest, `${sourcePath}: generic request export ${match[1]}`);
    }
    assert.doesNotMatch(
      source,
      /\/(?:upload|generate|confirm|projects?|threads?|results?|status|balance)(?:\/|["'`])/i,
      `${sourcePath}: forbidden endpoint`,
    );
  }
});

test("probe transport provenance and its only endpoint remain pinned", async () => {
  const constants = await import("../src/probe/constants.js");
  assert.equal(constants.LOVART_ORIGIN, "https://lgw.lovart.ai");
  assert.equal(constants.LOVART_PATH, "/v1/openapi/mode/query");
  assert.equal(constants.LOVART_METHOD, "POST");
  assert.equal(constants.LOVART_SKILL_VERSION, "1.0.11");
  assert.equal(constants.LOVART_CLIENT_SHA256, "39c68e32c2262f7f1b3890f684e33b149f9da3d5577fc591b7b4e640a87e4878");
  assert.equal(constants.LOVART_SKILL_SHA256, "561bba809f4ea2e4c4bbb1c02a34e494d21bb688e7a336a058156c26e71bd9d3");
});

test("probe APIs expose no configurable destination or transport authority", async () => {
  const production = await readProductionSources();
  const forbiddenParameters = new Set([
    "origin", "url", "uri", "hostname", "host", "port", "path", "method",
    "proxy", "agent", "tls", "ca", "cert", "key", "reject_unauthorized",
    "redirect", "redirects", "follow_redirects", "retry", "retries", "request_options",
  ]);
  for (const { path: sourcePath, source } of production.filter(({ path: value }) => value.startsWith("src/probe/"))) {
    const code = maskLiteralsAndComments(source);
    for (const match of code.matchAll(/\bexport\s+(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/g)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const parameters = extractBalanced(code, openingIndex);
      for (const identifier of parameters.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        assert.equal(forbiddenParameters.has(normalizedIdentifier(identifier)), false, `${sourcePath}: configurable ${identifier}`);
      }
    }
  }

  const indexSource = production.find(({ path: sourcePath }) => sourcePath === "src/index.js").source;
  const code = maskLiteralsAndComments(indexSource);
  const declaration = code.indexOf("const runProbeInput = z.object(");
  assert.notEqual(declaration, -1, "runProbeInput schema is missing");
  const openingIndex = code.indexOf("(", declaration);
  const probeInput = extractBalanced(code, openingIndex);
  for (const key of objectKeys(probeInput)) {
    assert.equal(forbiddenParameters.has(normalizedIdentifier(key)), false, `probe MCP input exposes ${key}`);
  }
});

test("production process and transport policy cannot bypass isolation", async () => {
  const production = await readProductionSources();
  for (const { path: sourcePath, source } of production) {
    const code = maskLiteralsAndComments(source);
    assert.doesNotMatch(code, /\brejectUnauthorized\s*:\s*false\b/, `${sourcePath}: TLS bypass`);
    assert.doesNotMatch(code, /\b(?:followRedirects?|redirects?)\s*:\s*true\b/, `${sourcePath}: redirect following`);
    assert.doesNotMatch(code, /\bshell\s*:\s*true\b/, `${sourcePath}: shell execution`);
    assert.doesNotMatch(code, /\benv\s*:\s*(?:process\.env|\{\s*\.\.\.\s*process\.env)/, `${sourcePath}: inherited environment`);
    assert.doesNotMatch(code, /\bprocess\.env\.(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)\b/i, `${sourcePath}: proxy environment`);
    assert.doesNotMatch(code, /\b(?:exec|execSync|spawnSync)\s*\(/, `${sourcePath}: generic process execution`);
  }
});

test("secrets and upstream internals cannot cross the child or persistence boundary", async () => {
  const forbidden = [
    "credential", "credentials", "access_key", "secret", "secret_key", "raw", "raw_body",
    "body", "header", "headers", "signature", "account", "account_id", "billing", "billing_mode", "balance",
  ];
  const boundarySources = await readNamedSources([
    "src/probe/authorization-service.js",
    "src/probe/probe-store.js",
    "src/probe/child.js",
    "src/probe/child-runner.js",
    "src/probe/probe-service.js",
  ]);
  for (const { path: sourcePath, source } of boundarySources) {
    assertNoForbiddenKeys(source, forbidden, sourcePath);
  }
});

test("probe tests cannot fall through to a real network implementation", async () => {
  const testPaths = (await recursiveFiles(path.join(packageDirectory, "test"), ".mjs"))
    .filter((testPath) => /(?:^probe-|^mcp-probe|^capability-normalizer)/.test(path.basename(testPath)));
  for (const testPath of testPaths) {
    const source = await readFile(testPath, "utf8");
    const relativePath = path.relative(packageDirectory, testPath);
    assert.doesNotMatch(source, /\bfrom\s+["']node:(?:http|https|net|tls|dns)["']/, `${relativePath}: real network import`);
    assert.doesNotMatch(maskLiteralsAndComments(source), /\bfetch\s*\(/, `${relativePath}: real fetch`);
    const code = maskLiteralsAndComments(source);
    for (const match of code.matchAll(/\brequestLovartModeQuery\s*\(/g)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const callArguments = extractBalanced(code, openingIndex);
      assert.match(callArguments, /\brequestImpl\b/, `${relativePath}: transport call lacks a fake requestImpl`);
    }
  }
});
