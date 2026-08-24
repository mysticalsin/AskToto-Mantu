#!/bin/bash
# Métis — double-click installer, shipped inside Metis-<version>.dmg.
#
# Why this exists: Métis is not Apple-notarized, so macOS 15+ refuses to open the app straight from
# the DMG and no longer offers the old Control-click → Open bypass. This script does the three things
# a user would otherwise have to do by hand — copy to /Applications, strip the download quarantine
# tag, confirm the signature still seals — and then launches the app.
#
# It is NOT a way around the one Gatekeeper approval the script itself needs when the DMG was
# downloaded in a browser. For a genuinely prompt-free install use the curl one-liner in
# docs/INSTALL.md, which downloads outside the quarantine system entirely.

set -uo pipefail

APP_NAME="Metis.app"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_APP="$SRC_DIR/$APP_NAME"
DEST_DIR="/Applications"

fail() {
  printf '\n  %s\n\n' "$*" >&2
  printf 'Press Return to close this window.'
  read -r _
  exit 1
}

printf '\nMetis installer\n===============\n\n'

[ -d "$SRC_APP" ] || fail "Could not find $APP_NAME next to this script. Run it from the mounted Metis disk image."

# A managed Mac can have a read-only /Applications. Per-user Applications needs no admin rights and
# Launchpad/Spotlight index it the same way.
if [ ! -w "$DEST_DIR" ]; then
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR" || fail "Cannot write to /Applications or to $DEST_DIR."
  printf '  /Applications is not writable — installing to %s instead.\n' "$DEST_DIR"
fi

DEST_APP="$DEST_DIR/$APP_NAME"

if [ -d "$DEST_APP" ]; then
  printf '  Replacing the existing copy at %s\n' "$DEST_APP"
  # Quit a running copy first — replacing a bundle under a live process leaves a half-updated app.
  # pkill on the executable path, not osascript: AppleScript would trigger an Automation (TCC)
  # consent dialog, which is exactly the kind of extra prompt this script exists to avoid.
  pkill -f "$DEST_APP/Contents/MacOS/" 2>/dev/null || true
  sleep 1
  rm -rf "$DEST_APP" || fail "Could not remove $DEST_APP. Quit Metis and run this again."
fi

printf '  Copying Metis to %s\n' "$DEST_DIR"
# ditto, not cp -R: it preserves the bundle's symlinks, extended attributes and code signature.
ditto "$SRC_APP" "$DEST_APP" || fail "Copy failed."

printf '  Clearing the download quarantine flag\n'
# -r matters: the nested Metis Helper bundles carry their own copies of the tag, and one left behind
# still triggers the Gatekeeper dialog.
xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true

printf '  Verifying the signature still seals\n'
if ! codesign --verify --strict "$DEST_APP" >/dev/null 2>&1; then
  fail "The copied app failed signature verification. Delete $DEST_APP and download the disk image again."
fi

printf '  Launching Metis\n'
open "$DEST_APP" || fail "Could not launch $DEST_APP."

printf '\n  Done. Metis is installed in %s.\n\n' "$DEST_DIR"
