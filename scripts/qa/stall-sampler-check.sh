#!/usr/bin/env bash
# QA check for the out-of-process stall sampler (M2-0192). Run on the isolated QA macOS account only,
# never on an owner account, against a packaged candidate on a fresh profile that has been idle (including
# one sleep and wake) for at least 60 minutes.
#
#   scripts/qa/stall-sampler-check.sh <main-pid> <userData>
#
#   <main-pid>  the candidate's main process (pgrep -x Metis)
#   <userData>  the candidate's userData directory
#
# Passes when: exactly one stall-watch helper is a child of main; the idle period produced no bundle and
# no app.stall.sampled; a ${STALL_STOP_SECONDS:-40} s SIGSTOP of main produces exactly one bundle and one app.stall.sampled; the
# bundle starts with the main thread and contains no '/', '\' or '@' and not this account's user name; and
# after kill -9 of main the helper is gone within 6 s. Prints the helper's CPU time and RSS (census row).
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
count_bundles() { find "$stalls" -maxdepth 1 -name '*.txt' | wc -l | tr -d ' '; }
count_events() { grep -c '"event":"app.stall.sampled"' "$audit" || true; }

[[ "$(uname)" == Darwin ]] || fail 'macOS only'
[[ $# -eq 2 ]] || fail 'usage: stall-sampler-check.sh <main-pid> <userData>'
pid=$1 userdata=$2
stalls="$userdata/diagnostics/stalls" audit="$userdata/logs/audit.log"
kill -0 "$pid" 2>/dev/null || fail "no process $pid"
[[ -d "$stalls" && -f "$audit" ]] || fail "not a sampler-enabled profile: $userdata"
helper=$(pgrep -P "$pid" -f 'metis-mac-helper stall-watch' || true)
[[ -n "$helper" && "$helper" != *$'\n'* ]] || fail "expected one stall-watch child of $pid, got: ${helper:-none}"
echo "helper $helper after boot (cputime rss_kb): $(ps -o cputime=,rss= -p "$helper")"
[[ $(count_bundles) -eq 0 && $(count_events) -eq 0 ]] || fail 'the idle period produced a bundle or app.stall.sampled'

stop_seconds=${STALL_STOP_SECONDS:-40}
[[ "$stop_seconds" =~ ^[0-9]+$ && "$stop_seconds" -gt 0 ]] || fail "STALL_STOP_SECONDS must be a positive integer, got: $stop_seconds"
stop_epoch=$(date +%s)
kill -STOP "$pid"; sleep "$stop_seconds"; kill -CONT "$pid"
for _ in $(seq 120); do [[ $(count_bundles) -ge 1 && $(count_events) -ge 1 ]] && break; sleep 1; done
sleep 5
[[ $(count_bundles) -eq 1 ]] || fail "expected 1 bundle after the stop, found $(count_bundles)"
[[ $(count_events) -eq 1 ]] || fail "expected 1 app.stall.sampled, found $(count_events)"
bundle=$(find "$stalls" -maxdepth 1 -name '*.txt')
bundle_epoch=$(stat -f %m "$bundle")
detection_latency=$((bundle_epoch - stop_epoch))
grep -q '^Thread [0-9]* (main)' "$bundle" || fail 'bundle has no main thread'
if grep -q '[/@\\]' "$bundle"; then fail "bundle contains '/', '\\' or '@'"; fi
if grep -qiF "$(id -un)" "$bundle"; then fail 'bundle contains the user name'; fi
echo "helper $helper after stop (cputime rss_kb): $(ps -o cputime=,rss= -p "$helper")"
echo "PASS stop: $(basename "$bundle"), $(wc -c <"$bundle" | tr -d ' ') bytes, raw left: $(ls "$stalls/raw" | wc -l | tr -d ' '), detection latency: ${detection_latency}s"

kill -9 "$pid"
for waited in $(seq 0 60); do
  if ! kill -0 "$helper" 2>/dev/null; then
    echo "PASS parent death: helper exited in $((waited * 100))ms"
    exit 0
  fi
  sleep 0.1
done
fail "helper $helper outlived main by 6 s"
