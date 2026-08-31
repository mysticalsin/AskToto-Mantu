# Thinking orbs: luxury agent status

Status: **active contract**. Implement only to this document.

This is Métis's loading language. Every wait is a quiet caption in Métis type, then Jakub Antalik's MIT thinking orb. Never a bouncing logo. Never a CSS spinner. Never a looping brand mark. Never a purple-gradient hero. Never emoji.

Starfield bed is a different PR. Overlay chrome geometry is a different PR. Do not fight either.

## Source of truth

- Live: https://orbs.jakubantalik.com/
- Package: `thinking-orbs@0.3.1` MIT — https://github.com/Jakubantalik/thinking-orbs
- Install: `npm install thinking-orbs`. Vendor via npm. Do not rewrite their renderer. Do not copy their canvas code. Do not load from unpkg.

```tsx
import { ThinkingOrb } from 'thinking-orbs'
<ThinkingOrb state="working" size={64} theme="dark" speed={1} />
```

The package is 2D canvas only: no WebGL, no `ctx.filter`, no SVG filters. Electron CSP stays as-is. Reduced-motion is built in (static representative frame). Unmount / offscreen / hidden-tab pauses the shared clock.

## Product pattern

Default composition, always in this order:

1. A quiet caption in Métis UI type (`Geist` / `.font-ui`).
2. The orb.

Hero (full window, recap, ask rail, onboarding wait, empty-panel wait): caption + size **64**, generous padding, centered, no purple wash, no emoji. Apple-grade quiet luxury. The word is Geist regular (not bold), slight tracking, ink-2. The canvas sits on its own compositor layer (`isolation` / `contain`) so the 60fps orb does not hitch the glass.

Inline (island, buttons, list rows, chips, determinate progress): size **20**. Named status rows still show the word (Thinking, Listening, Searching, …) then the sphere. Caption may drop only on a tight button or icon slot. Still no old spinner.

Onboarding **setup rows** (the checking / engine-download waits inside the setup scan): caption + 20px orb. Do not restyle the Act, portal, music, or hero video.

Sizes 64 and 20 are separate designs in the package, not a scale factor. Do not pass other sizes.

Theme: pin `theme="dark"` on Métis dark glass. Pin `theme="light"` only on a genuinely light surface (Act 4's lighter veil is out of scope — do not restyle onboarding). Speed stays `~1`. Do not crank speed.

## Caption + orb-state map

The caption is the product word. The orb state is the animation. They are paired and must not drift.

| Kind | Caption | Orb state | When |
| --- | --- | --- | --- |
| `thinking` | Thinking | `solving` | LLM / ask / Intelligence generating, before first token |
| `working` | Thinking | `working` | Same ask, already mid-stream (tokens arriving or previous answer still on screen) |
| `listening` | Listening | `listening` | Listen / recording / ASR live (warmup or hearing) |
| `writing` | Writing | `composing` | Recap / notes / follow-up / coaching draft |
| `searching` | Searching | `searching` | Search / Brain / wiki / retrieval / agenda / mapping meetings |
| `connecting` | Connecting | `connecting` | MCP / connector / auth handshake / OAuth / calendar sign-in |
| `loading-model` | Loading | `weaving` | Model / engine download / first-load / speech-model fetch |
| `loading` | Loading | `breathing` | Generic app boot / unknown wait / Suspense fallback |
| `planning` | Planning | `shaping` | Planning / shaping a plan |

Nine orb states exist. Use only the pairs above. Do not invent captions ("Still working…", "Generating…", "Processing…", "Starting Métis…") on these surfaces. Elapsed-time coaching ("Still working… (12s)") is retired: the orb is the liveness signal.

Determinate waits (a real percent from a checkpoint): keep the percent label and sit the **20px** orb beside it. Do not replace a honest progress bar with an indeterminate orb. Do not show a CSS spinner next to the bar.

## Surfaces in scope

Replace every Métis wait that is currently a `Spinner`, `Loader2`, `animate-spin`, CSS keyframe spinner, pulse-dot-as-wait, shimmer-skeleton-as-wait, or looping logo.

### Hero (caption + 64)

- Ask rail first-token wait (`Answer` thinking branch): Thinking + `solving`. Drop the pulse dot and the shimmer skeleton.
- Recap / notes empty wait (`Review` writing-notes / finishing-transcript / coaching / follow-up / outreach): Writing + `composing`, or Listening + `listening` while the live session is still draining ASR (`finishingTranscript`).
- Brain empty read (`BrainView` "Reading the brain"): Searching + `searching`.
- App boot strip (settings/auth still null): Loading + `breathing`. The slim bar may use inline 20 if 64 cannot fit the 38px glass; caption stays "Loading".
- Suspense panel fallbacks ("Loading…"): Loading + `breathing`.

### Inline (20, caption optional)

- Buttons and list rows that currently spin `Loader2` / `Spinner` / `RefreshCw`: sit the 20px orb. Kind from the table (Connecting for OAuth/MCP, Loading for save/test/rebuild, Writing for recap save, Searching for brain refresh).
- Ask mid-stream byline (`Answer` attribution while `streaming`): Thinking + `working` (no pulse dot).
- Copilot suggestion wait and "Updating…": Thinking + `solving` / `working`.
- Copilot / Settings ASR or local-model warmup: Loading + `weaving`. If a real percent exists, keep it and sit the 20px orb beside it.
- Capture-in-progress on the bar / control bar: Thinking + `working` (tight: orb only).
- Agenda load: Searching + `searching`. Outlook connect: Connecting + `connecting`.
- Brain / Intelligence index and live ingest rows: Searching + `searching`, keep the determinate `WorkProgressMeter` when a percent exists.
- Import / engine warmup (`WorkProgressMeter` indeterminate): Loading + `weaving` beside the meter. Determinate phases keep the bar; sit the 20px orb beside the percent.
- Settings Dust OAuth / CLI / MCP / Outlook / license / agent-list waits: Connecting or Loading per the table.
- Island / pill listen chrome that is a **wait** (ASR starting, not the red rec-dot): Listening + `listening`, size 20.

### Rec-dot and rainbow ring stay

The red `.rec-dot` is a recording-consent / liveness mark, not a wait. Do not replace it with an orb. The deep-thinking rainbow contour is a mode toggle, not a wait. Do not replace it.

## Out of scope (do not touch)

- Overlay chrome geometry: `geometry.ts`, cursor-watch, hide park, `BAR_MIN_HEIGHT`, `OverlayPeek` rest rects, island Y.
- Onboarding Acts as narrative: portal open/close, portal sound, Goldberg Aria, Act 1 hero video, Ken Burns, stripe wash, Act copy, Skip/Ready flow. Replacing a **wait widget** inside setup (checking spinner, engine download percent + orb) is in scope; rewriting the Act is not.
- Starfield bed.
- Packing 1.8.1 / release version bump.
- Merging this PR.

## Implementation shape

One wrapper, one map, one package:

- `src/renderer/src/lib/agent-status.ts` — the kind → `{ caption, state }` map. Pure. The test source of truth.
- `src/renderer/src/components/AgentStatus.tsx` — caption then `<ThinkingOrb>`. No custom canvas. No CSS keyframes.
- `Spinner` in `ui.tsx` becomes a thin inline `AgentStatus` (kind `loading`, size 20, no caption) so forgotten call sites cannot resurrect the SVG spinner. Prefer explicit `AgentStatus` + kind at named waits.

Renderer-only dependency: keep `thinking-orbs` in `devDependencies` (Vite bundles it; electron-builder must not ship a second copy in `node_modules`).

## Quality

- Apple-grade. Smooth. Defaults friendly. One logical change.
- Motion 60fps-class, speed `1`.
- `prefers-reduced-motion` must not throw (package static frame).
- Unmount pauses (package). Wrapper must unmount cleanly.
- No leftover `.loading-spinner`, `animate-spin`, or `@keyframes` spinner on the replaced surfaces.
- Tests: each mapped kind renders the right caption + orb state; reduced-motion does not throw; unmount does not throw; named surfaces no longer contain the old SVG spinner markup.
