#!/bin/bash
# Publishes a new version that every installed copy picks up through its self-updater.
#   ./scripts/release.sh [patch|minor|major] ["What changed"]
# Bumps the version, builds the app zip + checksum, commits, tags, pushes, creates the GitHub
# Release, then reinstalls your own /Applications copy. Needs `gh auth login` and a clean git tree.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
BUMP="${1:-patch}"
NOTES="${2:-}"
ASSET="Party-Planner-mac-arm64.zip"
cd "$PROJECT"

command -v gh >/dev/null || { echo "GitHub CLI missing: brew install gh" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not logged in to GitHub: run gh auth login" >&2; exit 1; }
[ -n "$(node -p "require('./package.json').updateRepo || ''")" ] || { echo "package.json has no updateRepo" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first (git status is not clean)." >&2; exit 1; }
case "$BUMP" in patch|minor|major) ;; *) echo "First argument must be patch, minor or major" >&2; exit 1 ;; esac

npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
echo "Releasing $VERSION…"

"$PROJECT/scripts/package.sh" >/dev/null
cp "dist/Party Planner.zip" "dist/$ASSET"
( cd dist && shasum -a 256 "$ASSET" > "$ASSET.sha256" )

git add package.json package-lock.json
git commit -m "Release v$VERSION" ${RELEASE_TRAILER:+-m "$RELEASE_TRAILER"} >/dev/null   # RELEASE_TRAILER: optional extra commit line
git tag "v$VERSION"
git push --quiet
git push --quiet origin "v$VERSION"

gh release create "v$VERSION" "dist/$ASSET" "dist/$ASSET.sha256" \
  --title "Party Planner $VERSION" \
  --notes "${NOTES:-Party Planner $VERSION}" >/dev/null
echo "Published v$VERSION: $(gh release view "v$VERSION" --json url -q .url)"

"$PROJECT/scripts/install.sh"
