# Métis 2.0 — handoff to the Integrator

Date: 2026-09-20 · Visionary: Claude · Integrator: Codex · Owner: Tony

Purpose: everything built in the right-edge dock lane, stated so 2.0 can carry it. Read the
**Decisions Codex must make** section last but treat it first — three of them change what the
rest of this document is worth.

---

## 1. The branch topology, because this is the part that is easy to get wrong

```
origin/codex/review-release-1.9.1   83d9d3fa   the 2.0 line Codex is building.  HAS NO DOCK.
        └── metis-2.0-dock-lineage  b756778a   +37 commits.  The dock feature, all of it.
                └── claude/dock-three-fixes   86287ee2  +5 commits.  PR #194.
```

The single most important fact here: **`codex/review-release-1.9.1` contains no dock at all** —
no `DockPanel.tsx`, and no `'dock'` member in the overlay chrome enum. Every dock commit lived
in an unpushed local lineage until it was pushed as `metis-2.0-dock-lineage`. If 2.0 is built
from `codex/review-release-1.9.1` as it stands today, none of the work below is in it.

That branch is also, on its own, green (6267 tests). The dock lineage arrived with 63 failures,
which are now 0 — see §3.

## 2. What was built

**Right-edge dock chrome.** A fourth overlay layout (`hide | island | bar | dock`) that lives on
the right edge as a panel rather than a stretched bar. Placement (`top-center | right-edge`)
stays a separate axis from chrome on purpose, so nothing about "where" is encoded in "what".

- `src/main/island/geometry.ts` — `OVERLAY_DOCK_PANEL` 380x560, `OVERLAY_DOCK_SLIVER` 10x104,
  `dockSliverRect()`, `dockPanelRectAnchoredTo()`. A dock resolves its placement to
  `right-edge` unconditionally; choosing Dock while placement still said `top-center` used to
  centre the sliver horizontally and leave a pill floating mid-screen.
- `src/renderer/src/components/DockPanel.tsx` — its own surface, not Bar with different CSS:
  header / body / composer zones, a live strip, copy and new-meeting tools, and the mode sheet
  rendered inside the panel instead of over it.
- Invisible rest (`dockRest: 'sliver' | 'hidden'`, default `sliver`). Opacity is the ONLY
  difference between the two — the hover band and the parked window are identical rects, so an
  invisible dock is exactly as reachable as a visible one. That contract is pinned in
  `src/main/island/dock-invisible.test.ts`; it is the one thing not to "optimise" later.

**Transcript rebuild** — `src/renderer/src/lib/transcript-view.ts` + `Copilot.tsx`. Height is
derived from the DISPLAY (`0.62` share, 360px floor), never `vh`: the overlay self-sizes to its
content, so a height expressed as a fraction of the window feeds its own input. Plus
`isFollowingTail()` (an arriving line may only scroll the view if the reader is already at the
bottom), speaker-identity grouping, and elapsed `mm:ss` from the session's first line.

**Onboarding placement step** — the style row is now derived from the placement choice.
`onboardingChromeForPlacement('right-edge')` cannot offer a full bar, and `chromeSettingsPatch`
writes `dockRest` so a style pick cannot leave a stale rest behind.

**Intelligence: notes are nodes** — `intelligence/src/lib/brainAdapter.ts`, `GraphView.tsx`
(PR #187). Notes appear in Relationships as first-class nodes.

**Force-quit contract** — `src/main/index.ts`. `forceQuitMétis()` gives `app.quit()` a 4s grace,
then stops the sidecars (screenPreprocess, localRuntime, fmRuntime, endBootWatch — each in its
own try) and `app.exit(0)`. A second call during the grace window exits immediately.

**Content-protection audit unblinding** (PR #190) — the audit no longer reports a stub.

## 3. Test state, and one honest note about how it was verified

At `86287ee2`, run by hand:

```
npm run typecheck   exit 0   (check-test-types at its 26 baseline)
npm test            exit 0   527 files · 6392 passed · 17 skipped
proxy                        28 passed
operator                     965 passed
license-server               101 pass / 0 fail
```

The lineage went 65 → 0 failures. The largest single cause was `listen.ts` writing
`document.documentElement.dataset.metisListening` directly in five places with no jsdom guard;
one `setListeningFlag()` helper cleared 56 of them.

The honest note: for much of this work I read vitest's JSON report and trusted `numFailedTests`.
A file that fails to TRANSFORM reports **zero** failed tests, because none of them ran — so a
broken suite read as green while `npm test` exited 1. That happened here, in
`onboarding-appearance.test.ts`, and `86287ee2` both repairs the file and teaches
`scripts/validate-dock-branch.sh` to treat vitest's exit status as part of the verdict. If you
adopt any of my tooling, adopt that lesson with it.

`scripts/validate-dock-branch.sh` is runnable by anyone and compares failures against the
branch's **fork point** — not the merge-base (predates tests other lanes added since) and not
2.0's tip (which has no dock, so ~36 lineage commits get blamed on this branch). Both wrong
baselines were tried before the right one.

## 4. Decisions Codex must make

1. **Which DockPanel is authoritative.** At least three lanes have written one: this lineage,
   PR #191 (`cursor/cap4-glass-sidecar`, "Bar-DNA glass DockPanel") and PR #193
   (`claude/cap4-motion`). Parallel agents wiped each other's work on this file 6+ times during
   the session. Nothing downstream is safe to merge until one is picked. This is the blocker.
2. **Does 2.0 take the dock at all**, and if so by merging `metis-2.0-dock-lineage` (37 commits)
   or by cherry-picking. It cannot be assumed present.
3. **PR consolidation.** #187 #188 #189 #190 all target `codex/review-release-1.9.1` and predate
   the lineage push; #194 targets the lineage. They need one base.

## 5. Open, not done

- **Portal restructure** — Owner approved a portal rail plus a full IA restructure of the
  Cloudflare Worker Operator portal. Recon is done; no code written. Note the
  `client.generated.ts` staleness gate: regenerate it in the same commit as any client change.
- **`QA_TIP.txt`** (flagged in PR #190, deliberately NOT changed) — it disables content
  protection with no packaged-build gate, unlike `ASKTOTO_DISABLE_CP`, which routes through
  `devEnv()`. A shipped build carrying that file would have protection off. This is a decision,
  not a cleanup, which is why it was left for you.
