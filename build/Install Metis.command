#!/bin/bash
# Double-clickable macOS installer for builds that are not Apple-notarized.
#
# macOS tags anything downloaded (or synced via OneDrive/Dropbox/Slack/email) with a `com.apple.quarantine`
# extended attribute. On a build without an Apple Developer ID signature + notarization, Gatekeeper turns
# that tag into "Apple could not verify Metis is free of malware". The app is fine; macOS simply has no
# Apple-issued signature to check it against. Clearing the tag before first launch is what stops the
# dialog: on macOS 15 and later Control-click > Open no longer bypasses it, leaving System Settings >
# Privacy & Security > Open Anyway as the only click-through, after the warning has already scared the
# user off. This affects only this app and does NOT disable Gatekeeper system-wide.
#
# Usage: double-click this file in Finder. It installs Metis to /Applications and opens it.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="/Applications/Metis.app"

echo "Installing Metis"
echo

# Find the app: next to this script, inside a mounted DMG, or already installed.
SRC=""
for candidate in "$DIR/Metis.app" "$DIR/../Metis.app" /Volumes/*/Metis.app "$DEST"; do
  if [ -d "$candidate" ]; then
    SRC="$candidate"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "Could not find Metis.app."
  echo "Put this script in the same folder as Metis.app (or open the .dmg first), then run it again."
  read -r -p "Press Return to close."
  exit 1
fi

# Copying onto itself would delete the only copy, so only install when the source is somewhere else.
if [ "$SRC" != "$DEST" ]; then
  if [ -d "$DEST" ]; then
    echo "Replacing the existing copy in /Applications"
    rm -rf "$DEST"
  fi
  echo "Copying to /Applications (this is a large app, it takes a moment)"
  cp -R "$SRC" "$DEST"
fi

# The actual fix. -r covers the nested helper apps and frameworks inside the bundle, which carry their
# own copies of the tag; missing one still triggers the warning on first launch.
echo "Clearing the download quarantine tag"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Verify the bundle's signature still seals correctly. Catches a partial copy or a corrupted download
# before the user hits a confusing crash-on-launch instead of a clear message here.
if codesign --verify --deep --strict "$DEST" 2>/dev/null; then
  echo "Signature check passed"
else
  echo "Warning: the signature did not verify. The copy may be incomplete. Try downloading again."
fi

echo
echo "Done. Opening Metis."
open "$DEST"
