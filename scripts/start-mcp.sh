#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

resolve_node_binary() {
  if [ -n "${IMVIA_NODE_BINARY:-}" ] && [ -x "$IMVIA_NODE_BINARY" ]; then
    printf '%s\n' "$IMVIA_NODE_BINARY"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  user_home_dir="${HOME:-}"
  for candidate in \
    "$user_home_dir"/.cache/codex-runtimes/*/dependencies/node/bin/node \
    "$user_home_dir"/.codex/runtimes/*/dependencies/node/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

node_binary=$(resolve_node_binary) || {
  echo "IMVIA Studio requires Node.js. Set IMVIA_NODE_BINARY or install Node.js." >&2
  exit 127
}

# Some plugin installers preserve pnpm's content store but omit the direct
# dependency links that Node's ESM resolver requires. Repair those links before
# loading the MCP so a fresh Codex process cannot fail at startup.
"$node_binary" "$script_directory/ensure-runtime-dependencies.mjs" 1>&2

proxy_mode="${IMVIA_PROXY_MODE:-auto}"

case "$proxy_mode" in
  direct)
    unset NODE_USE_ENV_PROXY HTTPS_PROXY HTTP_PROXY ALL_PROXY
    ;;
  env)
    export NODE_USE_ENV_PROXY=1
    ;;
  auto|system)
    if [ "$proxy_mode" = "auto" ] && { [ -n "${HTTPS_PROXY:-}" ] || [ -n "${HTTP_PROXY:-}" ] || [ -n "${ALL_PROXY:-}" ]; }; then
      export NODE_USE_ENV_PROXY=1
    elif [ "$proxy_mode" = "system" ] || [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
      proxy_url="$("$node_binary" "$script_directory/detect-system-proxy.mjs" 2>/dev/null || true)"
      if [ -n "${proxy_url:-}" ]; then
        export NODE_USE_ENV_PROXY=1
        export HTTPS_PROXY="${HTTPS_PROXY:-$proxy_url}"
        export HTTP_PROXY="${HTTP_PROXY:-$proxy_url}"
        export ALL_PROXY="${ALL_PROXY:-$proxy_url}"
      fi
    fi
    ;;
  *)
    echo "IMVIA_PROXY_MODE must be auto, direct, env, or system." >&2
    exit 64
    ;;
esac

exec "$node_binary" "$script_directory/../src/index.js" "$@"
