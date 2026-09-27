#!/usr/bin/env bash
# W0-HERMETIC (M2-0190) — `swift test` has no config-level env hook the way vitest.config.ts's
# `test.env` does, so the sandbox has to be built by whatever invokes the `swift test` binary itself.
# This is that invocation: every swift-test run in CI (and any agent that must run one) goes through
# this script rather than calling `swift test` directly, so it always gets a fresh, empty HOME/TMPDIR —
# never the real one — matching the guarantee vitest workers already have (M2-0001).
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: run-swift-tests.sh <package-path> [extra swift test args...]" >&2
  exit 2
fi
PACKAGE_PATH="$1"
shift

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/metis-test-home-XXXXXX")"
# macOS's own $TMPDIR always ends in a slash (/var/folders/.../T/); mktemp's template preserves that
# verbatim as a literal double slash instead of normalizing it away, but Foundation's NSHomeDirectory()
# always normalizes. Canonicalize once here so every consumer of $SANDBOX (this script's own exports,
# HermeticHomeTests' string comparisons) agrees byte-for-byte with what NSHomeDirectory() reports.
SANDBOX="$(cd "$SANDBOX" && pwd)"
mkdir -p "$SANDBOX/tmp"

cleanup() {
  # Captured before any cleanup command runs: under `set -e`, a failing command inside this trap would
  # otherwise trigger errexit and exit with ITS OWN status, clobbering swift test's real one — including
  # a 0 (a fully green test run must not turn the job red because cleanup afterwards had trouble).
  local status=$?
  # Xcode can auto-mount its Metal toolchain disk image under this sandboxed $HOME while `swift test`
  # runs (…/Library/Developer/DVTDownloads/MetalToolchain/mounts/<id>); a mounted, read-only volume must
  # be detached before `rm -rf` can remove the directory tree containing its mount point. A directory
  # whose filesystem device id differs from its immediate parent's IS a mount point boundary — the same
  # test `find -xdev` relies on internally — which needs no assumption about `mount`'s own text layout,
  # unlike grepping its output. `diskutil unmount` takes the mount point itself (unlike `hdiutil detach`,
  # which wants the disk image's device node); `hdiutil detach` is a second attempt for a mount `diskutil`
  # doesn't otherwise resolve. Detach the deepest mount point first, so a mount nested inside another is
  # never still busy when its parent is detached.
  local d this_dev parent_dev mount_point
  while IFS= read -r mount_point; do
    diskutil unmount force "$mount_point" >/dev/null 2>&1 || hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true
  done < <(
    find "$SANDBOX" -type d 2>/dev/null | while IFS= read -r d; do
      this_dev="$(stat -f %d "$d" 2>/dev/null)" || continue
      parent_dev="$(stat -f %d "$(dirname "$d")" 2>/dev/null)" || continue
      [ "$this_dev" != "$parent_dev" ] && printf '%s\n' "$d"
    done | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-
  )
  rm -rf "$SANDBOX" || true
  exit "$status"
}
trap cleanup EXIT

export HOME="$SANDBOX"
# On Darwin, Foundation's NSHomeDirectory()/FileManager.homeDirectoryForCurrentUser resolve the home
# directory from getpwuid(), NOT from $HOME alone, for an ordinary (non-sandboxed) process.
# CFFIXED_USER_HOME is the one override CoreFoundation's home-directory resolution actually honors
# regardless of sandbox status; both are set so this sandbox holds on every platform `swift test` runs on.
export CFFIXED_USER_HOME="$SANDBOX"
export TMPDIR="$SANDBOX/tmp"
export METIS_TEST_HOME="$SANDBOX"

swift test --package-path "$PACKAGE_PATH" "$@"
