import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("native setup owns secure fields and a private local file store", async () => {
  const source = await readFile(path.join(root, "native/credential-helper/src/store.rs"), "utf8");
  const macosStore = await readFile(path.join(root, "native/credential-helper/src/store/macos.rs"), "utf8");
  const ui = await readFile(path.join(root, "native/credential-helper/src/ui/macos.rs"), "utf8");
  assert.match(source, /private local file/i);
  assert.match(macosStore, /LocalCredentialStore/);
  assert.doesNotMatch(macosStore, /security_framework|generic_password|PasswordOptions/);
  assert.match(ui, /NSSecureTextField|secure/i);
  assert.match(macosStore, /local-file based/i);
  assert.match(ui, /NSSecureTextField::new/);
  assert.match(ui, /access\.setEditable\(true\)/);
  assert.match(ui, /access\.setSelectable\(true\)/);
  assert.match(ui, /secret\.setEditable\(true\)/);
  assert.match(ui, /secret\.setSelectable\(true\)/);
  assert.match(ui, /setSendsActionOnEndEditing\(false\)/);
  assert.match(ui, /NSButton::buttonWithTitle_target_action/);
  assert.match(ui, /NSPasteboard::generalPasteboard/);
  assert.match(ui, /NSPasteboardTypeString/);
  assert.match(ui, /PasteController/);
  assert.match(ui, /Some\(sel!\(pasteAccess:\)\)/);
  assert.match(ui, /Some\(sel!\(pasteSecret:\)\)/);
  assert.doesNotMatch(ui, /Some\(sel!\(paste:\)\)/);
  assert.match(ui, /粘贴/);
  assert.match(ui, /NSAlertFirstButtonReturn/);
  assert.match(ui, /loop \{/);
  assert.match(ui, /请填写完整的 Access Key 和 Secret Key/);
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
