#!/bin/bash
# Métis — prompt-free macOS installer.
#
#   curl -fsSL https://github.com/mysticalsin/Metis-Releases/releases/latest/download/install-metis.sh | bash
#
# Why this is the seamless path. macOS attaches a `com.apple.quarantine` tag to anything a BROWSER
# downloads; Gatekeeper then refuses to open it because Métis carries no Apple-notarized signature.
# curl does not set that tag — it is applied by the downloading application, and only browsers and
# other LSFileQuarantineEnabled apps do it. So a disk image fetched here is never quarantined, the
# app copied out of it is never quarantined, and the user sees no Gatekeeper dialog at all.
#
# This is not a Gatekeeper bypass: the user is explicitly running this command, which is the same
# trust decision `Open Anyway` represents — just made once, up front, instead of buried in System
# Settings. Replace it with a notarized build (docs/SIGNING.md) as soon as an Apple Developer ID
# exists; then neither this script nor any approval step is needed.

set -uo pipefail

REPO="${METIS_RELEASE_REPO:-mysticalsin/Metis-Releases}"
APP_NAME="Metis.app"
DEST_DIR="/Applications"
MNT=""
TMP=""

fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

cleanup() {
  [ -n "$MNT" ] && [ -d "$MNT" ] && hdiutil detach "$MNT" -quiet 2>/dev/null
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

[ "$(uname -s)" = "Darwin" ] || fail "This installer is macOS only."

printf '\nMetis installer\n===============\n\n'

printf '  Finding the latest release…\n'
# Parsed with grep/sed rather than jq or python3: neither is guaranteed on a Mac that has never had
# developer tools installed, which is exactly the machine this script targets.
DMG_URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
  | head -1 \
  | sed 's/.*"\(https[^"]*\)"/\1/')"

[ -n "$DMG_URL" ] || fail "Could not find a .dmg on the latest release of $REPO."
printf '  %s\n' "${DMG_URL##*/}"

TMP="$(mktemp -d)" || fail "Could not create a temporary directory."
DMG="$TMP/Metis.dmg"

printf '  Downloading…\n'
curl -fL --progress-bar -o "$DMG" "$DMG_URL" || fail "Download failed."

printf '  Mounting the disk image…\n'
MNT="$TMP/mnt"
mkdir -p "$MNT"
# -nobrowse keeps it out of Finder; -readonly matches how the image was built.
hdiutil attach "$DMG" -nobrowse -readonly -noverify -mountpoint "$MNT" -quiet \
  || fail "Could not mount the disk image."

[ -d "$MNT/$APP_NAME" ] || fail "The disk image does not contain $APP_NAME."

# A managed Mac can have a read-only /Applications; per-user Applications needs no admin rights.
if [ ! -w "$DEST_DIR" ]; then
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR" || fail "Cannot write to /Applications or to $DEST_DIR."
  printf '  /Applications is not writable — installing to %s instead.\n' "$DEST_DIR"
fi
DEST_APP="$DEST_DIR/$APP_NAME"

if [ -d "$DEST_APP" ]; then
  printf '  Replacing the existing copy…\n'
  pkill -f "$DEST_APP/Contents/MacOS/" 2>/dev/null || true
  sleep 1
  rm -rf "$DEST_APP" || fail "Could not remove $DEST_APP. Quit Metis and run this again."
fi

printf '  Installing to %s…\n' "$DEST_DIR"
# ditto, not cp -R: it preserves the bundle's symlinks, extended attributes and code signature.
ditto "$MNT/$APP_NAME" "$DEST_APP" || fail "Copy failed."

# Defensive only. curl leaves no quarantine tag, but a re-run against a browser-downloaded image
# staged by hand would, and one tag left on a nested helper bundle still triggers the dialog.
xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true

printf '  Verifying the signature still seals…\n'
codesign --verify --strict "$DEST_APP" >/dev/null 2>&1 \
  || fail "The copied app failed signature verification. Delete $DEST_APP and try again."

printf '  Launching Metis…\n'
open "$DEST_APP" || fail "Could not launch $DEST_APP."

printf '\n  Done. Metis is installed in %s.\n\n' "$DEST_DIR"
