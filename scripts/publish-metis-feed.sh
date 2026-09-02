#!/usr/bin/env bash
# Mirror an AskToto-Mantu GitHub Release onto public mysticalsin/Metis-Releases (auto-update feed).
# Usage: bash scripts/publish-metis-feed.sh [v1.8.4]
# Auth: gh must be able to write mysticalsin/Metis-Releases (owner login, or GH_TOKEN / METIS_RELEASES_TOKEN).
set -euo pipefail
TAG="${1:-v1.8.4}"
VERSION="${TAG#v}"
SRC="${GITHUB_REPOSITORY:-mysticalsin/AskToto-Mantu}"
DST="mysticalsin/Metis-Releases"

if [ -n "${METIS_RELEASES_TOKEN:-}" ]; then
  export GH_TOKEN="$METIS_RELEASES_TOKEN"
elif [ -n "${GH_TOKEN:-}" ]; then
  :
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
echo "Downloading $TAG from $SRC …"
gh release download "$TAG" --repo "$SRC" -D "$tmpdir" --clobber
cd "$tmpdir"

required=(
  "Metis-Setup-${VERSION}.exe"
  "Metis-Setup-${VERSION}.exe.blockmap"
  "Metis-Portable-${VERSION}.exe"
  "latest.yml"
  "Metis-${VERSION}.dmg"
  "Metis-${VERSION}.dmg.blockmap"
  "Metis-${VERSION}.zip"
  "Metis-${VERSION}.zip.blockmap"
  "latest-mac.yml"
)
for f in "${required[@]}"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done

notes="Métis ${VERSION} — mirrored from ${SRC}@${TAG} for the public auto-update feed."
if gh release view "$TAG" --repo "$DST" >/dev/null 2>&1; then
  gh release upload "$TAG" --repo "$DST" --clobber "${required[@]}"
  gh release edit "$TAG" --repo "$DST" --draft=false --latest --title "Métis ${VERSION}" --notes "$notes"
else
  gh release create "$TAG" --repo "$DST" --title "Métis ${VERSION}" --notes "$notes" "${required[@]}"
fi

echo "OK https://github.com/${DST}/releases/tag/${TAG}"
curl -fsSL "https://github.com/${DST}/releases/latest/download/latest.yml" | head -20
