#!/bin/sh
set -eu

# macOS VPN clients commonly expose a local HTTP(S) proxy through the
# system proxy settings. Node's fetch does not read those settings by
# itself, so pass the proxy to Node before it starts.
if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v scutil >/dev/null 2>&1; then
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

exec node "$(dirname "$0")/../src/index.js" "$@"
