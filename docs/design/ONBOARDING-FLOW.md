---
project: Métis
type: scene-contract
scene: Exclusive tour order + Your setup loading + Act 4 contrast
owner-slice: PR 101 / 1.8.3 Totos-Mac walk
status: implement-exactly
mac-show: Totos-Mac 11:52–11:53pm ET
---

# Onboarding flow (Tony 11:52–11:53pm)

Do not merge. Do not pack. Version stays 1.8.3. READY TO MERGE stays no.

Keep: KineticGrid after the lady beat. No Skip. No starfield. Opaque exclusive `#05010A` hero hold (never `#3A0B6B` first paint). Hide 8×2 leftover out.

## 1. Your setup loading orb (HARD)

Tony: the Jakub thinking-orb is the animation for everything that is loading on Your setup.

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

Tony: right after the demo of how it works, ask where it lives, then jump into setting it up, then choosing the setup you want.

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
