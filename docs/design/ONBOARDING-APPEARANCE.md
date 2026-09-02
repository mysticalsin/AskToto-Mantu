---
project: Métis
type: scene-contract
scene: Onboarding appearance picker
owner-slice: exclusive onboarding tail beat (Hidden / Island / Bar)
status: implement-exactly
mac-show: Totos-Mac
---

# Onboarding appearance picker

Tony asks Hidden vs Island vs Bar during onboarding, with a live preview and no lag. Root gate: [`DESIGN.md`](../../DESIGN.md) **Onboarding appearance (Tony ask)**. Overlay hide-park 8×2, Island hover (camera / notch square), cursor-watch, and PR 94 park leftover stay off limits. Do not pack. Do not merge. READY TO MERGE stays no until Tony Mac-shows.

## Outcome

1. Before Ready, Métis **asks** how it should sit: **Hidden** (default) vs **Island** vs **Bar**.
2. Hidden copy: mouse to the top, **click to trigger**. Not hover-only in this ask.
3. Live preview at the top of the exclusive stage. Card click updates the preview on the same tick. No lag.
4. Persist the existing overlay setting. Replay / already-chosen island or bar stays selected. Finish does not overwrite `overlayLayout`.
5. After Get started, park the chosen layout with the **existing** rest surfaces (Hide 8×2, Island peek at `bounds.y`, Bar at workArea). Do not restyle those surfaces here.

## Placement (HARD)

Tail beat, not a seventh narrative act.

```
hero -> problem -> reveal -> setup -> personalize -> [license] -> appearance -> ready
```

- `GUIDED_SCENES` stays `problem | reveal | setup | personalize`.
- `sceneAfterPersonalize(false)` → `appearance` (was `ready`).
- `sceneAfterLicense()` → `appearance`.
- `sceneAfterAppearance()` → `ready`.
- Skip screen includes the same picker + live preview, then Tell the room + Get started.
- Starfield mounts: add `appearance` to `STARFIELD_SCENES`. Still skip `hero` and `reveal`.

## Cards (HARD)

Three cards. Same diagram language as Settings (`OverlayChromePicker` desktop chip). Onboarding titles:

| id | title | caption | default |
| --- | --- | --- | --- |
| hide | Hidden | Move to the top, then click to open. | yes |
| island | Island | A small island stays visible. Hover opens it. | no |
| bar | Bar | The bar stays on screen. | no |

Selected card is obvious. Hidden shows a Default chip. No em dash. No Vibe Island strings. Settings may keep its existing "Hide" title; do not restyle Settings chrome for this slice.

## Live preview (HARD)

A CSS desktop mock at the **top** of the exclusive stage. It is not the real overlay window.

Forbidden on this preview: `setBounds`, real `Bar`, Listen, Jarvis orb, WebGL, rAF, layout animation, `filter` / `backdrop-filter` during the spring, dwell timers.

Required:

- Compositor-only: `transform` + `opacity`. `--ease-spring`. Reveal 320–380ms, hide 280–340ms. Reduced-motion: instant.
- **Hidden rest:** empty top. Faint top-center hint only. Click the top strip → mock bar springs down. Hover does not reveal Hidden in this preview.
- **Island rest:** camera / notch **square capsule** at top-center (peek-sized, not a wide bar). Hover expands down. Leave returns to the square. Click may also expand.
- **Bar:** full mock bar, always visible. No collapse.
- Card click remounts the preview (`key={layout}`) so the rest surface is correct on the same tick.
- Windows: no fake notch in the mock.

## Persist (HARD)

```
seedOnboardingAppearance(settings) === parseOverlayLayout(settings?.overlayLayout)
appearanceSettingsPatch(layout) === { overlayLayout: layout, autoHideOverlay: autoHideOverlayForLayout(layout) }
```

- Fresh install: Hidden.
- Replay / existing profile: keep the saved layout as the selected card.
- Click patches immediately via the existing `patch` IPC. No reinstall.
- `OnboardingV2` `onDone` still writes `mode`, `recordingConsent`, `onboardingDone`, `onboardingDoneAt` only. Never `overlayLayout`.
- Settings Replay onboarding still patches only `onboardingDone: false`.
- Managed `overlayLayout`: cards disabled, preview still shows the locked value.

## Do not touch

- Hide park **8×2** (`OVERLAY_HIDE_PARK`).
- Island hover hit rect (`hoverWatchRestRect` at `bounds.y`; camera / notch square at ~X=900 Y=12 still reveals).
- Overlay park leftover PR 94 (`restoreParkAfterShow`, leftover Y=39).
- Operator, Listen, ClickUp, pack, Goldberg Aria, version bump, merge.

## Tests

Pure helpers for seed / patch / preview phase. Structural pins on the scene hop, copy, starfield include, and "finish does not write overlayLayout". Geometry tests already pin 8×2 and Island hover; this slice must not edit `src/main/island/geometry.ts`, `cursor-watch.ts`, or overlay park handlers in `src/main/index.ts`.
