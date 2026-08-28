# IMVIA Studio repository instructions

- After any code, workbench asset, skill, manifest, or packaging change intended for the installed IMVIA Studio plugin, do not stop after editing the workspace.
- Before handing the change back, automatically run the relevant tests, refresh the Codex cachebuster with the plugin-creator helper, validate the plugin, reinstall `imvia-studio@personal`, and verify that the new installed cache contains the updated version and changed files. Do not wait for the user to remind you.
- Treat a new Codex task as the safe boundary for loading the reinstalled plugin's skills and MCP tools. Never present a workbench served by the current task's older MCP process as proof that the new package loaded.
- Keep the independent Lovart plugin and `/Users/a1234/Documents/ChatGPT/lovart插件` untouched unless the user explicitly requests work in that separate repository.
