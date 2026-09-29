#!/usr/bin/env bash
# Behavioural tests for the metis-mac-helper sidecar: compiles native/mac-helper/main.swift for the host
# architecture and drives the real binary through its argument parsing, proc-info, screen-metrics and ocr
# subcommands. Black-box on purpose: main.swift is top-level script code, so the contract worth pinning is
# the stdout/stderr/exit-code protocol the TypeScript consumers parse. macOS only.
# Usage: run-helper-tests.sh [work-dir]   (default: a fresh temp dir, removed on exit)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="${1:-$(mktemp -d)}"
mkdir -p "$work"
[ -n "${1:-}" ] || trap 'rm -rf "$work"' EXIT
helper="$work/metis-mac-helper"
failures=0

pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }
# expect_exit <name> <expected-code> <actual-code>
expect_exit() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (exit $3, wanted $2)"; fi; }
py() { /usr/bin/python3 -c "$1"; }

swiftc -O -o "$helper" "$here/../main.swift" || { echo "FAIL - compile main.swift"; exit 1; }

# --- entry-point argument parsing ------------------------------------------------------------------
err="$("$helper" 2>&1 >/dev/null)"; code=$?
expect_exit "no subcommand exits 1" 1 "$code"
case "$err" in *usage:*stall-watch*) pass "usage lists every subcommand" ;; *) fail "usage lists stall-watch: $err" ;; esac

err="$("$helper" bogus 2>&1 >/dev/null)"; code=$?
expect_exit "unknown subcommand exits 1" 1 "$code"
case "$err" in *"unknown command: bogus"*) pass "unknown subcommand is named" ;; *) fail "unknown subcommand message: $err" ;; esac

"$helper" transcribe >/dev/null 2>&1; code=$?
expect_exit "transcribe without a wav path exits 1" 1 "$code"

# --- stall-watch argument parsing (the long-running supervising mode) ------------------------------
err="$("$helper" stall-watch 2>&1 >/dev/null)"; code=$?
expect_exit "stall-watch with no options exits 1" 1 "$code"
case "$err" in *"usage: metis-mac-helper stall-watch --pid"*) pass "stall-watch prints its usage" ;; *) fail "stall-watch usage: $err" ;; esac

"$helper" stall-watch --pid 1 --alive "$work/alive" --capture-prefix "$work/cap" >/dev/null 2>&1; code=$?
expect_exit "stall-watch missing --stale-after-ms exits 1" 1 "$code"

"$helper" stall-watch --pid notanumber --alive "$work/alive" --capture-prefix "$work/cap" --stale-after-ms 1000 >/dev/null 2>&1; code=$?
expect_exit "stall-watch non-numeric --pid exits 1" 1 "$code"

"$helper" stall-watch --pid 1 --alive "$work/alive" --capture-prefix "$work/cap" --stale-after-ms 1000 >/dev/null 2>"$work/err"; code=$?
expect_exit "stall-watch refuses a --pid that is not its parent" 1 "$code"
if grep -q "is not this helper's parent" "$work/err"; then pass "stall-watch names the parent mismatch"; else fail "stall-watch parent-mismatch message"; fi

# --- supervise argument parsing (setup failures exit 125, never the child's status) ----------------
err="$("$helper" supervise 2>&1 >/dev/null)"; code=$?
expect_exit "supervise with no options exits 125" 125 "$code"
case "$err" in *"usage: metis-mac-helper supervise --parent"*) pass "supervise prints its usage" ;; *) fail "supervise usage: $err" ;; esac

"$helper" supervise --parent notanumber -- /usr/bin/true >/dev/null 2>&1; code=$?
expect_exit "supervise non-numeric --parent exits 125" 125 "$code"

"$helper" supervise --parent $$ >/dev/null 2>&1; code=$?
expect_exit "supervise without '-- <cmd>' exits 125" 125 "$code"

"$helper" supervise --parent $$ -- >/dev/null 2>&1; code=$?
expect_exit "supervise with an empty command exits 125" 125 "$code"

"$helper" supervise --parent 1 -- /usr/bin/true >/dev/null 2>"$work/err"; code=$?
expect_exit "supervise refuses a --parent that is not its parent" 125 "$code"
if grep -q "is not this helper's parent" "$work/err"; then pass "supervise names the parent mismatch"; else fail "supervise parent-mismatch message"; fi

# A valid invocation reaches supervision: the child runs and its exit status is passed through.
# The wrapper shell passes its own pid as --parent; the trailing exit keeps it from exec-ing the helper away.
sh -c '"$0" supervise --parent $$ -- /bin/sh -c "exit 7"; exit $?' "$helper" >/dev/null 2>&1; code=$?
expect_exit "supervise exits with the child's status" 7 "$code"

# --- proc-info -------------------------------------------------------------------------------------
"$helper" proc-info >/dev/null 2>&1; code=$?
expect_exit "proc-info without a pid exits 1" 1 "$code"

out="$("$helper" proc-info abc)"; code=$?
expect_exit "proc-info non-numeric pid exits 0" 0 "$code"
if [ -z "$out" ]; then pass "proc-info non-numeric pid prints nothing"; else fail "proc-info non-numeric pid printed: $out"; fi

out="$("$helper" proc-info 2147483646)"; code=$?
expect_exit "proc-info dead pid exits 0" 0 "$code"
if [ -z "$out" ]; then pass "proc-info dead pid prints nothing"; else fail "proc-info dead pid printed: $out"; fi

sleep 30 &
child=$!
out="$("$helper" proc-info "$child")"
kill "$child" 2>/dev/null; wait "$child" 2>/dev/null
if printf '%s' "$out" | CHILD="$child" PARENT="$$" py '
import json, os, re, sys
d = json.load(sys.stdin)
assert d["pid"] == int(os.environ["CHILD"]), d
assert d["ppid"] == int(os.environ["PARENT"]), d
assert d["pgid"] > 0, d
assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", d["osStartTime"]), d["osStartTime"]
assert d["exeRealpath"].endswith("/sleep"), d["exeRealpath"]
assert d["args"][-1] == "30", d["args"]
'; then pass "proc-info reports pid, ppid, pgid, UTC start time, exe and args"; else fail "proc-info identity JSON: $out"; fi

# --- screen-metrics --------------------------------------------------------------------------------
out="$("$helper" screen-metrics)"; code=$?
expect_exit "screen-metrics exits 0" 0 "$code"
if printf '%s' "$out" | py '
import json, sys
d = json.load(sys.stdin)
assert list(d) == ["screens"], list(d)
keys = {"displayID", "frame", "visibleFrame", "safeAreaInsetTop", "auxLeftWidth", "auxRightWidth", "notchWidth", "backingScaleFactor"}
for s in d["screens"]:
    assert set(s) == keys, sorted(s)
    assert len(s["frame"]) == 4 and len(s["visibleFrame"]) == 4, s
    assert s["backingScaleFactor"] >= 1, s
    assert 0 <= s["notchWidth"] <= s["frame"][2], s
    if s["auxLeftWidth"] == 0 and s["auxRightWidth"] == 0:
        assert s["notchWidth"] == 0, s
'; then pass "screen-metrics JSON has the documented shape and a zero notch on notch-less screens"; else fail "screen-metrics JSON: $out"; fi

# --- ocr -------------------------------------------------------------------------------------------
"$helper" ocr "$work/missing.png" >/dev/null 2>"$work/err"; code=$?
expect_exit "ocr on a missing file exits 1" 1 "$code"
printf 'not an image' | "$helper" ocr - >/dev/null 2>"$work/err"; code=$?
expect_exit "ocr on non-image stdin exits 1" 1 "$code"

if swift "$here/make-ocr-fixture.swift" "$work/fixture.png"; then
  out="$("$helper" ocr "$work/fixture.png")"; code=$?
  expect_exit "ocr exits 0 on a rendered image" 0 "$code"
  # Vision boxes are normalized with a bottom-left origin, so the line drawn nearer the top of the image
  # has the LARGER y; the TypeScript consumer sorts descending on it.
  if printf '%s' "$out" | py '
import json, sys
d = json.load(sys.stdin)
assert (d["width"], d["height"]) == (900, 500), d
by_text = {l["text"].strip().upper(): l for l in d["lines"]}
top, bottom = by_text["TOP LINE"], by_text["BOTTOM LINE"]
for l in (top, bottom):
    x, y, w, h = l["box"]
    assert 0 <= x and 0 <= y and w > 0 and h > 0 and x + w <= 1 and y + h <= 1, l
    assert 0 <= l["confidence"] <= 1, l
assert top["box"][1] > bottom["box"][1], (top, bottom)
ordered = sorted(d["lines"], key=lambda l: -l["box"][1])
assert [l["text"].strip().upper() for l in ordered][:2] == ["TOP LINE", "BOTTOM LINE"], ordered
'; then pass "ocr boxes are normalized bottom-left and sort top-to-bottom by descending y"; else fail "ocr box order: $out"; fi
else
  fail "render ocr fixture"
fi

if [ "$failures" -eq 0 ]; then echo "all helper tests passed"; exit 0; fi
echo "$failures helper test(s) failed"
exit 1
