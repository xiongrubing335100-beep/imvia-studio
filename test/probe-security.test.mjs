import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probeDirectory = path.join(packageDirectory, "src/probe");

const reviewedProductionHashes = Object.freeze({
  "scripts/configure-lovart-readonly.swift": "137fc6674246aa624466b1a9ba1403ffaf6b82f8cca6b1111a5a642a67a010bd",
  "scripts/set-lovart-readonly-probe.mjs": "fae16a18f93ab274b64053889b505c3c59e3404682c6a7266d55ae6372518b66",
  "scripts/verify-protected-paths.mjs": "0ee549fff97831b338460570661e85cfb15ee6a5368c48b97256478f48fe0886",
  "src/domain/model-capabilities.js": "53609d3eba84809c7988184b34a35aaf4ee790f9cffa6a80685477459d677b00",
  "src/persistence/json-store.js": "12469ba9bd44c9fe76bd79bb948961ab50404a7fe22e53044422ad1d5cf55204",
  "src/probe/authorization-service.js": "8b3eebe93d748599b14d4ab0415aa57ce6dbeed4a7626c5b09ac84de3f0bdd0c",
  "src/probe/capability-normalizer.js": "f3ee013051aa8db5367a61dc9c5bda38d543d8228c7fc044d62e48603e48fd09",
  "src/probe/child-core.js": "bbfd3b4676d81cdac39b35b0b6ebc5801fc3d1e712b4b2ccf99a9bf0df9c2939",
  "src/probe/child-runner.js": "ae76a6190f27d06dc6b1bf2214397312102e7d9f4374bb548a08cdb89fa74b3c",
  "src/probe/child.js": "f3d45e816940c24fdcee0a00b0a33a569bebfdfe5f3fade81c85da3526c79914",
  "src/probe/constants.js": "eadff6620237d3ae968bea3eae15e702381029e7572b85e7c832f4e9f8ba71b9",
  "src/probe/keychain-provider.js": "203a5a5eea632b07a9911dcf83d1de0b371d14497f440d980f42c5e35f713c0f",
  "src/probe/probe-service.js": "6da41d3894a27a17ade4d128148d70fc74899fa8f4ebfedc822bc97866457986",
  "src/probe/probe-state-validator.js": "8b1a6545221a94842b4df710041475768ff8c24d295ef74057f05f9db46ce043",
  "src/probe/probe-store.js": "aa20ffea69784749925fb51a1df36ab2124a916238a1595f79563f4a16e40637",
  "src/probe/summary-validator.js": "728d94ed8bdd12b880fa73c59983e98f8076c17262b59c6b02f111b434edc982",
  "src/probe/transport.js": "eb14acf43af1d0a6d86936cb79b5f4acab5f908914eafc2dfaaff843a1ca2f34",
});
const reviewedNormalizedIndexHash = "7cebe5d04d731108c0f1888913982d820ec8ecfdd767bdba4f5f4cc577dfe0ba";

const reviewedImports = Object.freeze({
  "scripts/configure-lovart-readonly.swift": ["AppKit", "Darwin", "Security"],
  "scripts/set-lovart-readonly-probe.mjs": ["../src/probe/authorization-service.js", "../src/probe/probe-store.js", "node:path", "node:url"],
  "scripts/verify-protected-paths.mjs": ["node:crypto", "node:fs/promises", "node:path", "node:url"],
  "src/domain/model-capabilities.js": [],
  "src/index.js": [
    "./domain/timestamps.js", "./domain/workbench-service.js", "./http/server.js",
    "./lovart/artifact-transfer.js", "./lovart/credentials.js", "./lovart/generation-orchestrator.js", "./lovart/generation-service.js", "./lovart/project-context-service.js",
    "./probe/authorization-service.js", "./probe/child-runner.js", "./probe/probe-service.js",
    "./probe/probe-store.js", "@modelcontextprotocol/sdk/server/mcp.js",
    "@modelcontextprotocol/sdk/server/stdio.js", "node:path", "node:url", "zod",
  ],
  "src/persistence/json-store.js": ["node:crypto", "node:fs/promises", "node:path", "node:timers/promises"],
  "src/probe/authorization-service.js": ["../domain/errors.js", "./constants.js", "./summary-validator.js", "node:crypto"],
  "src/probe/capability-normalizer.js": ["../domain/errors.js", "../domain/model-capabilities.js", "./constants.js"],
  "src/probe/child-core.js": ["../domain/errors.js"],
  "src/probe/child-runner.js": ["../domain/errors.js", "./summary-validator.js", "node:child_process", "node:path", "node:url"],
  "src/probe/child.js": ["./capability-normalizer.js", "./child-core.js", "./keychain-provider.js", "./transport.js"],
  "src/probe/constants.js": [],
  "src/probe/keychain-provider.js": ["../domain/errors.js", "./constants.js", "node:child_process"],
  "src/probe/probe-service.js": ["../domain/errors.js"],
  "src/probe/probe-state-validator.js": ["../domain/errors.js", "./constants.js", "./summary-validator.js"],
  "src/probe/probe-store.js": ["../persistence/json-store.js", "./constants.js", "./probe-state-validator.js"],
  "src/probe/summary-validator.js": ["../domain/errors.js", "../domain/model-capabilities.js", "./capability-normalizer.js", "./constants.js"],
  "src/probe/transport.js": ["../domain/errors.js", "./constants.js", "node:crypto", "node:https"],
});

const reviewedOperationIdentifiers = new Set([
  "PROBE_RESULT_TTL_MS", "capability_status", "destroyRequest",
  "generate_image_midjourney", "generate_image_nano_banana_2",
  "generate_image_nano_banana_pro", "generate_image_seedream_v4",
  "generate_image_seedream_v5", "generate_video_kling_v3",
  "generate_video_kling_v3_omni", "generate_video_minimax_h3",
  "generate_video_seedance_v2_0_fast", "generate_video_seedance_v2_5",
  "httpsRequest", "mapRequestFailure", "mapStatusFailure", "request",
  "requestImpl", "requestLovartModeQuery", "result", "status", "statusCode",
  "statusFailure",
]);
const sensitiveValuePattern = /(?:accessKey|secretKey|credential|raw|header|signature|account|billing|balance)/i;
const reviewedSensitiveFlows = new Set(["keychainProvider:readProbeCredentials"]);

async function recursiveFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return recursiveFiles(entryPath, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [entryPath] : [];
  }));
  return nested.flat().sort();
}

async function inspectProbeInventory(directory) {
  const paths = [];
  const violations = [];
  async function visit(currentDirectory) {
    const entries = (await readdir(currentDirectory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(directory, entryPath).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        violations.push(`symlink: ${relativePath}`);
      } else if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (!entry.isFile()) {
        violations.push(`non-regular entry: ${relativePath}`);
      } else if (!entry.name.endsWith(".js")) {
        violations.push(`non-js file: ${relativePath}`);
      } else {
        paths.push(entryPath);
      }
    }
  }
  await visit(directory);
  return { paths: paths.sort(), violations };
}

async function readNamedSources(paths) {
  return Promise.all(paths.map(async (relativePath) => ({
    path: relativePath,
    source: await readFile(path.join(packageDirectory, relativePath), "utf8"),
  })));
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
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

function extractBalanced(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0) return source.slice(openingIndex + 1, index);
  }
  throw new Error("Unbalanced call expression");
}

function extractModuleSpecifiers(source, sourcePath) {
  if (sourcePath.endsWith(".swift")) {
    return [...source.matchAll(/^import\s+([A-Za-z][\w.]*)\s*$/gm)].map((match) => match[1]).sort();
  }
  const specifiers = [];
  for (const match of source.matchAll(/\bfrom\s*(["'])([^"']+)\1|\bimport\s*(["'])([^"']+)\3/g)) {
    specifiers.push(match[2] ?? match[4]);
  }
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(["'])([^"']+)\1\s*\)/g)) {
    specifiers.push(match[2]);
  }
  return specifiers.sort();
}

function isNetworkModuleSpecifier(specifier) {
  return /^(?:node:)?(?:http|https|net|tls|dns)$/.test(specifier);
}

function hasDirectNetworkCall(code) {
  return /\b(?:http|https)\s*\.\s*request\s*\(/.test(code)
    || /\bnet\s*\.\s*(?:connect|createConnection)\s*\(/.test(code)
    || /\b(?:tls|dns)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.test(code);
}

function auditProductionSource(sourcePath, source, { enforceImports = true } = {}) {
  const violations = [];
  const code = maskLiteralsAndComments(source);
  const imports = extractModuleSpecifiers(source, sourcePath);
  if (enforceImports && Object.hasOwn(reviewedImports, sourcePath)
    && JSON.stringify(imports) !== JSON.stringify(reviewedImports[sourcePath])) {
    violations.push("import allowlist changed");
  }
  if (/\bimport\s*\(\s*[^"'\s]/.test(code)) violations.push("dynamic non-literal import");
  if (/lovart-codex-plugin|\/lovart插件|\.codex\/plugins\/cache\/lovart|\.worktrees\/lovart-local/i.test(source)) {
    violations.push("protected Lovart dependency");
  }

  const networkModules = imports.filter(isNetworkModuleSpecifier);
  if (sourcePath === "src/probe/transport.js") {
    if (JSON.stringify(networkModules) !== JSON.stringify(["node:https"])) violations.push("transport network import changed");
    if (/\bhttpsRequest\s*\(/.test(code) || hasDirectNetworkCall(code)) violations.push("transport bypassed request seam");
  } else if (networkModules.length || /\b(?:httpsRequest|fetch)\s*\(/.test(code) || hasDirectNetworkCall(code)) {
    violations.push("network authority outside transport");
  }

  const processModules = imports.filter((specifier) => specifier === "node:child_process");
  const processAllowed = sourcePath === "src/probe/keychain-provider.js" || sourcePath === "src/probe/child-runner.js";
  if ((!processAllowed && processModules.length) || (!processAllowed && /\b(?:exec|execFile|execSync|spawn|spawnSync)\s*\(/.test(code))) {
    violations.push("process authority outside reviewed adapter");
  }
  if (/\bshell\s*:\s*true\b|\benv\s*:\s*(?:process\.env|\{\s*\.\.\.\s*process\.env)/.test(code)) {
    violations.push("shell or inherited environment");
  }

  if (/\b(?:writeFile|appendFile|rename|rm|unlink|mkdir)\s*\(/.test(code)
    && !["scripts/verify-protected-paths.mjs", "src/persistence/json-store.js"].includes(sourcePath)) {
    violations.push("filesystem write outside JsonStore");
  }

  if (sourcePath.startsWith("src/probe/")) {
    const operationPattern = /(?:upload|generat|confirm|project|thread|result|status|balance|request)/i;
    for (const identifier of new Set(source.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      if (operationPattern.test(identifier) && !reviewedOperationIdentifiers.has(identifier)) {
        violations.push(`unreviewed operation identifier ${identifier}`);
      }
    }
  }

  if (/(?:authorization-service|probe-store|child(?:-runner)?|probe-service|json-store)\.js$/.test(sourcePath)) {
    const propertyPattern = /(?:^|[,{])\s*(?:["']([A-Za-z_$][\w$]*)["']|([A-Za-z_$][\w$]*))\s*:\s*([A-Za-z_$][\w$]*)/gm;
    for (const match of source.matchAll(propertyPattern)) {
      const flow = `${match[1] ?? match[2]}:${match[3]}`;
      if (sensitiveValuePattern.test(match[3]) && !reviewedSensitiveFlows.has(flow)) violations.push(`sensitive value flow ${flow}`);
    }
  }
  return violations;
}

function auditProbeTestSource(source) {
  const violations = [];
  const code = maskLiteralsAndComments(source);
  const imports = extractModuleSpecifiers(source, "test/fixture.mjs");
  if (imports.some(isNetworkModuleSpecifier)) violations.push("real network module");
  if (/\bfetch\s*\(/.test(code)) violations.push("real fetch");
  if (hasDirectNetworkCall(code)) violations.push("direct real network call");
  if (/\brequestImpl\s*:\s*(?:https|http|net|tls|dns)\s*\./.test(code)) violations.push("real request implementation");
  for (const match of code.matchAll(/\brequestLovartModeQuery\s*\(/g)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    if (!/\brequestImpl\b/.test(extractBalanced(code, openingIndex))) violations.push("missing fake requestImpl");
  }
  return violations;
}

function isProbeRelatedTest(source) {
  const imports = extractModuleSpecifiers(source, "test/candidate.mjs");
  return imports.some((specifier) => /(?:^|\/)src\/probe\/|(?:^|\/)src\/index\.js$/.test(specifier))
    || /scripts\/(?:configure-lovart-readonly|set-lovart-readonly-probe)/.test(source);
}

test("every production security-boundary file matches its reviewed digest", async () => {
  const inventory = await inspectProbeInventory(probeDirectory);
  assert.deepEqual(inventory.violations, []);
  const actualProbePaths = inventory.paths
    .map((filePath) => path.relative(packageDirectory, filePath));
  const reviewedProbePaths = Object.keys(reviewedProductionHashes).filter((sourcePath) => sourcePath.startsWith("src/probe/"));
  assert.deepEqual(actualProbePaths, reviewedProbePaths);
  const sources = await readNamedSources(Object.keys(reviewedProductionHashes));
  for (const { path: sourcePath, source } of sources) {
    assert.equal(sha256(source), reviewedProductionHashes[sourcePath], `${sourcePath} changed; require a separate security review`);
  }
});

test("security inventory covers the model table, strict validators, and protected verifier", () => {
  for (const sourcePath of [
    "scripts/verify-protected-paths.mjs",
    "src/domain/model-capabilities.js",
    "src/probe/probe-state-validator.js",
    "src/probe/summary-validator.js",
  ]) {
    assert.equal(Object.hasOwn(reviewedProductionHashes, sourcePath), true, `${sourcePath} hash`);
    assert.equal(Object.hasOwn(reviewedImports, sourcePath), true, `${sourcePath} imports`);
  }
});

test("probe inventory rejects non-JavaScript files and file or directory symlinks", async (context) => {
  const sandbox = await mkdtemp(path.join(packageDirectory, ".probe-inventory-test-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  await writeFile(path.join(sandbox, "reviewed.js"), "export {};\n");
  await writeFile(path.join(sandbox, "rogue.mjs"), "export {};\n");
  await mkdir(path.join(sandbox, "nested"));
  await writeFile(path.join(sandbox, "nested/also-reviewed.js"), "export {};\n");
  await symlink("reviewed.js", path.join(sandbox, "file-link.js"));
  await symlink("nested", path.join(sandbox, "directory-link"));

  const inventory = await inspectProbeInventory(sandbox);
  assert.deepEqual(inventory.violations, [
    "symlink: directory-link",
    "symlink: file-link.js",
    "non-js file: rogue.mjs",
  ]);
});

test("index probe integration matches its reviewed digest except for plugin version", async () => {
  const source = await readFile(path.join(packageDirectory, "src/index.js"), "utf8");
  const versionDeclaration = /const PLUGIN_VERSION = "[^"]+";/g;
  assert.equal([...source.matchAll(versionDeclaration)].length, 1);
  const normalized = source.replace(versionDeclaration, "const PLUGIN_VERSION = \"<PLUGIN_VERSION>\";");
  assert.equal(sha256(normalized), reviewedNormalizedIndexHash, "src/index.js probe integration changed; require a separate security review");
});

test("reviewed files keep exact imports and least-authority structure", async () => {
  const sources = await readNamedSources(Object.keys(reviewedImports));
  for (const { path: sourcePath, source } of sources) {
    assert.deepEqual(extractModuleSpecifiers(source, sourcePath), reviewedImports[sourcePath], `${sourcePath} imports`);
    assert.deepEqual(auditProductionSource(sourcePath, source), [], sourcePath);
  }
});

test("transport provenance and the single fixed request seam remain pinned", async () => {
  const constants = await import("../src/probe/constants.js");
  assert.deepEqual({
    origin: constants.LOVART_ORIGIN,
    path: constants.LOVART_PATH,
    method: constants.LOVART_METHOD,
    body: constants.LOVART_BODY,
    skillVersion: constants.LOVART_SKILL_VERSION,
    clientSha256: constants.LOVART_CLIENT_SHA256,
    skillSha256: constants.LOVART_SKILL_SHA256,
  }, {
    origin: "https://lgw.lovart.ai",
    path: "/v1/openapi/mode/query",
    method: "POST",
    body: "{}",
    skillVersion: "1.0.11",
    clientSha256: "39c68e32c2262f7f1b3890f684e33b149f9da3d5577fc591b7b4e640a87e4878",
    skillSha256: "561bba809f4ea2e4c4bbb1c02a34e494d21bb688e7a336a058156c26e71bd9d3",
  });
  const transport = await readFile(path.join(packageDirectory, "src/probe/transport.js"), "utf8");
  for (const name of ["LOVART_ORIGIN", "LOVART_PATH", "LOVART_METHOD", "LOVART_BODY"]) assert.match(transport, new RegExp(`\\b${name}\\b`));
  assert.equal((transport.match(/\brequestImpl\s*\(\s*options\s*,\s*onResponse\s*\)/g) ?? []).length, 1);
  assert.doesNotMatch(maskLiteralsAndComments(transport), /\bhttpsRequest\s*\(/);
});

test("security reviewer rejects representative authority and value-flow bypasses", async () => {
  const mutations = [
    ["src/probe/probe-service.js", "async function persist(value) { await writeFile(target, value); }"],
    ["src/probe/transport.js", "httpsRequest(endpoint);"],
    ["src/probe/probe-service.js", "function uploadAsset() {}"],
    ["src/probe/probe-service.js", "const handlers = { \"uploadAsset\": operation };"],
    ["src/probe/child.js", "const envelope = { payload: rawResponse };"],
  ];
  for (const [sourcePath, mutation] of mutations) {
    const reviewedSource = await readFile(path.join(packageDirectory, sourcePath), "utf8");
    assert.notEqual(auditProductionSource(sourcePath, `${reviewedSource}\n${mutation}`).length, 0, mutation);
  }
});

test("probe-related tests cannot fall through to a real network implementation", async () => {
  const testPaths = await recursiveFiles(path.join(packageDirectory, "test"), ".mjs");
  for (const testPath of testPaths) {
    const source = await readFile(testPath, "utf8");
    const relativePath = path.relative(packageDirectory, testPath);
    if (relativePath === "test/probe-security.test.mjs" || !isProbeRelatedTest(source)) continue;
    assert.deepEqual(auditProbeTestSource(source), [], relativePath);
  }
});

test("network-test reviewer rejects static, dynamic, require, fetch, and real request injections", () => {
  const mutations = [
    "import https from \"node:https\";",
    "import https from \"https\"; https.request({});",
    "const https = await import(\"node:https\");",
    "const net = require(\"node:net\");",
    "const http = require(\"http\"); http.request({});",
    "const net = await import(\"net\"); net.createConnection({});",
    "import tls from \"tls\"; tls.connect({});",
    "const dns = require(\"dns\"); dns.lookup(\"example.invalid\", () => {});",
    "await fetch(target);",
    "requestLovartModeQuery({ requestImpl: https.request });",
  ];
  for (const source of mutations) assert.notEqual(auditProbeTestSource(source).length, 0, source);
});
