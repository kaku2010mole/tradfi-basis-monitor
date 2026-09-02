#!/bin/zsh

set -eu

source_root="/Users/posley3302_15/Documents/Codex/2026-07-30/ban"
source_relay="$source_root/services/futu-pusher"
runtime_dir="/Users/posley3302_15/Library/Application Support/TradFiFutuRelay"
service="gui/$(/usr/bin/id -u)/capital.posley.tradfi-futu-pusher"

if [[ ! -x "$runtime_dir/.venv/bin/python" ]]; then
  echo "Futu Relay is not installed yet. Running the full installer."
  exec "$source_relay/Install Futu Relay.command"
fi

/bin/cp "$source_relay/push.py" "$runtime_dir/push.py"
/bin/cp "$source_relay/run-macos.sh" "$runtime_dir/run-macos.sh"
/bin/chmod 700 "$runtime_dir/run-macos.sh"
/bin/rm -f /tmp/tradfi-futu-pusher.pid
/bin/launchctl kickstart -k "$service"

echo
echo "Futu symbols updated. Equities, HK.800000 and HK.HSImain are now subscribed."
echo "You can close this window."
