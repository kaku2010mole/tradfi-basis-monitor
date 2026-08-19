#!/bin/zsh

set -eu

source_plist="/Users/posley3302_15/Documents/Codex/2026-07-30/ban/services/futu-pusher/capital.posley.tradfi-futu-pusher.plist"
target_dir="/Users/posley3302_15/Library/LaunchAgents"
target_plist="$target_dir/capital.posley.tradfi-futu-pusher.plist"
service="gui/$(/usr/bin/id -u)/capital.posley.tradfi-futu-pusher"

/bin/mkdir -p "$target_dir"
/bin/cp "$source_plist" "$target_plist"
/bin/chmod 644 "$target_plist"
/bin/launchctl bootout "$service" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$target_plist"
/bin/launchctl kickstart -k "$service"

echo
echo "Futu Relay is installed and running. The display may sleep; the Mac will stay awake on AC power."
echo "You can close this window."
