#!/bin/bash
# Builds the current code into /Applications/Party Planner.app (your own copy, sharing this
# project's data/ folder for recipes, crate backups and charts) and restarts it if it was running.
# Run after every change.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="/Applications/Party Planner.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Smoke test first: the new code must boot and answer, or nothing gets installed.
TEST_PORT=4397
( cd "$PROJECT" && PORT=$TEST_PORT PP_DATA_DIR="$WORK/testdata" ELECTRON_RUN_AS_NODE=1 \
    "$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" server.js > "$WORK/smoke.log" 2>&1 ) &
SMOKE_PID=$!
ok=0
for _ in $(seq 1 60); do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TEST_PORT/api/status" | grep -q 200; then ok=1; break; fi
  kill -0 $SMOKE_PID 2>/dev/null || break
  sleep 0.5
done
kill $SMOKE_PID 2>/dev/null || true
lsof -nP -iTCP:$TEST_PORT -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
if [ "$ok" != 1 ]; then
  echo "Not installed: the new build failed its startup check." >&2
  tail -20 "$WORK/smoke.log" >&2
  exit 1
fi

"$PROJECT/scripts/package.sh" --out "$WORK" --data-dir "$PROJECT/data" --no-zip >/dev/null

# Quit any running copy (installed app or the go.sh dev copy) so the new code loads.
was_running=0
for pattern in "[P]arty Planner.app/Contents/MacOS/Electron" "[n]ode_modules/electron/dist/Electron.app/Contents/MacOS/Electron $PROJECT"; do
  if pgrep -f "$pattern" >/dev/null; then was_running=1; pkill -f "$pattern" || true; fi
done
for _ in $(seq 1 20); do
  pgrep -f "[P]arty Planner.app/Contents/MacOS/Electron" >/dev/null || pgrep -f "[n]ode_modules/electron/dist/Electron.app/Contents/MacOS/Electron $PROJECT" >/dev/null || break
  sleep 0.5
done

rm -rf "$TARGET"
ditto "$WORK/Party Planner/Party Planner.app" "$TARGET"
echo "Installed $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET/Contents/Info.plist") to $TARGET"

if [ "$was_running" = 1 ]; then
  unset ELECTRON_RUN_AS_NODE
  nohup "$TARGET/Contents/MacOS/Electron" > "$PROJECT/data/app.log" 2>&1 &
  echo "Restarted Party Planner."
fi
