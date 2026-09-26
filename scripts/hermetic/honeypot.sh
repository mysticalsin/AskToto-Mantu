#!/usr/bin/env bash
# W0-HERMETIC (M2-0190) — shared seed/check for a "real home" honeypot: proves a suite that claims to be
# sandboxed never actually touched a directory standing in for the runner's real home-derived state.
# Used by more than one isolation-canary.yml job so the mechanism isn't kept as separate, drifting copies.
#
# The reference timestamp lives in $RUNNER_TEMP, OUTSIDE every honeypot directory this checks — comparing
# a directory's mtime against a file inside itself would go blind the moment that file is the one
# rewritten in place, since a rewritten file can never show up as "newer than itself".
#
# `check` fails CLOSED: a missing reference file, a deleted honeypot directory or sentinel, or a `find`
# error are every one of them a failure, never "nothing to report" — anything else would let a suite that
# deletes or corrupts the honeypot pass the very check meant to catch it.
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
    ref="$(honeypot_ref)"
    if [ ! -e "$ref" ]; then
      echo "no reference timestamp at $ref — run 'seed $dir' before 'check $dir'"
      exit 1
    fi
    if [ ! -d "$dir" ]; then
      echo "the honeypot directory is gone: $dir (the suite may have deleted it)"
      exit 1
    fi
    if [ ! -f "$dir/sentinel" ]; then
      echo "the honeypot sentinel file is gone: $dir/sentinel (the suite may have deleted it)"
      exit 1
    fi
    if ! touched="$(find "$dir" -newer "$ref")"; then
      echo "find failed while scanning the honeypot at $dir"
      exit 1
    fi
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
