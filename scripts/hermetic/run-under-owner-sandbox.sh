#!/usr/bin/env bash
# W0-HERMETIC (M2-0190) §2 — runs one command under a reviewed owner-account OS sandbox profile.
# `-D HOME=$HOME` is what makes `(param "HOME")` inside the profile resolve to this machine's
# real home directory, so the profile file itself stays machine-independent.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: run-under-owner-sandbox.sh <command> [args...]" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="${OWNER_SANDBOX_PROFILE:-owner-account.sb}"
case "$profile" in
  owner-account.sb|owner-runner.sb) ;;
  *)
    echo "unsupported owner sandbox profile: $profile" >&2
    exit 2 ;;
esac

exec sandbox-exec \
  -f "$HERE/$profile" \
  -D HOME="$HOME" \
  -D RUNNER_TEMP="${RUNNER_TEMP:-/var/empty}" \
  -D WORKSPACE="${GITHUB_WORKSPACE:-$PWD}" \
  "$@"
