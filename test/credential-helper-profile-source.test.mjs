import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("Rust helper imports its protocol version and uses replace-existing on Windows", async () => {
  const [main, local, cargo] = await Promise.all([
    read("native/credential-helper/src/main.rs"),
    read("native/credential-helper/src/store/local.rs"),
    read("native/credential-helper/Cargo.toml"),
  ]);
  assert.match(main, /VerdictMessage, PROTOCOL_VERSION/);
  assert.match(local, /MoveFileExW/);
  assert.match(local, /MOVEFILE_REPLACE_EXISTING\s*\|\s*MOVEFILE_WRITE_THROUGH/);
  assert.doesNotMatch(local, /#\[cfg\(windows\)\]\s*\{\s*let _ = remove_file\(&path\)/s);
  assert.match(local, /if result\.is_err\(\) \{ let _ = remove_file\(&temporary\); \}/);
  assert.match(cargo, /"Win32_Storage_FileSystem"/);
});

test("Swift helper creates a 0600 same-directory temp before atomic rename", async () => {
  const source = await read("native/credential-helper-swift/main.swift");
  const directoryMode = source.indexOf("NSNumber(value: 0o700)");
  const createPrivateTemp = source.indexOf("Darwin.open(temporary.path");
  const tempMode = source.indexOf("S_IRUSR | S_IWUSR", createPrivateTemp);
  const replace = source.indexOf("Darwin.rename", tempMode);
  assert.ok(directoryMode !== -1 && directoryMode < createPrivateTemp);
  assert.ok(createPrivateTemp !== -1 && createPrivateTemp < tempMode && tempMode < replace);
  assert.doesNotMatch(source, /data\.write\(to: url, options: \.atomic\)/);
});
