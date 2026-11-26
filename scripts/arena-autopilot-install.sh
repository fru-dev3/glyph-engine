#!/usr/bin/env bash
# Install (or remove) the daily Glyph Arena autopilot as a launchd job.
#   scripts/arena-autopilot-install.sh [--at HH:MM] [--bin /path/to/arena-engine] [--vault /path]
#   scripts/arena-autopilot-install.sh --uninstall
# The job runs `arena-engine autopilot tick` once a day (default 06:00). The vault is
# found the usual way (config file) unless --vault is given. Autopilot only does work
# when it is switched on: `arena-engine autopilot set --on true`.
set -euo pipefail
LABEL="dev.glyph.arena-autopilot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AT="06:00"; BIN="${ARENA_ENGINE_BIN:-}"; VAULT=""; UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --at) AT="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    --vault) VAULT="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [ "$UNINSTALL" = 1 ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; echo "removed $LABEL"; exit 0
fi
[[ "$AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "--at must be HH:MM" >&2; exit 2; }
[ -n "$BIN" ] || BIN="$(command -v arena-engine || true)"
[ -n "$BIN" ] && [ -x "$BIN" ] || { echo "arena-engine not found: pass --bin or set ARENA_ENGINE_BIN" >&2; exit 1; }
HOUR=$((10#${AT%%:*})); MIN=$((10#${AT##*:}))
ARGS="<string>$BIN</string><string>autopilot</string><string>tick</string><string>--json</string>"
[ -n "$VAULT" ] && ARGS="$ARGS<string>--vault</string><string>$VAULT</string>"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>$ARGS</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/glyph-arena-autopilot.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/glyph-arena-autopilot.log</string>
</dict></plist>
PL
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL: daily at $AT, running $BIN autopilot tick"
