#!/usr/bin/env bash
#
# grok-validate.sh — independent verification of PR #194, for Grok to run.
#
# Claude cannot drive Grok Bot (its daemon is inbound-only and its credential is sealed), so instead of
# Claude reporting its own marks, this runs every gate and prints a verdict Grok can read back. It is
# read-only apart from test scratch files, and it never pushes.
#
# Usage (Grok, on Tony's Mac):
#   bash /Users/tony/dev/metis-fix3/scripts/validate-dock-branch.sh
#
# What a PASS means: the branch introduces no new test failure against its own baseline, every
# typecheck project is clean, and the three reported defects are present in the code as fixes.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO="$PWD"
OUT="${TMPDIR:-/tmp}/grok-validate"
mkdir -p "$OUT"
fail=0
say() { printf '%-52s %s\n' "$1" "$2"; }

echo "=== Métis PR #194 validation ==================================="
echo "repo:   $REPO"
echo "branch: $(git rev-parse --abbrev-ref HEAD)  @ $(git rev-parse --short HEAD)"
echo

echo "--- 1. Typecheck (a red gate here is invisible to the test suite) ---"
for p in tsconfig.node.json tsconfig.web.json operator/tsconfig.json operator/client/tsconfig.json; do
  if npx tsc --noEmit -p "$p" --tsBuildInfoFile "$OUT/tsbi-${p//\//_}.json" >/dev/null 2>&1; then
    say "$p" "OK"
  else
    say "$p" "FAIL"; fail=1
  fi
done
node scripts/check-test-types.mjs >"$OUT/ctt.txt" 2>&1 \
  && say "check-test-types" "OK (at baseline)" \
  || { say "check-test-types" "FAIL — $(tail -1 "$OUT/ctt.txt")"; fail=1; }
node scripts/lock-mode-skills.mjs --check >/dev/null 2>&1 \
  && say "lock-mode-skills" "OK" || { say "lock-mode-skills" "FAIL"; fail=1; }
echo

echo "--- 2. The three reported defects, as code ---"
grep -q 'dockPanelRectAnchoredTo' src/main/island/geometry.ts \
  && say "pill does not jump when the dock opens" "PRESENT" \
  || { say "pill does not jump when the dock opens" "MISSING"; fail=1; }
grep -q 'bodyFills' src/renderer/src/components/DockPanel.tsx \
  && say "History/Review do not overlap in the dock" "PRESENT" \
  || { say "History/Review do not overlap in the dock" "MISSING"; fail=1; }
python3 - <<'PY' || fail=1
import re, sys
src = open('src/renderer/src/lib/onboarding-appearance.ts').read()
fn = src[src.index('export function onboardingChromeForPlacement'):]
fn = fn[:fn.index('\n}')]
ok = "'circle', 'jarvis', 'dock', 'dock-hidden'" in fn.replace('"', "'")
print('%-52s %s' % ('right edge offers no full bar', 'PRESENT' if ok else 'MISSING'))
sys.exit(0 if ok else 1)
PY
echo

echo "--- 3. Suites ---"
run() { # label, vitest args...
  local label="$1"; shift
  local out="$OUT/$label.json"; rm -f "$out"
  npx vitest run "$@" --reporter=json --outputFile="$out" >/dev/null 2>&1
  local rc=$?
  python3 - "$out" "$label" "$rc" <<'PY'
import json, sys, os
out, label, rc = sys.argv[1], sys.argv[2], int(sys.argv[3])
if not os.path.exists(out):
    print('%-52s %s' % (label, 'FAIL (no report; vitest exit %d)' % rc)); sys.exit(1)
d = json.load(open(out))
n, t = d['numFailedTests'], d['numTotalTests']
# A file that fails to TRANSFORM reports zero failed tests, because none of them ran. The JSON report
# alone said "0 failed" while npm test exited 1 on an unparseable suite, so vitest's exit status is
# part of the verdict, not a detail.
if rc != 0:
    print('%-52s %s' % (label, 'FAIL (vitest exit %d; %d failed of %d - a suite may have failed to load)' % (rc, n, t)))
    sys.exit(1)
print('%-52s %s' % (label, '%d failed of %d' % (n, t)))
PY
}
run root || fail=1
run proxy --config cloudflare-proxy/vitest.config.ts || fail=1
run operator --config operator/vitest.config.ts || fail=1
echo

echo "--- 4. Regression check: does this branch ADD failures vs its fork point? ---"
# The root suite is red at HEAD for reasons that predate this work (another lane's listen.* tests).
# The question that matters is whether THIS branch adds anything, so compare failing sets against the
# branch point rather than against zero.
# BASELINE CHOICE, and it took two wrong answers to get here:
#   - merge-base is wrong: it predates tests another lane added since, so those get blamed on us.
#   - origin/codex/review-release-1.9.1 is ALSO wrong: the pushed 2.0 branch has no dock at all
#     (no DockPanel.tsx, no 'dock' in the chrome enum). The dock feature lives only in an unpushed
#     local lineage, so comparing against 2.0 attributes ~36 of that lineage's commits to this branch.
# The only honest baseline is the commit THIS branch forked from. Override with BASE=<sha> if the
# branch is later rebased, or DOCK_LINEAGE=<ref> if the lineage moves.
# HEAD~N is the wrong shape for this and was wrong by the third commit: the fork point is a fixed
# commit, not a fixed distance behind HEAD. Derive it from the lineage ref instead, which stays
# correct however many commits land on top.
DOCK_LINEAGE="${DOCK_LINEAGE:-b756778a}"
BASE="${BASE:-$(git merge-base HEAD "$DOCK_LINEAGE" 2>/dev/null || echo "")}"
if [ -n "$BASE" ]; then
  WT="$OUT/base-wt"
  rm -rf "$WT"
  if git worktree add --detach "$WT" "$BASE" >/dev/null 2>&1; then
    ln -snf "$REPO/node_modules" "$WT/node_modules"
    ( cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/base.json" >/dev/null 2>&1 )
    python3 - "$OUT/root.json" "$OUT/base.json" <<'PY' || fail=1
import json, sys
def fails(p):
    d = json.load(open(p)); s = set()
    for tr in d['testResults']:
        for a in tr['assertionResults']:
            if a['status'] == 'failed':
                s.add((tr['name'].split('/')[-1], a['title']))
    return s
mine, base = fails(sys.argv[1]), fails(sys.argv[2])
new = sorted(mine - base)
print('%-52s %s' % ('failures at branch point', len(base)))
print('%-52s %s' % ('failures on this branch', len(mine)))
print('%-52s %s' % ('NEW failures introduced', len(new)))
for f, t in new[:20]:
    print('   NEW  %s :: %s' % (f, t[:70]))
sys.exit(1 if new else 0)
PY
    git worktree remove --force "$WT" >/dev/null 2>&1
  else
    say "baseline worktree" "SKIPPED (could not create)"
  fi
else
  say "baseline" "SKIPPED (origin/codex/review-release-1.9.1 unavailable)"
fi
echo

if [ "$fail" -eq 0 ]; then
  echo "VERDICT: PASS — gates clean, three defects present as fixes, no new failures."
else
  echo "VERDICT: FAIL — see the lines marked FAIL or MISSING above."
fi
exit "$fail"
