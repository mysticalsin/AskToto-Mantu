# Meeting-bar remaining gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining gaps of the approved spec `docs/superpowers/specs/2026-07-02-meeting-bar-states-pause-stop-design.md` — explicit Stop icon, "Paused" chip, ControlPill redesign with live timer, renderer-backgrounding switch, and visible backpressure drops.

**Architecture:** Pure renderer UI work in `Bar.tsx` / `ControlPill.tsx` / `App.tsx` plus two small hardening edits (`src/main/index.ts` startup switch, `listen.ts` drop surfacing). The heavy lifting (real pause/resume in `useListen`, powerSaveBlocker, meeting-only pill row) already landed in commit `6679db1` and successors — do NOT reimplement it.

**Tech Stack:** Electron + React + Tailwind classes, lucide-react icons, vitest.

## Global Constraints

- No existing toolbar control may be removed or moved (center cluster, minimize, chevron, New meeting, Transcript, History, MantuMark).
- No renderer test harness exists (vitest covers `src/shared` + `src/main` only) — each task's gate is `npm run typecheck` + `npm test` green, plus the live QA in Task 4.
- Match surrounding code style: comment density, Tailwind token vars (`--color-danger`, `--color-ink-3`, etc.), `ICON_STROKE` for lucide strokes.
- These files were recently edited by a parallel session — **Read every file before editing; line numbers below are anchors, not gospel.**

## Already done — verify, don't build

- `listen.ts`: `paused` state + `pause()`/`resume()` via `AudioContext.suspend()` (streams stay warm); `pushAudio` ignores windows while paused.
- `Bar.tsx`: `paused`/`onTogglePause` props, Pause/Play button in the reserved slot, `ElapsedClock` excluding paused time, rec-dot dims while paused.
- `App.tsx:1464`: `QuickActions` renders only while `listen.listening` (hint prop already removed).
- `src/main/index.ts:743-753`: `setRecordingPowerSaveBlock()` on the listening-state IPC.

---

### Task 1: Bar — explicit Stop button + "Paused" chip

**Files:**
- Modify: `src/renderer/src/components/Bar.tsx` (reserved timer slot ~line 437-459; "Heard live" chip ~line 274-280; lucide imports ~line 1-19)

**Interfaces:**
- Consumes: existing `props.onToggleListen` (ends the meeting), `props.paused`.
- Produces: nothing new — UI only.

- [ ] **Step 1: Add `Square` to the lucide-react import list** at the top of `Bar.tsx` (alongside `Pause`, `Play`).

- [ ] **Step 2: Add the Stop button and widen the reserved slot.** In the fixed-width slot (`<div className="flex w-[72px] items-center gap-2">`), change `w-[72px]` to `w-[100px]` and append a Stop button after the Pause/Play button, inside the same `{props.listening && (<>...</>)}` fragment:

```tsx
                  {/* Stop — ends the meeting (recap + save), identical to the rec-dot above; an explicit
                      square makes "end" discoverable next to Pause instead of hiding behind the dot. */}
                  <button
                    type="button"
                    title="Stop & end meeting"
                    aria-label="Stop and end meeting"
                    onClick={props.onToggleListen}
                    className="no-drag focus-ring grid place-items-center rounded-[10px] p-1 text-[color:var(--color-danger)] transition-colors duration-[var(--duration-hover)] hover:brightness-125"
                  >
                    <Square size={14} strokeWidth={ICON_STROKE} fill="currentColor" />
                  </button>
```

- [ ] **Step 3: "Paused" chip variant.** Replace the body of the `{props.listening && (...)}` "Heard live" chip so it flips while paused (keep the existing wrapper span classes):

```tsx
          {props.listening && (
            <span className="flex flex-none items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-[color:var(--color-ink-2)]">
              {props.paused ? (
                <>
                  <Pause size={11} strokeWidth={ICON_STROKE} className="text-[color:var(--color-warn,#fac775)]" />
                  Paused
                </>
              ) : (
                <>
                  <span className="h-[6px] w-[6px] rounded-full bg-[var(--color-danger)]" />
                  <AudioLines size={11} strokeWidth={ICON_STROKE} />
                  Heard live
                </>
              )}
            </span>
          )}
```

  Check `src/renderer/src/styles.css` for an existing warn/amber token (`--color-warn` or similar); if none exists, use the literal `#fac775` via an inline class as shown.

- [ ] **Step 4: Gate** — run `npm run typecheck` (expect clean) and `npm test` (expect all pass, no renderer tests affected).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Bar.tsx
git commit -m "Bar: explicit Stop button beside Pause; Heard-live chip flips to Paused"
```

### Task 2: ControlPill redesign — recording feedback while minimized

**Files:**
- Modify: `src/renderer/src/components/Bar.tsx` (export `ElapsedClock`)
- Modify: `src/renderer/src/components/ControlPill.tsx` (full rewrite of the JSX)
- Modify: `src/renderer/src/App.tsx` (~line 1409 `<ControlPill …>` call site)

**Interfaces:**
- Consumes: `ElapsedClock({ startedAt: number; paused: boolean })` from Bar.tsx (Task 2 exports it); `listen.paused`, `meetingStartRef.current`, `onTogglePause` — all already exist in App.tsx.
- Produces: new `ControlPill` props: `paused: boolean`, `startedAt: number`, `onTogglePause: () => void` (existing props unchanged).

- [ ] **Step 1: Export the clock.** In `Bar.tsx`, change `const ElapsedClock = memo(function ElapsedClock({` to `export const ElapsedClock = memo(function ElapsedClock({`.

- [ ] **Step 2: Rewrite `ControlPill.tsx`.** Keep the doc comment style, drag behavior, and `data-hug-width` exactly; replace layout per the approved design — idle: mark · mic · divider · ghost ✕; recording: mark · rec-dot · timer · pause/play · stop · divider · ghost ✕:

```tsx
import { X, Mic, Pause, Play, Square } from 'lucide-react'
import { MantuMark } from './MantuMark'
import { ElapsedClock } from './Bar'
import { useWindowDrag } from '../lib/window-drag'

/**
 * Collapsed control mini-pill (Cluely's second window). Shown instead of the full widget when the
 * overlay is minimized: the Mantu mark expands it back, the ghost ✕ fully hides the window (a global
 * hotkey restores it), and the mic starts Listen. While recording, the pill carries the live timer +
 * pause/stop so the meeting stays controllable — and visibly alive — without expanding. Draggable
 * like the main widget.
 */
export function ControlPill({
  onExpand,
  onHide,
  onToggleListen,
  onTogglePause,
  listening,
  paused,
  startedAt
}: {
  onExpand: () => void
  onHide: () => void
  onToggleListen: () => void
  onTogglePause: () => void
  listening: boolean
  paused: boolean
  startedAt: number
}): JSX.Element {
  const drag = useWindowDrag()
  return (
    // data-hug-width: lets useAutoResize report this element's own shrink-to-fit width to the window
    // instead of the wider fixed guess — without it, the window stayed wider than the visible pill and
    // silently swallowed clicks meant for whatever app was behind that invisible margin.
    <div {...drag} data-hug-width className="aw-pill inline-flex items-center gap-2 p-1.5">
      <button
        type="button"
        title="Expand AskToto"
        aria-label="Expand AskToto"
        onClick={onExpand}
        className="no-drag focus-ring block shrink-0 rounded-[8px]"
      >
        <span className="aw-mark-glow block rounded-[8px]">
          <MantuMark size={30} />
        </span>
      </button>
      {listening ? (
        <>
          <span
            className={[
              'h-[9px] w-[9px] shrink-0 rounded-full',
              paused
                ? 'bg-[color:var(--color-ink-3)]'
                : 'rec-dot bg-[var(--color-danger)] shadow-[0_0_8px_var(--color-danger)]'
            ].join(' ')}
          />
          <ElapsedClock startedAt={startedAt} paused={paused} />
          <button
            type="button"
            title={paused ? 'Resume recording' : 'Pause recording'}
            aria-label={paused ? 'Resume recording' : 'Pause recording'}
            onClick={onTogglePause}
            className="no-drag focus-ring grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[color:var(--color-ink-2)] transition-colors hover:bg-white/10 hover:text-[color:var(--color-ink)]"
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button
            type="button"
            title="Stop & end meeting"
            aria-label="Stop and end meeting"
            onClick={onToggleListen}
            className="no-drag focus-ring grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[color:var(--color-danger)] transition-colors hover:bg-[var(--color-danger-soft)]"
          >
            <Square size={13} fill="currentColor" />
          </button>
        </>
      ) : (
        <button
          type="button"
          title="Start listening"
          aria-label="Start listening"
          onClick={onToggleListen}
          className="no-drag focus-ring grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-white/[0.06] text-[color:var(--color-ink-2)] transition-colors hover:bg-white/10 hover:text-[color:var(--color-ink)]"
        >
          <Mic size={16} />
        </button>
      )}
      <span className="h-[16px] w-px shrink-0 bg-white/10" />
      <button
        type="button"
        onClick={onHide}
        title="Hide AskToto"
        aria-label="Hide AskToto"
        className="no-drag focus-ring grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full text-[color:var(--color-ink-3)] transition-colors hover:bg-white/10 hover:text-[color:var(--color-ink)]"
      >
        <X size={14} />
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Pass the new props at the App.tsx call site** (~line 1409). Read the current call first; add three props:

```tsx
          <ControlPill
            listening={listen.listening}
            paused={listen.paused}
            startedAt={meetingStartRef.current}
            onTogglePause={onTogglePause}
            onToggleListen={toggleListen}
            onExpand={() => {
              setMinimized(false)
              void window.toto.minimize(false) // widen the window back to the full widget
            }}
            // Fully hide the window (a global hotkey restores it); reset so it reopens as the full widget.
            onHide={() => {
              setMinimized(false)
              void window.toto.minimize(false)
              void window.toto.hide()
            }}
          />
```

  `onExpand`/`onHide` bodies above are the CURRENT ones from the call site — keep them verbatim if they differ only in comments; if the parallel session changed their logic, keep the on-disk logic and only add the three new props.

  `onTogglePause` is defined at ~App.tsx:886 — if it is declared *after* line 1409 in the file order, it's still fine (it's a `useCallback` const used inside JSX of the same render). Verify it exists; do not create a duplicate.

- [ ] **Step 4: Gate** — `npm run typecheck` clean, `npm test` all pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Bar.tsx src/renderer/src/components/ControlPill.tsx src/renderer/src/App.tsx
git commit -m "ControlPill: live timer + pause/stop while recording, ghost hide button"
```

### Task 3: Hardening — renderer-backgrounding switch + visible backpressure drops

**Files:**
- Modify: `src/main/index.ts` (module top-level, after imports, before `app.whenReady()`)
- Modify: `src/renderer/src/lib/listen.ts` (`pushAudio`, ~line 409-422; message constants block ~line 22-43)

**Interfaces:**
- Consumes: existing `setState` in `useListen`, existing sticky-note exact-string contract.
- Produces: exported const `DROPPED_MSG` (renderer), no API changes.

- [ ] **Step 1: Startup switch.** In `src/main/index.ts`, immediately after the import block (find the first top-level statement after imports), add:

```ts
// Belt-and-braces with the per-meeting powerSaveBlocker below: keep Chromium itself from ever
// deprioritizing the (hidden) renderer that hosts the transcription worker. Must run before app ready.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
```

  Verify `app` is already imported from 'electron' (it is, in the first import block).

- [ ] **Step 2: Drop surfacing.** In `listen.ts`, add to the sticky-note constants block (near `THEM_SILENT_MSG` etc.):

```ts
// Backpressure became user-visible truncation: transcription fell behind capture long enough that
// audio windows were discarded. Exact-string contract like the other sticky notes.
const DROPPED_MSG = 'Transcription fell behind — some audio was skipped. The transcript may have gaps.'
```

  Then in `pushAudio`, inside the `if (queue.current.length > MAX_QUEUE)` branch, after the existing `console.warn`, add:

```ts
        // Surface it — a silent drop reads as "the transcript stopped" with no explanation. Never
        // clobber a more specific note already showing (offline, device-lost, them-silent).
        setState((s) => (s.error == null ? { ...s, error: DROPPED_MSG } : s))
```

  Add `setState` to the `pushAudio` useCallback dependency array only if the linter/typecheck requires it (React state setters are stable).

- [ ] **Step 3: Gate** — `npm run typecheck` clean, `npm test` all pass (the vm syntax-check test on the worklet blob must stay green).

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/renderer/src/lib/listen.ts
git commit -m "Hardening: disable renderer backgrounding at startup; surface audio backpressure drops"
```

### Task 4: Live verification

**Files:** none (verification only)

- [ ] **Step 1:** `npm run typecheck && npm test` — both green.
- [ ] **Step 2:** Launch dev app (`npm run dev`). Idle: bar only, nothing underneath. Start Listen: rainbow pills appear under the bar; timer + ⏸ + red ⏹ in the toolbar slot; "Heard live" chip.
- [ ] **Step 3:** Pause: chip flips to "Paused", timer freezes, rec-dot dims. Speak — no new transcript lines. Resume: instant, lines flow again, timer excludes the gap.
- [ ] **Step 4:** Minimize to pill while recording: pill shows rec-dot + ticking timer + ⏸ ⏹ + ghost ✕. Pause/stop work from the pill. Stop → recap/review appears.
- [ ] **Step 5:** `pmset -g assertions | grep -i asktoto` while listening → PreventUserIdleSystemSleep/NoIdleSleep assertion present; gone after stop.
- [ ] **Step 6:** Report results with real output; do not claim done without them.
