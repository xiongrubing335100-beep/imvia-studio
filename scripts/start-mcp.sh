#!/bin/sh
set -eu

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
    elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
      proxy_url="$(node "$(dirname "$0")/detect-system-proxy.mjs" 2>/dev/null || true)"
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

exec node "$(dirname "$0")/../src/index.js" "$@"
