#!/usr/bin/env bash
# Mirror an AskToto-Mantu GitHub Release onto public mysticalsin/Metis-Releases (auto-update feed).
# Ships BOTH platforms: Windows Setup/Portable EXE (+ latest.yml) and macOS DMG/ZIP (+ latest-mac.yml).
# Usage: bash scripts/publish-metis-feed.sh [v1.8.4]
# Auth: gh must write mysticalsin/Metis-Releases (owner login, or GH_TOKEN / METIS_RELEASES_TOKEN).
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
  [ -f "$f" ] || { echo "missing $f" >&2; ls -la >&2; exit 1; }
done

# Sanity: channel files must advertise this version and name the EXE / DMG+ZIP we are uploading.
grep -q "version: ${VERSION}" latest.yml || { echo "latest.yml version mismatch" >&2; exit 1; }
grep -q "Metis-Setup-${VERSION}.exe" latest.yml || { echo "latest.yml missing Setup EXE" >&2; exit 1; }
grep -q "version: ${VERSION}" latest-mac.yml || { echo "latest-mac.yml version mismatch" >&2; exit 1; }
grep -q "Metis-${VERSION}.dmg" latest-mac.yml || { echo "latest-mac.yml missing DMG" >&2; exit 1; }
grep -q "Metis-${VERSION}.zip" latest-mac.yml || { echo "latest-mac.yml missing ZIP" >&2; exit 1; }

notes="Métis ${VERSION} — Windows Setup/Portable EXE + macOS DMG/ZIP. Mirrored from ${SRC}@${TAG} for the public auto-update feed (latest.yml + latest-mac.yml)."
if gh release view "$TAG" --repo "$DST" >/dev/null 2>&1; then
  gh release upload "$TAG" --repo "$DST" --clobber "${required[@]}"
  gh release edit "$TAG" --repo "$DST" --draft=false --latest --title "Métis ${VERSION}" --notes "$notes"
else
  gh release create "$TAG" --repo "$DST" --title "Métis ${VERSION}" --notes "$notes" "${required[@]}"
fi

echo
echo "OK https://github.com/${DST}/releases/tag/${TAG}"
echo "--- Windows feed (latest.yml) ---"
curl -fsSL "https://github.com/${DST}/releases/latest/download/latest.yml"
echo
echo "--- macOS feed (latest-mac.yml) ---"
curl -fsSL "https://github.com/${DST}/releases/latest/download/latest-mac.yml"
echo
echo "--- Installer URL smoke checks ---"
fail=0
for f in "Metis-Setup-${VERSION}.exe" "Metis-${VERSION}.dmg" "Metis-${VERSION}.zip"; do
  code=$(curl -sI -o /dev/null -w '%{http_code}' "https://github.com/${DST}/releases/latest/download/${f}")
  echo "  ${f} -> HTTP ${code}"
  [ "$code" = "302" ] || [ "$code" = "200" ] || fail=1
done
[ "$fail" -eq 0 ] || { echo "ERROR: one or more installer URLs failed" >&2; exit 1; }
echo "End-to-end feed OK for EXE + DMG. Installed 1.8.3 apps should see ${VERSION} in Settings → About."
