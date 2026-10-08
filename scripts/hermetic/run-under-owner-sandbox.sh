#!/usr/bin/env bash
# W0-HERMETIC (M2-0190) §2 — runs one command under the owner-account OS sandbox profile
# (scripts/hermetic/owner-account.sb). `-D HOME=$HOME` is what makes `(param "HOME")` inside that
# profile resolve to this machine's real home directory, so the profile file itself stays
# machine-independent.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: run-under-owner-sandbox.sh <command> [args...]" >&2
  exit 2
fi

# Owner admission is held independently of the selected profile, including legacy and cleanup routes.
# Hosted synthetic proofs remain available; they do not qualify this route for personal-device use.
if [ "${OWNER_SANDBOX_ROUTE:-}" = owner ]; then
  echo 'owner-runner sandbox: owner route disabled: architectural isolation hold' >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec sandbox-exec -f "$HERE/owner-account.sb" -D HOME="$HOME" "$@"
