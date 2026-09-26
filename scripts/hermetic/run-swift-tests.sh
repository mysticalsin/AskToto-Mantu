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
mkdir -p "$SANDBOX/tmp"

export HOME="$SANDBOX"
# On Darwin, Foundation's NSHomeDirectory()/FileManager.homeDirectoryForCurrentUser resolve the home
# directory from getpwuid(), NOT from $HOME, for an ordinary (non-sandboxed) process — proven by CI: HOME
# alone left NSHomeDirectory() reporting the real runner account. CFFIXED_USER_HOME is the one override
# CoreFoundation's home-directory resolution actually honors regardless of sandbox status; both are set
# so this sandbox holds on every platform `swift test` runs on.
export CFFIXED_USER_HOME="$SANDBOX"
export TMPDIR="$SANDBOX/tmp"
export METIS_TEST_HOME="$SANDBOX"
# Windows detectOneDrive()'s env vars are inert on this platform; unset here too so a copy-pasted
# assertion in a shared canary can check them everywhere without special-casing macOS/Linux.
unset OneDrive OneDriveCommercial OneDriveConsumer 2>/dev/null || true

swift test --package-path "$PACKAGE_PATH" "$@"
