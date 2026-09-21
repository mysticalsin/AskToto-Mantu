# Métis 2.0 — handoff to the Integrator

Date: 2026-09-20 · Visionary: Claude · Integrator: Codex · Owner: Tony
Revision 2 — rev 1 was reviewed and returned REVISE with three blockers, all of which were
correct. What changed is listed in §6.

Purpose: everything built in the right-edge dock lane, stated so 2.0 can carry it, with each
claim checkable against the tree rather than against this document.

---

## 1. Branch topology

```
origin/codex/review-release-1.9.1   83d9d3fa   NO dock: no DockPanel.tsx, no 'dock' in the enum
        └── cursor/cap4-glass-sidecar 9fb913f1  (= the LOCAL codex/review-release-1.9.1 ref)
                └── metis-2.0-dock-lineage b756778a   37 commits ahead of 83d9d3fa
                        └── claude/dock-three-fixes    PR #194, 6 commits ahead of b756778a
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

`83d9d3fa` is green on its own (6267 tests). The dock lineage arrived with 63 failures, now 0.

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

### NOT in this lineage, despite rev 1 of this document saying so

**Intelligence "notes are nodes" is NOT here.** At this HEAD, `brainAdapter.ts` has
`keepTypes = {account, person, deal, sector}` and meeting nodes are dropped — with tests
asserting that. The change lives only on `origin/claude/intelligence-relationship-notes`
(PR #187), which is **not** an ancestor of the lineage, and what it adds is `'meeting'`, not
`'note'`. Rev 1 claimed it as built and named the wrong node type. Treat PR #187 as an
independent lane to be decided on its own.

## 3. Test state, with the evidence attached

`docs/evidence/dock-lane-qa-2026-09-20.txt` holds the captured runs, with per-command exit
status, rather than asking you to take the numbers on trust:

```
npm run typecheck   EXIT=0    check-test-types at its 26 baseline
npm test            EXIT=0    527 files · 6392 passed · 17 skipped
                              proxy 1 file · 28 passed
                              operator 91 files · 965 passed
license-server                101 pass / 0 fail   (needs its own npm ci and real sockets)
```

The lineage went 65 → 0 failures. The largest single cause was `listen.ts` writing
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
- **`QA_TIP.txt`** (flagged in PR #190, deliberately NOT changed) — it disables content
  protection with no packaged-build gate, unlike `ASKTOTO_DISABLE_CP`, which routes through
  `devEnv()`. A shipped build carrying that file would have protection off. A decision, not a
  cleanup, which is why it was left here.
- **Managed config** — `dockRest` and `overlayPlacement` are lockable through the schema and
  settings, but the managed-config docs and sample do not name the new keys, so fleet policy
  carry-forward is undocumented.
- **PR #187 (Intelligence)** — an independent lane, see §2.

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
