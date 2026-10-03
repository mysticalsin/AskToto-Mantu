#!/usr/bin/env bash
# Behavioural tests for the metis-mac-helper sidecar: compiles every native/mac-helper/*.swift file for the host
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

swift_sources=()
while IFS= read -r path; do swift_sources+=("$path"); done < <(find "$here/.." -maxdepth 1 -name '*.swift' -print | sort)
swiftc -O -o "$helper" "${swift_sources[@]}" || { echo "FAIL - compile mac-helper sources"; exit 1; }

sandbox_profile="$work/deny-network.sb"
cat >"$sandbox_profile" <<'SB'
(version 1)
(allow default)
(deny network*)
SB
run_denied_network() {
  if command -v sandbox-exec >/dev/null 2>&1; then
    sandbox-exec -f "$sandbox_profile" "$@"
  else
    echo "sandbox-exec is required for deny-network helper tests" >&2
    return 127
  fi
}

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
out=""
for _ in $(seq 1 100); do
  out="$("$helper" proc-info "$child")"
  if printf '%s' "$out" | py '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("exeRealpath", "").endswith("/sleep") else 1)
' >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
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

if swift "$here/make-ocr-fixture.swift" "$work/english.png" english &&
   swift "$here/make-ocr-fixture.swift" "$work/french.png" french; then
  out="$(run_denied_network "$helper" ocr-words "$work/english.png")"; code=$?
  expect_exit "ocr-words exits 0 on an English rendered image under deny-network sandbox" 0 "$code"
  if printf '%s' "$out" | py '
import json, sys
d = json.load(sys.stdin)
assert d["image"] == {"width": 900, "height": 500}, d
assert d["coverage"] == "VISIBLE_ONLY", d
assert d["untrustedContent"] is True, d
assert set(d["truncated"]) == {"lines", "words"}, d
assert d["truncated"] == {"lines": False, "words": False}, d
words = [w["text"].strip().upper() for w in d["words"]]
assert words[:4] == ["TOP", "LINE", "BOTTOM", "LINE"], words
for item in d["lines"] + d["words"]:
    b = item["box"]
    assert set(b) == {"x", "y", "width", "height"}, b
    assert 0 <= b["x"] and 0 <= b["y"] and b["width"] > 0 and b["height"] > 0, item
    assert b["x"] + b["width"] <= 1 and b["y"] + b["height"] <= 1, item
line_ids = {l["id"] for l in d["lines"]}
assert all(w["lineId"] in line_ids for w in d["words"]), d
assert [l["text"].strip().upper() for l in d["lines"]][:2] == ["TOP LINE", "BOTTOM LINE"], d["lines"]
by_line = {}
for word in d["words"]:
    by_line.setdefault(word["lineId"], []).append(word)
top_line, bottom_line = d["lines"][:2]
top_words = by_line[top_line["id"]]
bottom_words = by_line[bottom_line["id"]]
assert [w["text"].strip().upper() for w in top_words[:2]] == ["TOP", "LINE"], top_words
assert [w["text"].strip().upper() for w in bottom_words[:2]] == ["BOTTOM", "LINE"], bottom_words
for row in (top_words, bottom_words):
    assert row[0]["box"]["x"] < row[1]["box"]["x"], row
# make-ocr-fixture.swift draws both rows at x=60 on a 900px image; Vision boxes can be a little tighter
# than the glyph origin, but the first word of each line should stay near that left band.
for word in (top_words[0], bottom_words[0]):
    assert 0.04 <= word["box"]["x"] <= 0.12, word
# The fixture draws one line in the upper band and one in the lower band. Contract boxes use top-left y.
for word in top_words[:2]:
    assert 0.10 <= word["box"]["y"] <= 0.35, word
for word in bottom_words[:2]:
    assert 0.68 <= word["box"]["y"] <= 0.92, word
'; then pass "ocr-words English output has contract shape, word links, boxes and reading order"; else fail "ocr-words English JSON: $out"; fi

  out="$(run_denied_network "$helper" ocr-words "$work/french.png")"; code=$?
  expect_exit "ocr-words exits 0 on a French rendered image under deny-network sandbox" 0 "$code"
  if printf '%s' "$out" | py '
import json, sys
d = json.load(sys.stdin)
assert d["image"] == {"width": 900, "height": 500}, d
assert d["coverage"] == "VISIBLE_ONLY", d
assert d["untrustedContent"] is True, d
assert d["truncated"] == {"lines": False, "words": False}, d
words = [w["text"].strip().upper() for w in d["words"]]
assert words[:4] == ["BONJOUR", "EQUIPE", "MERCI", "METIS"], words
for item in d["lines"] + d["words"]:
    b = item["box"]
    assert set(b) == {"x", "y", "width", "height"}, b
    assert 0 <= b["x"] and 0 <= b["y"] and b["width"] > 0 and b["height"] > 0, item
    assert b["x"] + b["width"] <= 1 and b["y"] + b["height"] <= 1, item
line_ids = {l["id"] for l in d["lines"]}
assert all(w["lineId"] in line_ids for w in d["words"]), d
by_line = {}
for word in d["words"]:
    by_line.setdefault(word["lineId"], []).append(word)
top_line, bottom_line = d["lines"][:2]
top_words = by_line[top_line["id"]]
bottom_words = by_line[bottom_line["id"]]
assert [w["text"].strip().upper() for w in top_words[:2]] == ["BONJOUR", "EQUIPE"], top_words
assert [w["text"].strip().upper() for w in bottom_words[:2]] == ["MERCI", "METIS"], bottom_words
for row in (top_words, bottom_words):
    assert row[0]["box"]["x"] < row[1]["box"]["x"], row
for word in (top_words[0], bottom_words[0]):
    assert 0.04 <= word["box"]["x"] <= 0.12, word
for word in top_words[:2]:
    assert 0.10 <= word["box"]["y"] <= 0.35, word
for word in bottom_words[:2]:
    assert 0.68 <= word["box"]["y"] <= 0.92, word
'; then pass "ocr-words French output has contract shape, word links, boxes and reading order"; else fail "ocr-words French JSON: $out"; fi
else
  fail "render ocr-words fixtures"
fi

target_title="Metis OCR Target $$"
overlap_title="Metis OCR Overlap $$"
banner_title="Metis OCR Banner $$"
target_ready="$work/target.ready"
overlap_ready="$work/overlap.ready"
banner_ready="$work/banner.ready"
swift "$here/single-window-ocr-row.swift" window "$target_title" "TARGET ONLY" 80 420 normal >"$target_ready" 2>"$work/target.err" &
target_pid=$!
swift "$here/single-window-ocr-row.swift" window "$overlap_title" "OVERLAP NOISE" 120 430 normal >"$overlap_ready" 2>"$work/overlap.err" &
overlap_pid=$!
swift "$here/single-window-ocr-row.swift" window "$banner_title" "BANNER NOISE" 60 600 floating >"$banner_ready" 2>"$work/banner.err" &
banner_pid=$!
cleanup_single_window_row() {
  kill "$target_pid" "$overlap_pid" "$banner_pid" 2>/dev/null || true
  wait "$target_pid" "$overlap_pid" "$banner_pid" 2>/dev/null || true
}
for _ in $(seq 1 120); do
  if grep -q ready "$target_ready" 2>/dev/null &&
     grep -q ready "$overlap_ready" 2>/dev/null &&
     grep -q ready "$banner_ready" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if grep -q ready "$target_ready" 2>/dev/null &&
   grep -q ready "$overlap_ready" 2>/dev/null &&
   grep -q ready "$banner_ready" 2>/dev/null; then
  capture_err="$work/single-window-capture.err"
  swift "$here/single-window-ocr-row.swift" capture "$target_title" "$work/single-window-target.png" 2>"$capture_err"; capture_code=$?
  if [ "$capture_code" = 75 ]; then
    cat "$capture_err"
    pass "single-window OCR row reports BLOCKED_EXTERNAL when Screen Recording is unavailable"
  else
    expect_exit "single-window target capture exits 0" 0 "$capture_code"
    if [ "$capture_code" = 0 ]; then
      out="$(run_denied_network "$helper" ocr-words "$work/single-window-target.png")"; code=$?
      expect_exit "single-window target capture feeds ocr-words under deny-network sandbox" 0 "$code"
      if printf '%s' "$out" | py '
import json, sys
d = json.load(sys.stdin)
text = " ".join(w["text"].strip().upper() for w in d["words"])
assert "TARGET" in text and "ONLY" in text, text
for forbidden in ("OVERLAP", "BANNER", "NOISE"):
    assert forbidden not in text, text
'; then pass "single-window OCR excludes overlapping and banner window text"; else fail "single-window OCR JSON: $out"; fi
    fi
  fi
else
  fail "single-window OCR row windows became ready"
fi
cleanup_single_window_row

# --- code-identity (read-only; M2-0429) ------------------------------------------------------------
"$helper" code-identity >/dev/null 2>&1; code=$?
expect_exit "code-identity without a path exits 1" 1 "$code"
"$helper" code-identity "$work/missing.app" >/dev/null 2>&1; code=$?
expect_exit "code-identity on a missing path exits 1" 1 "$code"

# An explicitly ad-hoc-signed copy, so the result does not depend on the runner's linker defaults.
cp "$helper" "$work/adhoc-bin"
if codesign --force --sign - "$work/adhoc-bin" >/dev/null 2>&1; then
  out="$("$helper" code-identity "$work/adhoc-bin")"; code=$?
  expect_exit "code-identity exits 0 on ad-hoc code" 0 "$code"
  expected="$(codesign -dvvv "$work/adhoc-bin" 2>&1 | sed -n 's/^CDHash=//p')"
  if printf '%s' "$out" | EXPECTED="$expected" py '
import json, os, re, sys
d = json.load(sys.stdin)
assert set(d) == {"identifier", "cdhash", "teamId", "adhoc"}, sorted(d)
assert d["adhoc"] is True, d
assert re.fullmatch(r"[0-9a-f]{40}", d["cdhash"]), d["cdhash"]
assert d["cdhash"] == os.environ["EXPECTED"].lower(), (d["cdhash"], os.environ["EXPECTED"])
assert d["teamId"] == "", d
'; then pass "code-identity reports adhoc and the same 40-hex cdhash codesign shows"; else fail "code-identity JSON: $out"; fi
else
  fail "ad-hoc sign the code-identity fixture"
fi

# --- bundle-copies (read-only; M2-0429) ------------------------------------------------------------
"$helper" bundle-copies >/dev/null 2>&1; code=$?
expect_exit "bundle-copies without a bundle id exits 1" 1 "$code"

out="$("$helper" bundle-copies com.mantu.asktoto.helper-test-missing)"; code=$?
expect_exit "bundle-copies exits 0 for an unknown bundle id" 0 "$code"
if printf '%s' "$out" | py '
import json, sys
assert json.load(sys.stdin) == {"copies": []}
'; then pass "bundle-copies reports no copies for an unknown bundle id"; else fail "bundle-copies unknown id JSON: $out"; fi

out="$("$helper" bundle-copies com.apple.finder)"; code=$?
expect_exit "bundle-copies exits 0 for Finder" 0 "$code"
if printf '%s' "$out" | py '
import json, sys
d = json.load(sys.stdin)
assert list(d) == ["copies"], list(d)
assert d["copies"], d
for c in d["copies"]:
    assert set(c) == {"path", "version"}, c
assert any(c["path"].endswith("/Finder.app") for c in d["copies"]), d
'; then pass "bundle-copies lists path + version for every copy LaunchServices knows"; else fail "bundle-copies Finder JSON: $out"; fi

if [ "$failures" -eq 0 ]; then echo "all helper tests passed"; exit 0; fi
echo "$failures helper test(s) failed"
exit 1
