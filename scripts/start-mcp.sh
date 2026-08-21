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
    elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v scutil >/dev/null 2>&1; then
      proxy_host="$(/usr/sbin/scutil --proxy 2>/dev/null | awk '/^  HTTPSProxy :/{print $3; exit}')"
      proxy_port="$(/usr/sbin/scutil --proxy 2>/dev/null | awk '/^  HTTPSPort :/{print $3; exit}')"
      https_enabled="$(/usr/sbin/scutil --proxy 2>/dev/null | awk '/^  HTTPSEnable :/{print $3; exit}')"
      if [ "${https_enabled:-0}" = "1" ] && [ -n "${proxy_host:-}" ] && [ -n "${proxy_port:-}" ]; then
        proxy_url="http://${proxy_host}:${proxy_port}"
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
