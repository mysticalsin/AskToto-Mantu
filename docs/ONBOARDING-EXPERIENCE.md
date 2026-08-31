# Métis Onboarding — "An Experience" (VibeIsland-grade)

Tony's brief: rebuild Métis onboarding to feel like Vibe Island's ("this was an experience").
Reference extracted 2026-07-18 from Vibe Island 1.0.42's Localizable.strings + live run.

## Why Vibe Island's onboarding works (the anatomy)

Their flow is a **five-act narrative**, not a settings wizard:

1. **Hero** — one line of identity ("A Dynamic Island for your AI coding tools"), three crisp
   feature bullets, a single CTA ("Get Started"). No form fields on screen one, ever.
2. **Problem story, staged** — escalating lines revealed one at a time with motion:
   "Context switches" → "You have 4 agents running." → "One of them has been waiting for you."
   → "That's 15 hours a week." You *feel* the pain before the pitch.
3. **Solution reveal** — three punchy parallel statements: "Everything. One glance." /
   "Approve without switching." / "Jump to the exact tab."
4. **The magic moment** — "Your Environment": a LIVE scan of the user's real machine, rows
   animating to "detected", closing with "Everything's configured. No action needed." The app
   does the setup work *in front of you*. This is the moment that converts.
5. **Personalization + themed landing** — "Choose your vibe" (mascot/theme pick), launch-at-login,
   then "Ready to land?" → "Welcome aboard" → "Start Vibing". Playful thematic language end-to-end.

## The Métis translation (goddess motif, meeting copilot)

Five scenes, full-window, keyboard/click to advance, ~40s total, skippable at every step.

### Scene 1 — Hero
Constellation animation: the Métis goddess mark draws itself from star-points (SVG stroke
animation over the existing icon). Then:
> **Métis.** The wisdom before the moment.
Three bullets (fade in sequence): "Answers grounded in YOUR meeting" · "Everything on-device —
never uploaded" · "Visible to everyone on the call". CTA: **Begin**.

### Scene 2 — Problem story (staged lines, one at a time, dark screen, large type)
> "You're in the meeting."
> "The question lands on you."
> "You know that you know it."
> "…and the moment passes."
Timing: ~1.2s per line, ease-in, previous lines dim to 40%. This is the emotional core — do not
rush it, do not add UI.

### Scene 3 — Reveal (the turn)
The Métis bar slides up from the bottom (the REAL Bar component, live), a simulated transcript
line appears, a suggestion materializes in the answer panel:
> **Métis sees it coming.**
> "The answer, before you need it." / "In your voice, from your meetings." / "On your device."

### Scene 4 — "Your setup" (the magic moment — live, real checks)
Rows animate from spinner → state, using REAL signals (all already exposed via IPC):
- Apple Silicon acceleration — ✓ detected
- On-device transcription (Parakeet + Whisper) — ✓ bundled, ready
- Local meeting brain — ✓ initialized
- Microphone — request inline (platform-perms) → ✓
- Screen context — request inline → ✓ (or "later" without blocking)
- (cut from v1: calendar connect — revisit once calendar has an onboarding-safe connect flow)
Close: **"Everything's ready. Nothing to configure."** (only show rows that are actually true —
never fake a check.)

### Scene 5 — Personalization + landing
"How will you use Métis?" → mode cards: General / Sales / Recruiting (sets `settings.mode`).
Language pick (existing selector). Then:
> **Ready when you are.** — CTA: **Start listening** (or "Explore first")
Consent line (the existing record-consent copy) sits HERE, as the last gate before finish.

## Implementation notes
- New `src/renderer/src/components/OnboardingExperience.tsx`; replaces the current tour when
  `onboardingDoneAt` is unset. Keep the old component behind a flag for one release.
- Motion: CSS keyframes + transition-delay staging (the app already uses fade-up etc. in
  index.css). No animation libraries — stay dependency-free.
- Scene 3 reuses the real `Bar` + answer-panel components in a sandbox container (no live mic) —
  authenticity beats a mockup.
- Scene 4 wires: `platform-perms` IPC for mic/screen status+request, `asrBundled` flags,
  brain-init status. Every row must reflect reality — the honesty rule.
- Sign-in (Microsoft/local) stays BEFORE the experience (it gates data), but restyle to match.
- All copy through the i18n path like the rest of the renderer.


## Implementation status (2026-07-18)
Shipped as OnboardingExperience.tsx + OnboardingV2 wrapper (legacy entered at provider step).
Consent is a REQUIRED checkbox gating Start in Scene 5 (per spec; restored after CMO-QA finding #1 —
the Skip path routes through the full legacy flow so it hits legacy slide 1's consent instead).
Calendar row cut from Scene 4. Demo transcript is mode-agnostic with an explicit Example label.

## Implementation status — Act 6 "Ready" + the tail re-point (MQA-283)
The narrative grew a sixth, terminal act closing out the flow the teardown's own canonical order
uses (welcome→demo→config→vibe→license→ready):

```
hero -> problem -> reveal -> setup -> personalize -> [license, only if licenseGateEnabled] -> ready -> finish
```

- **Scene 6 — Ready.** A tasteful, Apple-grade closing beat: the Métis mark gets a one-shot conic
  "gleam" sweep plus a handful of one-shot spark motes (`.ready-mark-wrap`/`.ready-spark`,
  `styles.css`) — deliberately NOT Vibe Island's confetti cannon + collectible edition card, and
  fully `prefers-reduced-motion`-safe (the sweep is suppressed outright; the spark keyframes only
  ever touch opacity/transform, so the blanket reduced-motion rule already lands them correctly).
  The active mode is named ("Sales mode" etc.) under the heading, then the honest empty-state line —
  Métis's own equivalent of the teardown's "restart your sessions" last line:
  > "Métis is ready. It starts listening only when you press Listen and tell the room — nothing is
  > captured before that."
  CTA: **Get started** — this is what actually finishes onboarding now (marks `onboardingDone` /
  `onboardingDoneAt`). A second, visually secondary link — "Add your own AI provider — optional,
  never required" — opens Settings' AI tab; it is OPTIONAL and never a gate, because the embedded-
  Cloudflare-default install (`src/main/embedded-cloudflare-key.ts`, MQA-273) already makes a fresh
  install `providerReady` with zero user action.
- **The tail re-point.** The experience used to hand off, after Scene 5, to the LEGACY
  `Onboarding.tsx` component entered at its provider/API-key step (`initialStep={5}`) — forcing a
  config screen for something already configured on every fresh install. That hop is gone: the
  experience now finishes itself at Ready. `OnboardingV2`'s `phase` state dropped its `'provider'`
  member (`'experience' | 'legacy-full'` only); the legacy component is only ever entered now via the
  "Skip the tour" escape hatch, at its own slide 1, consent gate included.
- **License order.** Act 5's license scene (MQA-281/282, `settings.licenseGateEnabled`, default off)
  moved from between `setup` and `personalize` to between `personalize` and `ready`, matching the
  teardown's own act order. It is still skipped entirely — not even rendered for a frame — whenever
  the gate is off.
- **Pure flow logic.** The three scene-transition rules governing this tail
  (`sceneAfterSetup`/`sceneAfterPersonalize`/`sceneAfterLicense`) live in
  `src/renderer/src/lib/onboarding-flow.ts`, independently unit-tested in
  `onboarding-flow.test.ts` rather than only visible by reading JSX `onClick` handlers.
- **Replay in Settings.** The existing reset-onboarding footer action in `Settings.tsx` was
  relabelled "Replay onboarding" with honest confirm copy ("Replay onboarding from the start? Your
  settings won't change."). It patches `onboardingDone: false` and closes the Settings panel — the
  same gate `App.tsx` checks on every render, so the very next render remounts the six-act experience
  fresh from hero, with no separate replay state machine to keep in sync.

## Mac-show notes (PR 66, Totos-Mac)

Layout and motion only. Six-act copy is unchanged.

- Act 1 is a live Starfield Close tunnel from frame one (`shouldMountStarfield` includes `hero`). The March 19 CloudFront clip still `play()`s on mount under the canvas if it loads. Kenburns on a still is not the first image.
- Goldberg Aria starts on exclusive mount and is retried on first click and on Next. Scene changes do not stop the bed. Portal OPEN/CLOSE stay a separate, louder pair.
- Problem-story lines fade in and stay (`forwards`). Continue is visible immediately. Demo heading, helper, Next, and Set me up stay mounted for the whole clip.
- Act 4 has no white top rectangle. Starfield is the bed.
- Tell the room is centered in the stage (title, lead, quote pill, why, checkbox).
- After finish, the bar lands with a quieter, shorter dimension-open (about half of portal OPEN). Hide-park 8×2 and hover math stay put.
- Hero mark lands on a spring. Persona cards are pressable. Setup rows pop in. Reduced-motion still lands, without bounce.

Canonical contract: `docs/design/ONBOARDING-STARFIELD.md`.
