import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repairScript = path.join(pluginRoot, "scripts", "ensure-runtime-dependencies.mjs");

async function createPnpmPackage(root, storeName, packageName, metadata) {
  const packageRoot = path.join(root, "node_modules", ".pnpm", storeName, "node_modules", packageName);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0", ...metadata }));
}

test("repairs missing direct and transitive pnpm links idempotently", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "imvia-start-mcp-links-"));
  try {
    await mkdir(path.join(temporaryRoot, "node_modules", ".pnpm"), { recursive: true });
    await writeFile(path.join(temporaryRoot, "package.json"), JSON.stringify({
      dependencies: { "@example/root": "1.0.0", zod: "1.0.0" },
    }));
    await createPnpmPackage(temporaryRoot, "@example+root@1.0.0", "@example/root", {
      dependencies: { transitive: "1.0.0" },
    });
    await createPnpmPackage(temporaryRoot, "transitive@1.0.0", "transitive", {});
    await createPnpmPackage(temporaryRoot, "zod@1.0.0", "zod", {});

    const env = { ...process.env, IMVIA_PLUGIN_ROOT: temporaryRoot };
    await execFileAsync(process.execPath, [repairScript], { env });
    await execFileAsync(process.execPath, [repairScript], { env });

    assert.equal(
      await readlink(path.join(temporaryRoot, "node_modules", "@example", "root")),
      path.join("..", ".pnpm", "@example+root@1.0.0", "node_modules", "@example", "root"),
    );
    assert.equal(
      await readlink(path.join(temporaryRoot, "node_modules", "zod")),
      path.join(".pnpm", "zod@1.0.0", "node_modules", "zod"),
    );
    assert.equal(
      await readlink(path.join(temporaryRoot, "node_modules", ".pnpm", "@example+root@1.0.0", "node_modules", "transitive")),
      path.join("..", "..", "transitive@1.0.0", "node_modules", "transitive"),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("plugin entry remains importable after the installer omits symlinks", async () => {
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), "imvia-installed-plugin-"));
  try {
    await cp(path.join(pluginRoot, "package.json"), path.join(installedRoot, "package.json"));
    await cp(path.join(pluginRoot, "src"), path.join(installedRoot, "src"), { recursive: true });
    await cp(path.join(pluginRoot, "node_modules"), path.join(installedRoot, "node_modules"), {
      recursive: true,
      filter: async (source) => !(await lstat(source)).isSymbolicLink(),
    });

    const entryUrl = pathToFileURL(path.join(installedRoot, "src", "index.js")).href;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(entryUrl)})`]);
  } finally {
    await rm(installedRoot, { recursive: true, force: true });
  }
});
