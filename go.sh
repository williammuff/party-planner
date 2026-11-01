#!/bin/bash
# Launches the Party Planner desktop app. You can close this Terminal window afterwards.
cd "$(dirname "$0")"
unset ELECTRON_RUN_AS_NODE   # set by VS Code's terminal; makes Electron act like plain Node
if pgrep -f "[n]ode_modules/electron/dist/Electron.app/Contents/MacOS/Electron $PWD" >/dev/null; then
  echo "Party Planner is already running."
  osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is '"$(pgrep -f "[n]ode_modules/electron/dist/Electron.app/Contents/MacOS/Electron $PWD" | head -1)"') to true' >/dev/null 2>&1
  exit 0
fi
nohup ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron "$PWD" > data/app.log 2>&1 &
echo "Party Planner is starting (reading your Serato library takes a few seconds)…"
