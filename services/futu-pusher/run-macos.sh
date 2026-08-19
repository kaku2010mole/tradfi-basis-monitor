#!/bin/zsh

set -u

relay_root="/Users/posley3302_15/Documents/Codex/2026-07-30/ban"
opend_binary="/Applications/Futu_OpenD.app/Contents/MacOS/Futu_OpenD"
pid_file="/tmp/tradfi-futu-pusher.pid"

if [[ -r "$pid_file" ]]; then
  existing_pid="$(<"$pid_file")"
  if [[ "$existing_pid" == <-> ]] && /bin/kill -0 "$existing_pid" >/dev/null 2>&1; then
    exit 0
  fi
fi
print -r -- "$$" >"$pid_file"
cleanup() { /bin/rm -f "$pid_file"; }

# This OpenD distribution is not registered correctly with LaunchServices, so
# launch its executable directly only when the local API port is not listening.
if ! /usr/bin/nc -z 127.0.0.1 11111 >/dev/null 2>&1 && [[ -x "$opend_binary" ]]; then
  nohup "$opend_binary" >/tmp/futu-opend.out.log 2>/tmp/futu-opend.err.log </dev/null &
fi

# -s keeps the Mac awake while connected to AC power. The display may still
# sleep normally, which is exactly what an overnight market-data relay needs.
# The outer loop also recovers from an unexpected Python process exit.
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT
while true; do
  /usr/bin/caffeinate -s \
    "$relay_root/services/futu-pusher/.venv/bin/python" -u \
    "$relay_root/services/futu-pusher/push.py"
  /bin/sleep 5
done
