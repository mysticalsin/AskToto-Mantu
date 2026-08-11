#!/usr/bin/env bash
# Build the reviewed LGPL-only FFmpeg import decoder for macOS, self-contained.
#
# Run this on a Mac. It produces resources/ffmpeg/darwin-<arch>/ffmpeg and prints the sha256 to
# record in resources/ffmpeg/manifest.json. The arch argument is node-style (arm64 | x64) so it
# matches the directory layout check-ffmpeg-sidecar.mjs looks in and the manifest keys it reads;
# FFmpeg's own --arch spelling (x86_64) is derived below rather than asked of the caller.
#
# Either arch can be built from either kind of Mac: the x64 sidecar cross-compiles cleanly on Apple
# Silicon, and Rosetta 2 runs the result for the licence-banner check at the end. Building x64 on an
# Apple Silicon Mac WITHOUT Rosetta installed fails at that check, not at compile time.
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

# Node's arch names index the shipped layout (resources/ffmpeg/darwin-x64) and the manifest keys;
# clang and FFmpeg's configure both want the machine name. Map once, here, so no caller has to know
# that "x64" and "x86_64" are the same thing — mixing the two silently builds the host arch instead.
case "$ARCH" in
  arm64) MACHINE_ARCH="arm64" ;;
  x64)   MACHINE_ARCH="x86_64" ;;
  *)
    echo "error: unsupported arch '$ARCH'. Use the node spelling: arm64 or x64." >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/resources/ffmpeg/darwin-$ARCH"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ffmpeg-sidecar-XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: this builds a macOS binary and must run on macOS (found $(uname -s))." >&2
  exit 1
fi

# uname -m reports the translated arch under Rosetta, so ask sysctl for the real hardware instead:
# running this script itself under Rosetta would otherwise make an x86_64 build look native and skip
# the cross-compile flags, producing an arm64 binary in the darwin-x64 directory.
HOST_ARCH="$(uname -m)"
if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  HOST_ARCH="arm64"
fi

CROSS_FLAGS=()
if [ "$MACHINE_ARCH" != "$HOST_ARCH" ]; then
  echo "==> Cross-compiling $MACHINE_ARCH on a $HOST_ARCH host"
  # --enable-cross-compile stops configure from *running* its probe binaries. They would actually run
  # here (Rosetta translates x86_64), but only in one direction and only when Rosetta is installed, so
  # relying on that would make the build's correctness depend on an optional OS component. The explicit
  # --cc carries the -arch through every compile and link configure performs.
  CROSS_FLAGS=(--enable-cross-compile --target-os=darwin --cc="clang -arch $MACHINE_ARCH")
  # The licence banner below has to execute the binary. Only Rosetta can do that for an x86_64 build
  # on Apple Silicon; say so now rather than after a full compile.
  if [ "$MACHINE_ARCH" = "x86_64" ] && ! /usr/bin/pgrep -q oahd; then
    echo "error: building the x64 sidecar on Apple Silicon needs Rosetta 2 to verify the result." >&2
    echo "  install it with: softwareupdate --install-rosetta --agree-to-license" >&2
    exit 1
  fi
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
  --arch="$MACHINE_ARCH" \
  "${CROSS_FLAGS[@]+"${CROSS_FLAGS[@]}"}" \
  --extra-cflags="-arch $MACHINE_ARCH -mmacosx-version-min=$MIN_MACOS" \
  --extra-ldflags="-arch $MACHINE_ARCH -mmacosx-version-min=$MIN_MACOS" \
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

echo "==> Verifying the result is actually $MACHINE_ARCH"
# A dropped -arch does not fail the build, it just produces the host architecture — which would then
# pass every check below and ship an arm64 binary inside the darwin-x64 directory, where it dies on
# the Intel Macs this whole cross-build exists to serve. Assert the arch rather than assume it.
BUILT_ARCHS="$(lipo -archs ffmpeg)"
case " $BUILT_ARCHS " in
  *" $MACHINE_ARCH "*) ;;
  *)
    echo "error: built ffmpeg is '$BUILT_ARCHS', expected $MACHINE_ARCH." >&2
    exit 1
    ;;
esac

echo "==> Verifying the result is self-contained"
# Belt and braces: --disable-autodetect should make this impossible, but the whole reason this script
# exists is that a non-portable binary once got shipped, so prove it here rather than at package time.
# otool runs on its own line so `set -e` catches a broken toolchain — folding it into the pipeline
# below would let `|| true` swallow otool's own failure and report a binary nothing ever examined.
DEPS="$(otool -L ffmpeg)"
# Select on the leading tab rather than `tail -n +2`: otool prints one header line per architecture,
# so a universal binary has several, and dropping only the first turns the rest into bare filenames
# that then fail the system-path test.
FOREIGN="$(printf '%s\n' "$DEPS" | awk '/^\t/ {print $1}' | grep -v -e '^/usr/lib/' -e '^/System/Library/' || true)"
if [ -n "$FOREIGN" ]; then
  echo "error: the built binary still links non-system libraries:" >&2
  echo "$FOREIGN" >&2
  exit 1
fi

echo "==> Verifying the licence banner"
# Run it once and separate "could not execute" from "wrong licence". Testing `! ./ffmpeg -L | grep -q`
# conflates them: under pipefail any failure to RUN also negates to true and reports a licence
# problem, while the mirrored nonfree test silently passes because its grep found nothing in the
# empty output. That is the exact misdiagnosis check-ffmpeg-sidecar.mjs was rewritten to remove.
# On a cross-build this runs through Rosetta, which the host check above already confirmed is present.
if ! LICENSE_OUT="$(./ffmpeg -L 2>&1)"; then
  echo "error: the freshly built binary could not be executed. This is not a licensing failure." >&2
  echo "$LICENSE_OUT" >&2
  exit 1
fi
case "$LICENSE_OUT" in
  *"GNU Lesser General Public"*) ;;
  *) echo "error: the built binary does not report the LGPL." >&2; exit 1 ;;
esac
case "$LICENSE_OUT" in
  *"nonfree parts compiled"* | *"--enable-gpl"*)
    echo "error: the built binary reports GPL/nonfree parts." >&2
    exit 1
    ;;
esac

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
