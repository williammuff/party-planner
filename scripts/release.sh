#!/bin/bash
# Publishes a new version that every installed copy picks up through its self-updater.
#   ./scripts/release.sh [patch|minor|major] ["What changed"] [--full]
# Each release uploads only the small code update (+ checksum + manifest). The full app (~125 MB,
# Electron included) lives on the permanent "installer" pre-release and is re-uploaded only when
# the Electron version changes, the installer is missing, or you pass --full (e.g. to give new
# installs a newer starting version). Then reinstalls your own /Applications copy.
# Needs `gh auth login` and a clean git tree.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
BUMP="patch"; NOTES=""; FORCE_FULL=0
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --full) FORCE_FULL=1 ;;
    *) NOTES="$arg" ;;
  esac
done
REPO_FULL="Party-Planner-mac-arm64.zip"
CODE="Party-Planner-update.zip"
MANIFEST="Party-Planner-update.json"
cd "$PROJECT"

command -v gh >/dev/null || { echo "GitHub CLI missing: brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth status >/dev/null 2>&1 || { echo "Not logged in to GitHub: run gh auth login" >&2; exit 1; }
REPO="$(node -p "require('./package.json').updateRepo || ''")"
[ -n "$REPO" ] || { echo "package.json has no updateRepo" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first (git status is not clean)." >&2; exit 1; }

npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
ELECTRON="$(cat node_modules/electron/dist/version)"
echo "Releasing $VERSION (Electron $ELECTRON)…"

"$PROJECT/scripts/package.sh" >/dev/null
( cd dist && shasum -a 256 "$CODE" > "$CODE.sha256" )

git add package.json package-lock.json
git commit -m "Release v$VERSION" ${RELEASE_TRAILER:+-m "$RELEASE_TRAILER"} >/dev/null   # RELEASE_TRAILER: optional extra commit line
git tag "v$VERSION"
git push --quiet
git push --quiet origin "v$VERSION"

echo "Uploading the code update ($(du -h "dist/$CODE" | cut -f1))…"
gh release create "v$VERSION" "dist/$CODE" "dist/$CODE.sha256" "dist/$MANIFEST" \
  --title "Party Planner $VERSION" --latest \
  --notes "${NOTES:-Party Planner $VERSION}" >/dev/null
echo "Published v$VERSION: $(gh release view "v$VERSION" --json url -q .url)"

# Full app for new installs (and Electron upgrades): only when it actually changed.
INSTALLER_ELECTRON="$(gh release download installer -p "$MANIFEST" -O - 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).electron)}catch{console.log('')}})")"
if [ "$FORCE_FULL" = 1 ] || [ "$INSTALLER_ELECTRON" != "$ELECTRON" ]; then
  echo "Refreshing the full installer ($(du -h "dist/Party Planner.zip" | cut -f1), takes a few minutes)…"
  cp "dist/Party Planner.zip" "dist/$REPO_FULL"
  ( cd dist && shasum -a 256 "$REPO_FULL" > "$REPO_FULL.sha256" )
  gh release delete installer --cleanup-tag --yes >/dev/null 2>&1 || true
  git push --quiet origin ":refs/tags/installer" 2>/dev/null || true
  gh release create installer "dist/$REPO_FULL" "dist/$REPO_FULL.sha256" "dist/$MANIFEST" \
    --prerelease --target "$(git rev-parse HEAD)" \
    --title "Party Planner installer (full app)" \
    --notes "Full Party Planner app for a first install on an Apple Silicon Mac: download $REPO_FULL, unzip, drag Party Planner.app into Applications, then right-click > Open the first time. It updates itself to the newest version from then on." >/dev/null
  echo "Installer: https://github.com/$REPO/releases/download/installer/$REPO_FULL"
else
  echo "Full installer unchanged (Electron $ELECTRON)."
fi

"$PROJECT/scripts/install.sh"
