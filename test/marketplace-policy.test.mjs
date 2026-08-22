import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { updateMarketplaceAuthPolicy } from "../scripts/update-marketplace-auth-policy.mjs";

function fixture() {
  return {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [
      { name: "other", source: { source: "local", path: "./plugins/other" }, policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Other" },
      { name: "imvia-studio", source: { source: "local", path: "./plugins/imvia-studio" }, policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" }, category: "Creativity" },
    ],
  };
}

async function writeFixture(value = fixture()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imvia-marketplace-"));
  const file = path.join(root, "marketplace.json");
  await writeFile(file, JSON.stringify(value, null, 2));
  return file;
}

test("changes only the selected plugin authentication policy", async () => {
  const file = await writeFixture();
  const before = fixture();
  const updated = await updateMarketplaceAuthPolicy({ marketplace: file, plugin: "imvia-studio", authentication: "ON_INSTALL" });
  assert.equal(updated.plugins[1].policy.authentication, "ON_INSTALL");
  updated.plugins[1].policy.authentication = before.plugins[1].policy.authentication;
  assert.deepEqual(updated.plugins, before.plugins);
  assert.equal((JSON.parse(await readFile(file, "utf8"))).plugins[1].policy.authentication, "ON_INSTALL");
});

test("rejects wrong marketplace names, duplicates, non-local sources, and unsupported policies", async () => {
  const wrongName = await writeFixture({ ...fixture(), name: "not-personal" });
  await assert.rejects(updateMarketplaceAuthPolicy({ marketplace: wrongName, plugin: "imvia-studio", authentication: "ON_INSTALL" }), (error) => error.code === "MARKETPLACE_NAME_MISMATCH");
  const duplicate = await writeFixture({ ...fixture(), plugins: [...fixture().plugins, fixture().plugins[1]] });
  await assert.rejects(updateMarketplaceAuthPolicy({ marketplace: duplicate, plugin: "imvia-studio", authentication: "ON_INSTALL" }), (error) => error.code === "PLUGIN_ENTRY_DUPLICATE");
  const remote = await writeFixture({ ...fixture(), plugins: fixture().plugins.map((entry) => entry.name === "imvia-studio" ? { ...entry, source: { source: "remote", url: "https://example.test" } } : entry) });
  await assert.rejects(updateMarketplaceAuthPolicy({ marketplace: remote, plugin: "imvia-studio", authentication: "ON_INSTALL" }), (error) => error.code === "PLUGIN_SOURCE_NOT_LOCAL");
  const unsupported = await writeFixture();
  await assert.rejects(updateMarketplaceAuthPolicy({ marketplace: unsupported, plugin: "imvia-studio", authentication: "ON_LOGIN" }), (error) => error.code === "MARKETPLACE_ARGUMENT_INVALID");
});
