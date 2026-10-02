#!/bin/zsh

set -eu

source_relay="$(cd -- "$(dirname -- "$0")" && pwd)"
runtime_dir="/Users/posley3302_15/Library/Application Support/TradFiFutuRelay"
service="gui/$(/usr/bin/id -u)/capital.posley.tradfi-futu-pusher"

if [[ ! -x "$runtime_dir/.venv/bin/python" ]]; then
  echo "Futu Relay is not installed yet. Running the full installer."
  exec "$source_relay/Install Futu Relay.command"
fi

/bin/cp "$source_relay/push.py" "$runtime_dir/push.py"
/bin/cp "$source_relay/posley-adr-pusher.mjs" "$runtime_dir/posley-adr-pusher.mjs"
/bin/cp "$source_relay/run-macos.sh" "$runtime_dir/run-macos.sh"
/bin/chmod 700 "$runtime_dir/run-macos.sh"
/bin/rm -f /tmp/tradfi-futu-pusher.pid
/bin/launchctl kickstart -k "$service"

echo
echo "Market-data relay updated. Futu, Korean and Japanese stocks, and FX streams are now subscribed."
echo "You can close this window."
