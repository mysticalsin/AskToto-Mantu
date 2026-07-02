# Meeting-bar states, real Pause/Stop, minimize-survival fix, ControlPill redesign

Date: 2026-07-02
Status: approved (design mockups reviewed by Tony; correction round applied: no existing toolbar control is removed)

## Context

The floating bar currently shows the four quick-action pills ("What to say next", "Fact-check",
"Explain", "Summarize screen") when the app is **idle**, and hides them during a meeting (they move
inside the Copilot card). Tony wants the inverse. Separately: the "pause" button during a meeting is
fake (it stops the meeting), transcript capture silently degrades ~4 minutes after the window is
hidden/minimized, and the minimized ControlPill layout is unbalanced with zero recording feedback.

No existing toolbar control is removed by this work. The full center cluster (Capture, Spotlight
Ref, Mode, Deep thinking, Private view), the Minimize-to-pill icon, the collapse chevron, the
MantuMark logo, and the New meeting / Transcript / History pills all stay exactly where they are.

## A. Quick-action pill row flips to meeting-only

Current condition ([App.tsx:1291](../../../src/renderer/src/App.tsx)):

```
view === 'answer' && body == null && !listen.listening
```

New condition:

```
listen.listening && barBody == null && !isPanelBody
```

i.e. the rainbow `QuickActions` row renders under the bar **only during a live meeting** whenever no
expanded content (answer body inside the bar, or panel below it) is showing. Concretely:

- App open, idle → bar only. Nothing under. Clean.
- Meeting running, bar collapsed / no answer open → rainbow pill row under the bar.
- Meeting running, Copilot/answer body open inside the bar → no duplicate row (the Copilot card
  already renders the same chips inline — unchanged).
- Meeting ended → recap/review flow unchanged; after Done → clean bar.
- The `hint` line under the pills is dropped ("no messages under" — the pills alone).
- `quickActionsRainbow` setting keeps working as today (rainbow on by default).

## B. Real Pause + separate Stop

New `paused` state inside `useListen` (renderer, [listen.ts](../../../src/renderer/src/lib/listen.ts)),
exposed as `listen.paused` + `listen.pause()` / `listen.resume()`.

Semantics — **streams stay warm** (decision made after Tony declined the trade-off question;
instant resume, no re-permission; macOS mic indicator stays lit while paused):

- Mic + loopback MediaStreams and the AudioWorklet keep running.
- While paused, incoming audio windows are **discarded before enqueue** (the `queue.current.push`
  site) — no transcription, no VAD commits, no auto-answer.
- The meeting timer (`seconds` interval in App.tsx) freezes while paused and resumes without reset.
- Saved transcript simply has a gap; no pause markers in v1.

UI (Bar toolbar, reserved timer slot — [Bar.tsx:372-390](../../../src/renderer/src/components/Bar.tsx)):

- Listening + running: red rec-dot · `m:ss` timer (danger red) · Pause icon · **Stop icon (red,
  `Square`/player-stop)**.
- Listening + paused: timer turns amber and freezes · Play icon (resume) · Stop icon.
- Stop = exactly today's end-meeting flow (`toggleListen` → recap + save). The current fake Pause
  button (wired to `onToggleListen`) is removed.
- "Heard live" chip reads "Paused" (amber dot/icon) while paused.
- The reserved slot width grows (~96px) so the center cluster still never shifts.
- ⌘⇧L keeps its current toggle-listen (start/stop) behavior. No new hotkey in v1.

## C. Transcript survives minimize/hide (the "4-minute death")

Root cause (verified in code): the transcription pump + Whisper worker live in the renderer.
`backgroundThrottling: false` ([main/index.ts:213](../../../src/main/index.ts)) disables Chromium
timer throttling but **not macOS App Nap**, which suspends the hidden window's process. The audio
queue holds `MAX_QUEUE = 24` × 6-second windows ≈ 2.4 min ([listen.ts:18](../../../src/renderer/src/lib/listen.ts)),
then silently drops the oldest — so the transcript appears to stop ~4 minutes in.

Fix (main process):

1. `powerSaveBlocker.start('prevent-app-suspension')` when `IPC.listeningState` reports `true`;
   `powerSaveBlocker.stop(id)` on `false` and on window close. Idempotent (guard the id).
2. `app.commandLine.appendSwitch('disable-renderer-backgrounding')` before `app.whenReady()`.
3. Backpressure drops stop being silent: when windows are dropped, surface a listen error note
   ("Transcription fell behind — some audio was skipped.") via the existing `listen.error` channel,
   in addition to the console warning.

Pause interacts cleanly: paused ⇒ windows discarded by design, no error note.

## D. Minimized ControlPill redesign

Current ([ControlPill.tsx](../../../src/renderer/src/components/ControlPill.tsx)): logo · large
"× Hide" text button · mic. Unbalanced; no recording feedback.

New layout (single pill, drag-anywhere unchanged):

- **Idle:** MantuMark (expand) · mic icon (start listening) · thin divider · small ghost ✕ (hide).
- **Recording:** MantuMark (expand) · red rec-dot · live `m:ss` timer · Pause/Play · red Stop ·
  thin divider · small ghost ✕ (hide).
- The big "× Hide" text button is replaced by the small ghost ✕ at the far end.
- `seconds` and `paused` are passed down from App; the visible ticking timer doubles as proof that
  capture keeps running while minimized.
- `data-hug-width` auto-resize behavior preserved (the pill gets wider while recording; the window
  hugs it).

## Files touched

- `src/renderer/src/App.tsx` — pill-row condition, timer freeze on pause, ControlPill props.
- `src/renderer/src/components/QuickActions.tsx` — drop the hint line.
- `src/renderer/src/components/Bar.tsx` — timer slot: pause/play + stop; paused styling; chip text.
- `src/renderer/src/components/ControlPill.tsx` — full redesign per D.
- `src/renderer/src/lib/listen.ts` — `paused` state, discard-at-enqueue, drop-surfacing error.
- `src/main/index.ts` — powerSaveBlocker lifecycle, renderer-backgrounding switch.

## Out of scope

- True stream-release pause (mic indicator off while paused).
- Pause markers in saved transcripts.
- New hotkeys for pause.
- Any change to the end-of-meeting recap/review flow, Copilot card, or Settings.

## Verification

1. `npm run typecheck` + `npm test` (vitest) green.
2. Unit: pause discards windows (no `commitLine` while paused), resume re-enqueues, drop path sets
   the error note.
3. Live QA (built app, per QA harness): start meeting → rainbow pills under bar; open answer → row
   hides; pause → timer freezes amber, resume instant; stop → recap + save. Minimize to pill →
   timer keeps ticking. Hide window ≥ 6 min with audio playing → transcript lines continue past the
   old ~4-min ceiling. Idle bar shows nothing underneath.
