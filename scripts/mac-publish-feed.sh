#!/usr/bin/env bash
# Build Métis on THIS Mac and publish the auto-update feed to mysticalsin/Metis-Releases.
#
# Run from anywhere:
#   bash /path/to/AskToto-Mantu/scripts/mac-publish-feed.sh
#
# Requirements:
#   - macOS with Xcode CLT
#   - Node 22+
#   - `gh` logged in as an account that can WRITE mysticalsin/Metis-Releases
#       gh auth login
#       gh auth status   # must show mysticalsin (or a collaborator with push)
set -euo pipefail

REPO_SLUG="${REPO_SLUG:-mysticalsin/AskToto-Mantu}"
FEED_SLUG="${FEED_SLUG:-mysticalsin/Metis-Releases}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Repo: $ROOT"
if [ ! -f package.json ] || [ ! -f package-lock.json ]; then
  echo "ERROR: This is not the AskToto-Mantu checkout (missing package.json / package-lock.json)." >&2
  echo "Clone first:" >&2
  echo "  cd ~ && gh repo clone $REPO_SLUG && cd AskToto-Mantu" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
echo "==> package.json version = $VERSION  (tag $TAG)"

echo "==> Checking GitHub auth (must be YOU, not a bot)…"
gh auth status || {
  echo "ERROR: gh is not logged in. Run: gh auth login" >&2
  exit 1
}
LOGIN="$(gh api user --jq .login 2>/dev/null || true)"
echo "    logged in as: ${LOGIN:-unknown}"

echo "==> Checking write access to $FEED_SLUG…"
PERM="$(gh api "repos/${FEED_SLUG}" --jq '.permissions.push' 2>/dev/null || echo false)"
if [ "$PERM" != "true" ]; then
  echo "ERROR: This GitHub account cannot push to $FEED_SLUG (permissions.push=$PERM)." >&2
  echo "Fix one of:" >&2
  echo "  1) gh auth login   # choose the mysticalsin owner account" >&2
  echo "  2) Or create a classic PAT with 'repo' scope, then:" >&2
  echo "       export GH_TOKEN=ghp_…" >&2
  echo "       bash scripts/mac-publish-feed.sh" >&2
  exit 1
fi
echo "    write access: OK"

echo "==> Syncing main…"
git fetch origin main
git checkout main
git pull --ff-only origin main
VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
echo "    now at $(git rev-parse --short HEAD) · version $VERSION"

echo "==> npm ci…"
npm ci

echo "==> Building Mac installers (npm run dist) — this takes several minutes…"
npm run dist

cd release
echo "==> Built artifacts:"
ls -lh "Metis-${VERSION}.dmg" "Metis-${VERSION}.zip" "latest-mac.yml"

# Prefer whatever electron-builder actually wrote (.blockmap is the usual name).
pick_map() {
  local base="$1"
  if [ -f "${base}.blockmap" ]; then echo "${base}.blockmap"
  elif [ -f "${base}.blockmap" ]; then echo "${base}.blockmap"
  else echo "${base}.blockmap"
  fi
}
DMG_MAP="$(pick_map "Metis-${VERSION}.dmg")"
ZIP_MAP="$(pick_map "Metis-${VERSION}.zip")"
for f in "Metis-${VERSION}.dmg" "$DMG_MAP" "Metis-${VERSION}.zip" "$ZIP_MAP" latest-mac.yml; do
  [ -f "$f" ] || { echo "ERROR: missing $f in release/" >&2; ls -la >&2; exit 1; }
done

NOTES="Métis ${VERSION} (unsigned / ad-hoc)

- Restart & install actually applies updates on the tray overlay (MQA-272)
- Settings no longer opens squeezed at mini-pill width (MQA-271)
"

echo "==> Publishing $TAG to $FEED_SLUG…"
if gh release view "$TAG" --repo "$FEED_SLUG" >/dev/null 2>&1; then
  echo "    release exists — uploading/clobbering assets"
  gh release upload "$TAG" --repo "$FEED_SLUG" --clobber \
    "Metis-${VERSION}.dmg" "$DMG_MAP" "Metis-${VERSION}.zip" "$ZIP_MAP" latest-mac.yml
  gh release edit "$TAG" --repo "$FEED_SLUG" --draft=false --latest \
    --title "Métis ${VERSION} (unsigned / ad-hoc)" \
    --notes "$NOTES"
else
  gh release create "$TAG" --repo "$FEED_SLUG" \
    --title "Métis ${VERSION} (unsigned / ad-hoc)" \
    --notes "$NOTES" \
    "Metis-${VERSION}.dmg" "$DMG_MAP" "Metis-${VERSION}.zip" "$ZIP_MAP" latest-mac.yml
fi

echo "==> Verifying public feed…"
curl -fsSL "https://github.com/${FEED_SLUG}/releases/latest/download/latest-mac.yml" | head -5
echo
echo "OK — users can update once Metis sees version $VERSION on the feed."
echo "    https://github.com/${FEED_SLUG}/releases/tag/${TAG}"
