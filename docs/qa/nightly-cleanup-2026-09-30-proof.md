# Nightly cleanup proof — 2026-09-30

Base: `main` at `df205007` (milestone: m2/integration into main #337).
Branch: `cursor/nightly-cleanup-dead-logic-5f88`.
Did not start from `m2/integration` or any open PR tip. Did not touch #156, draft #276, Cap/Operator, pack/Latest, or Metis.app.

Every claim is command + exit_code + path. Full logs: `/opt/cursor/artifacts/`.

## Dead / unreachable logic

Deleted production modules that FF-03 already listed as unreachable from entry points, re-verified on this tip:

- `src/renderer/src/components/ControlBar.tsx`
- `src/renderer/src/components/RecordingIndicator.tsx`
- `src/renderer/src/components/Logo.tsx`
- `src/renderer/src/lib/whisper-worklet.ts` (live path is `whisper-worklet-src.ts`)
- `src/shared/brain-analyze.ts` (no `brain:analyze` IPC; only its own test imported it)

Live `classifyMeetingSourceUse` coverage moved to `src/shared/brain.source-use.test.ts`.

```
command: rg ControlBar / RecordingIndicator / from './Logo' / whisper-worklet.ts / brain-analyze
         in src+scripts (docs and architecture-baseline excluded)
exit_code: 1
path: /opt/cursor/artifacts/dead-name-grep.log
meaning: 0 matches (ripgrep exits 1 when nothing matches)
```

```
command: npm run check:architecture
exit_code: 0
path: /opt/cursor/artifacts/architecture-check-green.log
```

Ratchet fell, then the baseline was lowered: FF-03 five files 1→0; FF-07 `thinking-orb.surfaces.test.ts` 17→16.

## Load-time / bundle-size (MEASURED)

```
command: npm run build
exit_code: 0
path: /opt/cursor/artifacts/baseline-build.log
eager JS:  out/renderer/assets/index-BOJFiUeD.js   491760
eager CSS: out/renderer/assets/index-DaRxbW4v.css  125688
```

```
command: npm run build
exit_code: 0
path: /opt/cursor/artifacts/after-build.log
eager JS:  out/renderer/assets/index-DrRjr6nn.js   476594   (−15166, −3.1%)
eager CSS: out/renderer/assets/index-CqXLuw0M.css  125005   (−683)
```

`registerProcessor('tap-worklet'` is absent from the eager index and present in `tap-worklet-src-BHh1zxHd.js`. `streamdown/styles.css` is imported only from `Markdown.tsx`.

New async chunks (not parsed on a returning-user boot: tap off, SSO not configured, license enforcement compiled off): SignInWall 6480, LicenseGate 4412, tap-worklet-src 3537, classify 2376, features 1663, gates 1636, fft 850, MantuLogo 668, mermaid CSS 361.

OnboardingV2 stays a sync import (FITO-185-J).

## Type-check / tests

```
command: npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
exit_code: 0
path: /opt/cursor/artifacts/tsc.log
```

```
command: npx vitest run src/renderer/src/components/thinking-orb.surfaces.test.ts
                  src/renderer/src/lib/tap/tap-control.audit.test.ts
                  src/shared/brain.source-use.test.ts
exit_code: 0
path: /opt/cursor/artifacts/targeted-tests.log
result: 3 files, 25 passed
```

Full `npm test` is CI-only (owner decision D-28). Not run here.

## Not claimed

Deleting unused source files does not by itself shrink the shipped renderer. Bundle wins come from lazy SignInWall/LicenseGate, deferred tap graph, and moving streamdown CSS. `mantu-mark.jpg` stays (tests read it). Cap/Operator unreachable modules left alone. #156 / draft #276 left open.

## READY TO MERGE

no
