#!/usr/bin/env bash
# Build the reviewed LGPL-only FFmpeg import decoder for macOS, self-contained.
#
# Run this on a Mac. It produces resources/ffmpeg/darwin-arm64/ffmpeg and prints the sha256 to
# record in resources/ffmpeg/manifest.json.
#
# Why a source build rather than a downloaded binary: the sidecar ships inside the app, so it has to
# satisfy two constraints at once that no prebuilt macOS binary satisfies. It must be LGPL-only
# (public FFmpeg builds for macOS are almost all GPL — they bundle x264), and it must link nothing
# outside /usr/lib and /System/Library (a binary built on a machine with Homebrew picks up Homebrew
# dylibs and then dies with "Library not loaded" on any machine without them). --disable-autodetect
# is what enforces the second: it stops configure from linking anything it happens to find on the
# build machine, so the result depends only on macOS itself. The app decodes with FFmpeg's own
# built-in decoders (-vn -ac 1 -ar N -f f32le pipe:1), so it needs no external library.
set -euo pipefail

VERSION="7.1.1"
SOURCE_SHA256="733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
ARCH="${1:-arm64}"
MIN_MACOS="11.0"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/resources/ffmpeg/darwin-$ARCH"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ffmpeg-sidecar-XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: this builds a macOS binary and must run on macOS (found $(uname -s))." >&2
  exit 1
fi

echo "==> Fetching ffmpeg-$VERSION source"
curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$WORK_DIR/ffmpeg.tar.xz"

echo "==> Verifying source archive against the reviewed sha256"
ACTUAL_SOURCE_SHA="$(shasum -a 256 "$WORK_DIR/ffmpeg.tar.xz" | awk '{print $1}')"
if [ "$ACTUAL_SOURCE_SHA" != "$SOURCE_SHA256" ]; then
  echo "error: source archive sha256 mismatch." >&2
  echo "  expected $SOURCE_SHA256" >&2
  echo "  actual   $ACTUAL_SOURCE_SHA" >&2
  exit 1
fi

tar -xf "$WORK_DIR/ffmpeg.tar.xz" -C "$WORK_DIR"
cd "$WORK_DIR/ffmpeg-$VERSION"

echo "==> Configuring (LGPL-only, no external dependencies)"
# After a rebuild, copy this flag list into `configuration` in resources/ffmpeg/manifest.json. The
# manifest is the reviewed record of how the shipped binary was produced, so a drift between the two
# makes the licence claim unverifiable — which is exactly how a Homebrew-linked binary passed review
# while the manifest described a self-contained static build.
./configure \
  --prefix="$WORK_DIR/install" \
  --arch="$ARCH" \
  --extra-cflags="-mmacosx-version-min=$MIN_MACOS" \
  --extra-ldflags="-mmacosx-version-min=$MIN_MACOS" \
  --disable-gpl \
  --disable-nonfree \
  --disable-autodetect \
  --disable-debug \
  --disable-doc \
  --disable-ffplay \
  --disable-ffprobe \
  --enable-small \
  --enable-static \
  --disable-shared

echo "==> Building"
make -j"$(sysctl -n hw.ncpu)"

echo "==> Verifying the result is self-contained"
# Belt and braces: --disable-autodetect should make this impossible, but the whole reason this script
# exists is that a non-portable binary once got shipped, so prove it here rather than at package time.
FOREIGN="$(otool -L ffmpeg | tail -n +2 | awk '{print $1}' | grep -v -e '^/usr/lib/' -e '^/System/Library/' || true)"
if [ -n "$FOREIGN" ]; then
  echo "error: the built binary still links non-system libraries:" >&2
  echo "$FOREIGN" >&2
  exit 1
fi

echo "==> Verifying the licence banner"
if ! ./ffmpeg -L 2>&1 | grep -q "GNU Lesser General Public"; then
  echo "error: the built binary does not report the LGPL." >&2
  exit 1
fi
if ./ffmpeg -L 2>&1 | grep -q -e "nonfree parts compiled" -e "--enable-gpl"; then
  echo "error: the built binary reports GPL/nonfree parts." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp ffmpeg "$OUT_DIR/ffmpeg"
chmod +x "$OUT_DIR/ffmpeg"
strip -S -x "$OUT_DIR/ffmpeg" 2>/dev/null || true
# Ad-hoc sign: an arm64 binary must carry a signature to execute at all, and `strip` invalidates the
# linker's. Unsigned here would fail on launch, not at package time, which is the worst place to find out.
codesign --force --sign - "$OUT_DIR/ffmpeg"

NEW_SHA="$(shasum -a 256 "$OUT_DIR/ffmpeg" | awk '{print $1}')"

cat <<EOF

==> Done: $OUT_DIR/ffmpeg

Next steps:
  1. Record the new hash in resources/ffmpeg/manifest.json under "darwin-$ARCH/ffmpeg":
       "sha256": "$NEW_SHA"
     and make sure "configuration" there matches the ./configure flags in this script.
  2. Prove the gate passes:
       node scripts/check-ffmpeg-sidecar.mjs mac $ARCH
  3. Re-seed the CI provisioning asset (this replaces the non-portable one):
       cp "$OUT_DIR/ffmpeg" /tmp/ffmpeg-darwin-$ARCH
       gh release upload ffmpeg-sidecar-v1 /tmp/ffmpeg-darwin-$ARCH --clobber
  4. Commit the manifest change. CI caches the sidecar on the manifest hash, so the new hash
     invalidates the old cache automatically and the mac runner picks up the rebuilt binary.
EOF
