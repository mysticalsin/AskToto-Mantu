#!/usr/bin/env bash
# W0-HERMETIC (M2-0190) — shared seed/check for a "real home" honeypot: proves a suite that claims to be
# sandboxed never actually touched a directory standing in for the runner's real home-derived state.
# Used by more than one isolation-canary.yml job so the mechanism isn't kept as separate, drifting copies.
#
# The reference timestamp lives in $RUNNER_TEMP, OUTSIDE every honeypot directory this checks. A prior
# version compared `find "$dir" -newer "$dir/sentinel"` — that looks equivalent but is not: an in-place
# rewrite of sentinel updates the very file everything else is compared against, so the rewritten file can
# never show up as "newer than itself" and the rewrite goes unreported. A reference file outside the
# honeypot has no such blind spot.
set -euo pipefail

honeypot_ref() { echo "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/metis-honeypot-ref"; }

usage() { echo "usage: honeypot.sh <seed|check> <dir>" >&2; exit 2; }

cmd="${1:-}"; dir="${2:-}"
[ -n "$cmd" ] && [ -n "$dir" ] || usage

case "$cmd" in
  seed)
    mkdir -p "$dir"
    echo sentinel > "$dir/sentinel"
    # Created strictly after the honeypot's own contents above, so anything the honeypot held before this
    # line is guaranteed at least as old as the reference — never falsely reported as "touched".
    touch "$(honeypot_ref)"
    ;;
  check)
    touched="$(find "$dir" -newer "$(honeypot_ref)" 2>/dev/null || true)"
    if [ -n "$touched" ]; then
      echo "the suite touched the real-home honeypot it must never reach:"
      echo "$touched"
      exit 1
    fi
    ;;
  *)
    usage
    ;;
esac
