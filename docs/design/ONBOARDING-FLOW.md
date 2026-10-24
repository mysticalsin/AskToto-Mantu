---
project: Métis
type: scene-contract
scene: Exclusive tour order + Your setup loading + Act 4 contrast
owner-slice: PR 101 / 1.8.3 Totos-Mac walk
status: implement-exactly
mac-show: Totos-Mac 11:52–11:53pm ET
---

# Onboarding flow (the owner 11:52–11:53pm)

**Status:** Draft — implement-exactly, ready-to-merge: no (see frontmatter).

Do not merge. Do not pack. Version stays 1.8.3. READY TO MERGE stays no.

Keep: KineticGrid after the lady beat. Skip setup only after the permissions step, with consent (D-27). No starfield. Opaque exclusive `#05010A` hero hold (never `#3A0B6B` first paint). Hide 8×2 leftover out.

## 1. Your setup loading orb (HARD)

the owner: the Jakub thinking-orb is the animation for everything that is loading on Your setup.

Root: `asrAssetsRowStatus` maps `downloading` / `idle` to `SetupRowState 'action'`. `localModelRowStatus` maps `downloading` / `not-downloaded` to `'action'`. The row only mounts `<InlineOrb kind="loading" />` when `state === 'checking'`. `'action'` paints the word **needed**. The long Parakeet+Whisper fetch looks idle.

```
SetupRowState += 'loading'
checking  = first poll / unknown
loading   = still working (idle fetch, downloading, starting a download, real 0..1 progress)
action    = user work only (Allow Microphone, disk full, retryable error)
ready     = Check
blocked / restart / skipped = those labels
```

- `asrAssetsRowStatus`: `downloading` and `idle` → `loading`. `error` stays `action`.
- `localModelRowStatus`: `downloading` and `not-downloaded` → `loading`. `download-failed` / `insufficient-disk` stay `action`. RAM-gated stays `blocked`.
- UI: `checking` and `loading` render `InlineOrb` / `AgentStatus` `kind="loading"` (`data-agent-status=loading`). Never the **needed** span.
- Real progress in `(0, 1)` → AgentStatus `percent` (1–99). Empty / 0 / unknown → orb only. No fake 0%.
- Continue still blocked until the ASR row is `ready`.
- No CSS spinner.

## 2. Last one / How should Métis show up (HARD)

Act 4 personalize sits on KineticGrid `#05010a`. Tell the room (`.onboard-tell-card`, white `rgba(255,255,255,0.22)`) is the spotlight. The kicker / title / lead were tuned for starfield and die on the darker bed.

- Kicker "Last one", title "How should Métis show up?", lead: closer to `#fff`, stronger weight/size.
- Soft **local** light behind the heading cluster only (`.onboard-act4-heading`). Not `.onboard-act4::before`. Not `.onboard-stage:has(.onboard-act4)`. Not a full-stage white wash. Do not bleach Tell the room.
- Tell the room stays the emotional focus. Hierarchy stays: heading readable, card brighter.

## 3. Where should Métis live moves earlier (HARD)

the owner: right after the demo of how it works, ask where it lives, then jump into setting it up, then choosing the setup you want.

```
hero → problem → reveal → appearance → setup → personalize → [license if enabled] → ready
```

| helper | lands on |
| --- | --- |
| `sceneAfterReveal()` | `appearance` |
| `sceneAfterAppearance()` | `setup` |
| `sceneAfterSetup()` | `personalize` |
| `sceneAfterPersonalize(license)` | `license` or `ready` (never appearance) |
| `sceneAfterLicense()` | `ready` |

`GUIDED_SCENES` = `problem, reveal, appearance, setup, personalize`.

Reveal Continue uses `sceneAfterReveal()`, not a hardcoded `setScene('setup')`.

Appearance copy stays `ONBOARDING_APPEARANCE_HEADING` ("Where should Métis live?"). Overlay leftover (Hide 8×2) unchanged.

G56 adds the role interview after personalize when signed in: `sceneAfterPersonalize(license, interviewAvailable)` lands on `interview`, and `sceneAfterInterview(license)` lands on `license` or `ready`. `GUIDED_SCENES` gains `interview`. Skip setup is offered on `personalize`, `interview` and `license` only, with consent (`canSkipOnboarding`).

## Component notes (moved from `OnboardingExperience.tsx`, G56)

Métis onboarding as an EXPERIENCE: a six-act narrative per docs/ONBOARDING-EXPERIENCE.md, closed by Act 6 (Ready, MQA-283): hero, staged problem story, reveal, live environment-scan magic moment, personalization, [license, optional], appearance, Ready, finish (anatomy extracted from the Vibe Island reference: welcome, demo, config, vibe, license, ready).

Deliberate constraints:

- No animation libraries: CSS transitions and staged `animation-delay` only, like the rest of the app. The exception is Act 2's synthetic cursor (OnboardingDemoScene), which needs a per-frame projection CSS cannot express: a small rAF loop over lib/synthetic-cursor.ts, not a dependency. Act 1's Métis wordmark is static. No scramble.
- Scene 4's checks are REAL (permissions, package-scoped speech readiness, local model status): a row only ever shows "ready" when it is actually true. Legacy/full profiles keep their existing ASR setup flow; verified lean profiles report the approved cloud route and never start optional model provisioning here.
- Act 2 (reveal) is the one deliberate exception to "never fake": it drives Métis's REAL Bar/Copilot/Answer/QuickActions components with a scripted fake meeting (MQA-277), guarded so fake data can never persist and the demo can never see real data (MQA-278, @shared/demo-guard).
- Act 6 (Ready, MQA-283) is the terminal act: it finishes onboarding itself (marks `onboardingDone`) instead of handing off to the legacy provider/API-key step. The embedded-Cloudflare-default install (main/embedded-cloudflare-key.ts, MQA-273) already makes a fresh install `providerReady` with zero user action, so a mandatory config screen for something already configured was the dishonest part. Adding a personal provider key stays reachable as an OPTIONAL link from Ready, never a gate; see `ActReady` and `onboarding-flow.ts` for the tested scene-transition rules.
- Act 3 (setup/Config, MQA-279) is "scan first, then present a completed configuration", kept honest by the same never-fake rule applied to the AI-readiness row (`aiRowStatus`): it reads `providerReady`/`provider` straight off the settings snapshot `publicSettings()` derives in main/index.ts, so it can never claim "Ready" while a real ask would still fail. The opt-out toggle on the screen row only appears because `screenAsk` is a real, always-on-by-default setting (ipc.ts), never invented.
- Self-contained: mounts in place of the legacy tour via App's onboarding gate; everything the host needs comes back through onDone.

Act 4 persona cards: the one emotional choice after the heavy config step. Three cards over the plain picker they replaced, each naming the mode's real behavior change (`persona-vibe.ts`, unit-tested against `DEFAULT_MODE_PROMPTS`) rather than inventing personality settings. Selection delight is a single one-shot ring (`.persona-select-ring`) keyed by `mode`, so it retriggers on every pick (the same remount trick as `.scene-enter`'s `key={scene}`) and folds into the global reduced-motion rule.

Act 6 Ready: a restrained celebratory beat (one gleam sweep on the mark and a handful of one-shot spark motes, `READY_SPARKS`, not a confetti cannon or collectible card). Spark positions are six literal hand-spread offsets rather than computed; `.ready-spark` keyframes animate opacity and transform only, so the blanket reduced-motion rule lands on the invisible end state. Onboarding finishes only when Ready's own button is pressed, and even then Métis does not listen until Listen is pressed and the room has been told. `onOpenAiSettings` still finishes onboarding first so the user lands in Settings, not back in onboarding.
