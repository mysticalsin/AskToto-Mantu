# Métis 2.0 — handoff to the Integrator

Date: 2026-09-20 · Visionary: Claude · Integrator: Codex · Owner: Tony
Revision 3 — rev 1 was reviewed and returned REVISE with three blockers, all of which were
correct; rev 2 answered them (§6). Rev 3 records that four of the gaps rev 2 merely *reported*
are now closed in the lineage itself (§7).

Purpose: everything built in the right-edge dock lane, stated so 2.0 can carry it, with each
claim checkable against the tree rather than against this document.

---

## 1. Branch topology

```
origin/codex/review-release-1.9.1   83d9d3fa   NO dock: no DockPanel.tsx, no 'dock' in the enum
        └── cursor/cap4-glass-sidecar 9fb913f1  (= the LOCAL codex/review-release-1.9.1 ref)
                └── metis-2.0-dock-lineage b756778a   37 commits ahead of 83d9d3fa
                        └── claude/dock-three-fixes    PR #194 — `git rev-list --count b756778a..HEAD`
```

**Two different commits answer to the name `codex/review-release-1.9.1` in this checkout.** The
remote branch is `83d9d3fa` and has no dock. The local branch of the same name is `9fb913f1`,
which is `cursor/cap4-glass-sidecar`, and it *does* contain `DockPanel.tsx` and `'dock'`. Any
sentence about "the 2.0 line" is ambiguous until that is resolved — see decision 0 in §4.

Verify:
```
git rev-parse origin/codex/review-release-1.9.1 codex/review-release-1.9.1
git show origin/codex/review-release-1.9.1:src/shared/overlay-chrome.ts | grep -c dock   # 0
git rev-list --count 83d9d3fa..b756778a                                                   # 37
```

The dock lineage's fork point carried **63 failing tests**; this branch carries 0. That number is
not a recollection — `scripts/validate-dock-branch.sh` measures it on every run by checking out
the fork point in a throwaway worktree, and its output is in the evidence file. (An earlier draft
of this document said 65; 63 is the measured figure and the one to trust.)

No claim is made here about how `83d9d3fa` scores on its own. It was green when last run, but that
run predates this evidence file and is not re-verified in it, so it should not be cited as a
baseline without re-running.

## 2. What was built (verified present at `claude/dock-three-fixes` HEAD)

**Right-edge dock chrome.** A fourth overlay layout (`hide | island | bar | dock`) that lives on
the right edge as a panel rather than a stretched bar. Placement (`top-center | right-edge`)
stays a separate axis from chrome, so "where" is never encoded in "what".

- `src/main/island/geometry.ts` — `OVERLAY_DOCK_PANEL` 380x560, `OVERLAY_DOCK_SLIVER` 10x104,
  `dockSliverRect()`, `dockPanelRectAnchoredTo()`. A dock forces its *requested* placement to
  `right-edge` before `resolveOverlayPlacement()`. Note the remaining case, which is deliberate
  and not a bug: `resolveOverlayPlacement` still returns `top-center` when the display is too
  narrow for the panel (`rightEdgePlacementFits`), so "a dock is always on the right edge" is
  true of the request, not of the outcome on a narrow display.
- `src/renderer/src/components/DockPanel.tsx` — its own surface, not Bar with different CSS:
  header / body / composer zones, a live strip, copy and new-meeting tools, and the mode sheet
  rendered inside the panel rather than over it.
- Invisible rest (`dockRest: 'sliver' | 'hidden'`, default `sliver`). Opacity is the ONLY
  difference between the two — the hover band and the parked window are identical rects, so an
  invisible dock is exactly as reachable as a visible one. Pinned in
  `src/main/island/dock-invisible.test.ts`. That is the one contract not to "optimise" later.

**Transcript rebuild** — `src/renderer/src/lib/transcript-view.ts` + `Copilot.tsx`. Height comes
from the DISPLAY (`0.62` share, 360px floor), never `vh`: the overlay self-sizes to its content,
so a height expressed as a fraction of the window feeds its own input. Plus `isFollowingTail()`
(an arriving line may scroll the view only if the reader is already at the bottom),
speaker-identity grouping, and elapsed `mm:ss` from the session's first line.

**Onboarding placement step** — the style row derives from the placement choice.
`onboardingChromeForPlacement('right-edge')` cannot offer a full bar, and `chromeSettingsPatch`
writes `dockRest` so a style pick cannot leave a stale rest behind.

**Force-quit contract** — `src/main/index.ts`. `forceQuitMétis()` gives `app.quit()` a 4s grace,
then stops the sidecars (screenPreprocess, localRuntime, fmRuntime, endBootWatch — each in its
own try) and calls `app.exit(0)`. A second call during the grace window exits immediately.

**Content-protection audit unblinding** (PR #190) — the audit no longer reports a stub.

**Intelligence: notes are nodes** — `intelligence/src/lib/brainAdapter.ts`, `GraphView.tsx`.
`keepTypes` now includes `'meeting'`, and the bundled `data.example.json` carries meeting notes
so the fallback shows the feature rather than an empty board. Rev 1 claimed this while it was
absent; rev 2 corrected the claim; it is now actually here, cherry-picked from PR #187's two
commits (`f6b40875`, `f589b459`). Note the node type is `'meeting'`, not `'note'`.

**QA_TIP is packaging-gated** — `src/main/intelligence.ts`. `Resources/QA_TIP.txt` can no longer
strip content protection from the Intelligence window in a packaged build
(`!isPackagedBuild() && existsSync(qaTip)`), which is the same fail-closed shape as
`ASKTOTO_DISABLE_CP`. Cherry-picked from `a5eb53dc` (PR #192). This mattered: that window's
preload can read the decrypted brain, and the old behaviour left the most sensitive aggregated
view screen-capturable while Private View still appeared to be on.

**Managed config names the overlay keys** — `build/managed-config.example.json` plus
`src/main/managed-config-example.contract.test.ts`. `overlayPlacement`, `overlayLayout` and
`dockRest` were always lockable, since managed config takes any top-level settings key, but the
sample never named them. The new contract test checks both samples against the real schema in
both directions, so a policy file can no longer name a key the app does not read — which fails
silently, leaving a fleet unmanaged with no error.

## 3. Test state, with the evidence attached

`docs/evidence/dock-lane-qa-2026-09-20.txt` holds the captured runs, with per-command exit
status, rather than asking you to take the numbers on trust:

```
npm run typecheck   EXIT=0    check-test-types at its 26 baseline
npm test            EXIT=0    529 files · 6412 passed · 17 skipped
                              proxy 1 file · 28 passed
                              operator 91 files · 965 passed
license-server                101 pass / 0 fail   (needs its own npm ci and real sockets)
```

The largest single cause of the fork point's 63 failures was `listen.ts` writing
`document.documentElement.dataset.metisListening` directly in five places with no jsdom guard;
one `setListeningFlag()` helper cleared 56 of them.

**The verification lesson, which matters more than the numbers.** A file that fails to TRANSFORM
reports **zero** failed tests, because none of them ran — so a broken suite reads as green while
`npm test` exits 1. That happened here in `onboarding-appearance.test.ts` and survived several
"green" reports of mine. `scripts/validate-dock-branch.sh` now treats vitest's exit status as
part of the verdict. If you adopt any of this tooling, adopt that with it.

That script compares failures against the lineage fork point — not the merge-base (predates
tests other lanes added since) and not 2.0's tip (no dock there, so ~36 lineage commits get
blamed on this branch). Its baseline is now derived as `git merge-base HEAD $DOCK_LINEAGE`
(default `b756778a`); it previously defaulted to `HEAD~2`, which silently stopped pointing at
the fork as soon as more commits landed. Override with `BASE=<sha>` or `DOCK_LINEAGE=<ref>`.

### PR numbers, and what is actually checkable

Branch and commit relationships are checkable from local refs. **PR *identities* are not** — the
mapping below comes from `gh pr list`, not from the repository. The captured output is committed at
`docs/evidence/pr-mapping-2026-09-20.txt`, since a reviewer without network access cannot re-run it:

| PR | head branch | base |
|---|---|---|
| #194 | `claude/dock-three-fixes` | `metis-2.0-dock-lineage` |
| #193 | `claude/cap4-motion` | `release/1.9.1` |
| #192 | `fix/cap3-qa-tip-cp-packaged-gate` | `codex/review-release-1.9.1` |
| #191 | `cursor/cap4-glass-sidecar` | `main` |
| #190 | `claude/content-protection-stub` | `codex/review-release-1.9.1` |
| #189 | `claude/force-quit-contract` | `codex/review-release-1.9.1` |
| #188 | `claude/dock-panel-design` | `codex/review-release-1.9.1` |
| #187 | `claude/intelligence-relationship-notes` | `codex/review-release-1.9.1` |

Note #193 targets `release/1.9.1` and #191 targets `main`, so "they all need one base" (§4.3) is
about more than the four that target `codex/review-release-1.9.1`.

## 4. Decisions needed before anything downstream merges

0. **Which ref is "2.0".** `origin/codex/review-release-1.9.1` (83d9d3fa, no dock) and the local
   branch of that name (9fb913f1, has dock) are different commits in different dock states.
   Nothing else in this list can be answered until this one is.
1. **Which DockPanel is authoritative.** Rev 1 called this a three-way collision; checked against
   local refs, it is not. `cursor/cap4-glass-sidecar` (#191, 9fb913f1) is an **ancestor** of the
   lineage, so it is already in. `origin/claude/cap4-motion` (#193) is 6 commits ahead of the
   lineage with no post-`b756778a` `DockPanel.tsx` change. So the live question is narrower:
   does #193 land on top of the lineage, or is its motion work re-applied?
2. **Does 2.0 take the dock**, and by merging `metis-2.0-dock-lineage` (37 commits) or by
   cherry-picking. It cannot be assumed present, given decision 0.
3. **PR consolidation.** #187 #188 #189 #190 target `codex/review-release-1.9.1` and predate the
   lineage push; #194 targets the lineage. They need one base.
4. **Whether managed-config docs ship with the dock** — see §5.

## 5. Open, not done

- **Portal restructure** — Owner approved a portal rail plus a full IA restructure of the
  Cloudflare Worker Operator portal. Recon done; no code written. The `client.generated.ts`
  staleness gate means regenerating it in the same commit as any client change.
- **Decision 0 in §4** is still open and still blocks the rest.

Closed since rev 2, and now in this lineage rather than reported as gaps: Intelligence
notes-as-nodes, the QA_TIP packaging gate, and the managed-config overlay keys — all in §2.

## 6. What changed from rev 1

Rev 1 was reviewed read-only by the Integrator and returned `VERDICT: REVISE`. Every finding
below was independently re-checked against the tree before being accepted; all held.

- **blocker, capability_false** — "notes are nodes" claimed as built. It is not in this lineage
  at all. Corrected in §2, with what is actually true about PR #187.
- **blocker, missing_evidence** — test counts had no committed artifact. Now
  `docs/evidence/dock-lane-qa-2026-09-20.txt`.
- **blocker, missing_evidence** — rev 1 asserted "parallel agents wiped each other's work 6+
  times". That is a session observation with no basis anyone can check in the repo, so it is
  removed rather than restated; it was being used as an argument, and it could not carry one.
- **risk, topology_ambiguous** — the two different `codex/review-release-1.9.1` commits are now
  decision 0.
- **risk, pr_collision_overstated** — #191 is an ancestor, not a rival. §4 rewritten.
- **risk, validation_script_baseline** — `BASE` defaulted to `HEAD~2` and had already drifted off
  the fork point. Now derived with `git merge-base`.
- **risk, capability_wording** — the narrow-display `top-center` fallback is now stated in §2.
- **risk, missing_enterprise_doc** — managed-config gap added to §5.
- **nit, topology_doc_stale** — commit count corrected (6, not 5; the doc is itself a commit).

## 7. What changed in rev 3

Rev 2 was an accurate document about an incomplete lineage. Rev 3 closes the gaps rather than
describing them, so 2.0 inherits working code instead of a to-do list.

| Was | Now |
|---|---|
| "notes are nodes" absent (rev 1 wrongly claimed it) | cherry-picked from PR #187; `keepTypes` includes `'meeting'`, example data carries notes |
| `QA_TIP.txt` ungated — a packaged build would ship with Intelligence content protection off | gated on `!isPackagedBuild()`, cherry-picked from `a5eb53dc` (PR #192), 3 contract tests |
| Overlay keys undocumented for fleet policy | named in `managed-config.example.json`, with a contract test pinning both samples to the schema |
| `BASE=HEAD~2` had drifted off the fork point | derived via `git merge-base HEAD $DOCK_LINEAGE` |

Verified end to end at `04ae90d6`, which is the last commit touching code — everything after it
changes only `docs/`, so the coverage is current: `npm run typecheck` EXIT=0 · `npm test` EXIT=0 (529 files /
6412 passed / 17 skipped, proxy 28, operator 965) · licence-server 101/101 ·
`scripts/validate-dock-branch.sh` PASS with 0 new failures against the fork point (63 → 0).

Two of those four were found by the Integrator's read-only review rather than by me, and the
managed-config contract test found four more keys on its first run — all four turned out to be
legitimate governance keys, so the samples were right and the test's first draft was wrong.

## 8. What round 2 of the review changed

The Integrator reviewed rev 2 and returned REVISE again. Four findings survived the fact that it
was reading `cf5ac3be` while the tree had already moved on, and all four were taken:

- **`83d9d3fa` is green with 6267 tests** — asserted with no artifact behind it. The claim is
  removed rather than restated; see §1.
- **licence-server 101/101 was not in the evidence file** — the evidence file now runs it, and the
  regression gate, and records an EXIT line for each.
- **63 vs 65 failures** — the document contradicted itself. 63 is the measured figure, produced by
  the validator on every run; 65 is gone.
- **PR identities are not checkable from the repo** — now stated as such, with the `gh pr list`
  mapping and a pointer to re-run it.

It also found the validator's remaining half-blindness: the branch run was gated on vitest's exit
code but the **baseline** run was not, so a baseline that failed to load would have understated
itself and made this branch look worse. Both halves are gated now, and the baseline's collected
test total is checked against the branch's.

The rest of round 2's findings were rev 2 statements that rev 3 had already overtaken —
notes-as-nodes, the managed-config keys and the QA_TIP gate are all in the tree now, which is what
§7 records.
