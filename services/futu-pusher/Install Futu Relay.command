#!/bin/zsh

set -eu

source_root="/Users/posley3302_15/Documents/Codex/2026-07-30/ban"
source_relay="$source_root/services/futu-pusher"
source_plist="$source_relay/capital.posley.tradfi-futu-pusher.plist"
source_token="$source_root/.futu-push-token"
runtime_dir="/Users/posley3302_15/Library/Application Support/TradFiFutuRelay"
target_dir="/Users/posley3302_15/Library/LaunchAgents"
target_plist="$target_dir/capital.posley.tradfi-futu-pusher.plist"
service="gui/$(/usr/bin/id -u)/capital.posley.tradfi-futu-pusher"

if [[ ! -r "$source_token" ]]; then
  echo "Missing Futu push credential: $source_token" >&2
  exit 2
fi

/bin/mkdir -p "$runtime_dir"
/usr/bin/ditto "$source_relay/.venv" "$runtime_dir/.venv"
/bin/cp "$source_relay/push.py" "$runtime_dir/push.py"
/bin/cp "$source_relay/run-macos.sh" "$runtime_dir/run-macos.sh"
/bin/cp "$source_token" "$runtime_dir/.futu-push-token"
/bin/chmod 700 "$runtime_dir/run-macos.sh"
/bin/chmod 600 "$runtime_dir/.futu-push-token"
/bin/mkdir -p "$target_dir"
/bin/cp "$source_plist" "$target_plist"
/bin/chmod 644 "$target_plist"
/bin/launchctl bootout "$service" >/dev/null 2>&1 || true
/bin/rm -f /tmp/tradfi-futu-pusher.pid
/bin/sleep 1
/bin/launchctl enable "$service" >/dev/null 2>&1 || true

loaded=false
for attempt in 1 2 3 4 5; do
  if /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$target_plist"; then
    loaded=true
    break
  fi
  /bin/sleep 1
done

if [[ "$loaded" != true ]]; then
  echo
  echo "macOS did not register the background service. Starting the relay in this Terminal window instead."
  echo "Keep this window open; the display may still sleep normally."
  exec "$runtime_dir/run-macos.sh"
fi

/bin/launchctl kickstart -k "$service"

echo
echo "Futu Relay is installed and running. The display may sleep; the Mac will stay awake on AC power."
echo "You can close this window."
