#!/bin/bash
# Builds a self-contained "Party Planner.app" to share (Apple Silicon Macs) and zips it with a
# short read-me: dist/Party Planner.zip. Nothing personal goes in: no recipes, crate backups,
# logs or iTunes snapshots from this machine. Only the Billboard history is included as a seed.
# Options (used by scripts/install.sh): --out DIR (where to build), --data-dir DIR (bake in a data
# folder via config.json), --no-zip.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$PROJECT/node_modules/electron/dist/Electron.app"
DIST="$PROJECT/dist"
DATA_DIR=""
ZIP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --out) DIST="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --no-zip) ZIP=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
STAGE="$DIST/Party Planner"
APP="$STAGE/Party Planner.app"
RES="$APP/Contents/Resources"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -d "$SRC" ] || { echo "Electron not installed at $SRC" >&2; exit 1; }
VERSION="$(node -p "require('$PROJECT/package.json').version")"

rm -rf "$STAGE" "$DIST/Party Planner.zip"   # only what this script makes, never the whole --out folder
mkdir -p "$STAGE"
ditto "$SRC" "$APP"

# Name, id, version, icon
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Party Planner" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Party Planner" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Party Planner" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.partyplanner.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST"
mkdir -p "$WORK/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$PROJECT/electron/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$PROJECT/electron/icon.png" --out "$WORK/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/icon.iconset" -o "$RES/electron.icns"

# App code (Electron loads Resources/app ahead of its default app)
APPDIR="$RES/app"
mkdir -p "$APPDIR/electron" "$APPDIR/seed"
cp -R "$PROJECT/lib" "$PROJECT/public" "$PROJECT/server.js" "$APPDIR/"
cp "$PROJECT/electron/main.js" "$PROJECT/electron/updater.js" "$PROJECT/electron/preload.cjs" "$PROJECT/electron/icon.png" "$PROJECT/electron/drag.png" "$APPDIR/electron/"
node -e "
const p = require('$PROJECT/package.json');
const out = { name: p.name, productName: 'Party Planner', version: p.version, private: true, type: 'module', main: 'electron/main.js', updateRepo: p.updateRepo || null };
require('fs').writeFileSync('$APPDIR/package.json', JSON.stringify(out, null, 2) + '\n');
"
if [ -n "$DATA_DIR" ]; then
  node -e "require('fs').writeFileSync('$APPDIR/config.json', JSON.stringify({ dataDir: process.argv[1] }, null, 2) + '\n')" "$DATA_DIR"
elif [ -f "$PROJECT/data/charts/hot-100.csv" ]; then
  cp "$PROJECT/data/charts/hot-100.csv" "$APPDIR/seed/"
fi

# Modifying Electron's bundle breaks its signature; re-sign locally (ad hoc).
codesign --force --deep --sign - "$APP"
codesign --verify --deep "$APP"

if [ "$ZIP" = 0 ]; then echo "Built: $APP"; exit 0; fi

cat > "$STAGE/Read me.txt" <<'TXT'
Party Planner: plans DJ sets from your Serato library, and suggests what to play next while you DJ.

INSTALL (Apple Silicon Mac)
1. Drag "Party Planner.app" into your Applications folder.
2. The first time: RIGHT-CLICK the app > Open > Open.
   (It isn't from the App Store, so a normal double-click is blocked the first time only.
    If macOS says it "can't be opened", go to System Settings > Privacy & Security,
    scroll down and click "Open Anyway".)
3. If asked whether Party Planner can access your Music folder, click Allow. That's where
   Serato keeps its library. Party Planner only reads it, apart from new crates you choose to save.

USING IT
- Set builder: describe the party ("house vibe w/ hip hop 90's 2000's, crowd pleasers"),
  then tweak each pillar and save it as a crate (it shows up in Serato under "Party Planner"
  after you restart Serato).
- What to play next: follows the tracks you load in Serato and suggests what fits next
  (BPM + popular tracks). Drag any track straight onto a Serato deck or crate.
- First launch takes a few seconds while it reads your library.
TXT

ditto -c -k --keepParent "$STAGE" "$DIST/Party Planner.zip"
echo "Built: $DIST/Party Planner.zip ($(du -h "$DIST/Party Planner.zip" | cut -f1))"

# Code-only update: just the app's own files (no Electron runtime, no seed data), plus a manifest
# saying which Electron it needs. Installed copies on that Electron swap only these files.
ELECTRON_VERSION="$(cat "$PROJECT/node_modules/electron/dist/version")"
UPD="$WORK/update"
mkdir -p "$UPD"
( cd "$APPDIR" && cp -R package.json server.js lib public electron "$UPD/" )
( cd "$UPD" && ditto -c -k . "$DIST/Party-Planner-update.zip" )
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({ version: process.argv[2], electron: process.argv[3] }, null, 2) + '\\n')" \
  "$DIST/Party-Planner-update.json" "$VERSION" "$ELECTRON_VERSION"
echo "Built: $DIST/Party-Planner-update.zip ($(du -h "$DIST/Party-Planner-update.zip" | cut -f1), Electron $ELECTRON_VERSION)"
