#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowed = new Set(["ON_INSTALL", "ON_USE"]);

function fail(code, message = code) { const error = new Error(message); error.code = code; throw error; }

export async function updateMarketplaceAuthPolicy({ marketplace, plugin, authentication }) {
  if (!marketplace || !plugin || !allowed.has(authentication)) fail("MARKETPLACE_ARGUMENT_INVALID");
  let document;
  try { document = JSON.parse(await readFile(marketplace, "utf8")); } catch { fail("MARKETPLACE_INVALID"); }
  if (document?.name !== "personal") fail("MARKETPLACE_NAME_MISMATCH");
  if (!Array.isArray(document.plugins)) fail("MARKETPLACE_INVALID");
  const matches = document.plugins.filter((entry) => entry?.name === plugin);
  if (matches.length !== 1) fail(matches.length ? "PLUGIN_ENTRY_DUPLICATE" : "PLUGIN_ENTRY_MISSING");
  const entry = matches[0];
  if (entry.source?.source !== "local" || typeof entry.source.path !== "string") fail("PLUGIN_SOURCE_NOT_LOCAL");
  if (!entry.policy || typeof entry.policy !== "object") fail("PLUGIN_POLICY_INVALID");
  const updated = structuredClone(document);
  const target = updated.plugins.find((item) => item?.name === plugin);
  target.policy.authentication = authentication;
  const temporary = `${marketplace}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, marketplace);
  return updated;
}

function cliArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) fail("MARKETPLACE_ARGUMENT_INVALID");
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const values = cliArgs(process.argv.slice(2));
    await updateMarketplaceAuthPolicy({ marketplace: values.marketplace, plugin: values.plugin, authentication: values.authentication });
    process.stdout.write("marketplace authentication policy updated\n");
  } catch (error) {
    process.stderr.write(`${error.code || "MARKETPLACE_UPDATE_FAILED"}\n`);
    process.exitCode = 1;
  }
}
