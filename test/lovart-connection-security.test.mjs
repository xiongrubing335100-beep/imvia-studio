import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("native setup owns secure fields and local-only Keychain attributes", async () => {
  const source = await readFile(path.join(root, "native/credential-helper/src/store.rs"), "utf8");
  const macosStore = await readFile(path.join(root, "native/credential-helper/src/store/macos.rs"), "utf8");
  const ui = await readFile(path.join(root, "native/credential-helper/src/ui/macos.rs"), "utf8");
  assert.match(source, /ai\.imvia\.studio\.lovart/);
  assert.match(source, /credentials/);
  assert.match(ui, /NSSecureTextField|secure/i);
  assert.match(macosStore, /PasswordOptions::new_generic_password/);
  assert.match(macosStore, /let bytes = generic_password\(options\)/);
  assert.match(ui, /NSSecureTextField::new/);
  assert.match(ui, /NSAlertFirstButtonReturn/);
  assert.equal(ui.includes("response.0"), false);
  assert.equal(source.includes("existing Lovart plugin"), false);
});

test("runtime does not reference the protected Lovart worktree", async () => {
  for (const relative of ["src/index.js", "src/lovart/credentials.js", "src/lovart/client.js", "src/lovart/generation-service.js"]) {
    const source = await readFile(path.join(root, relative), "utf8");
    assert.equal(/lovart-codex-plugin|lovart插件|\.worktrees\/lovart-local/i.test(source), false, relative);
  }
});

test("Lovart client rejects redirects and fixes the production origin", async () => {
  const source = await readFile(path.join(root, "src/lovart/client.js"), "utf8");
  assert.match(source, /https:\/\/lgw\.lovart\.ai/);
  assert.match(source, /redirect:\s*["']error["']/);
  assert.match(source, /X-Signature/);
});
