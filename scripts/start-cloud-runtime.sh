#!/usr/bin/env bash
set -euo pipefail
cd /vercel/emis
if [[ -f /tmp/emis-oidc.token ]]; then chmod 600 /tmp/emis-oidc.token; fi
exec 9>/tmp/emis-runtime-start.lock
flock 9
if [[ -f /tmp/emis-server.pid ]]; then
  runtime_pid=$(cat /tmp/emis-server.pid)
  if [[ "$runtime_pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/$runtime_pid/cmdline" ]] && tr '\0' ' ' < "/proc/$runtime_pid/cmdline" | grep -q 'scripts/cloud-runtime.js'; then
    exit 0
  fi
fi
mkdir -p /data/emis/ministry-browser
chmod 700 /data/emis /data/emis/ministry-browser
# A resumed VM has no previous Chromium process; its saved singleton files are stale.
rm -f /data/emis/ministry-browser/SingletonLock /data/emis/ministry-browser/SingletonCookie /data/emis/ministry-browser/SingletonSocket
if ! pgrep -x Xvfb >/dev/null; then
  rm -f /tmp/.X90-lock
  Xvfb :90 -screen 0 1280x900x24 -nolisten tcp >/tmp/emis-display.log 2>&1 9>&- &
fi
DISPLAY=:90 nohup node scripts/cloud-runtime.js >/tmp/emis-runtime.log 2>&1 < /dev/null 9>&- &
