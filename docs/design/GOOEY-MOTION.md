---
project: Métis
type: scene-contract
scene: premium gooey micro-motion (CTA / scene / orb host)
owner-slice: exclusive onboarding chrome + thinking-orb hosts
status: implement-exactly
mac-show: Totos-Mac / PR 66
---

# Gooey motion

Tony add-on on the live Mac tour. Jakub Antalik’s liquid gooey is the **micro-animation language** around already-shipping luxury pieces. It is not a new bed. It is not wait language. Overlay hide-park, island geometry, cursor-watch, and `BAR_MIN_HEIGHT` stay off limits (PR 58). Do not pack. Do not merge. READY TO MERGE stays no.

## Outcome

The tour still reads as one luxury product: April 29 girl clip → purple constellation-grid → thinking-orbs on waits, with **soft gooey morphs** on CTA press, scene settle, and the orb host chip.

## Source of truth

- Live: https://gooey.jakubantalik.com/
- Package: `liquid-gooey@0.2.1` MIT — https://github.com/Jakubantalik/Libraries/tree/main/packages/liquid-gooey
- Install: `npm install liquid-gooey@0.2.1` (exact pin). Renderer `devDependency` (Vite bundles it).
- Do not rewrite their silhouette engine. Do not copy the playground. Do not add Unsplash or demo-page chrome from that site.

```tsx
import { Liquid } from 'liquid-gooey'
<Liquid blur={5} contrast={16} fill="#f4f4f5">
  <Liquid.Item morph={{ shape: true, bounce: 0.28, contentBlur: 0 }} transition="bouncy">
    {children}
  </Liquid.Item>
</Liquid>
```

## What gooey is (and is not)

| Is | Is not |
| --- | --- |
| Motion feel on CTA pills, scene-enter settle, thinking-orb host | A second particle system / starfield / constellation |
| SVG silhouette + crisp content (package architecture) | CSS `filter` on the stage, video, or grid canvas |
| Morph / jelly press on a small chip | Full-screen takeover, Melt of two photos, Move trails across the bed |
| Quiet Mantu fills (`#f4f4f5` CTA, translucent purple wait chip) | White-on-slate tech-demo playground |

thinking-orbs stay the wait language (Thinking / Planning / Connecting / …). Gooey only hosts that composition.

## Surfaces in scope

1. **CTA.** Wrap each `onboard-cta` (Next / Continue / Set me up / Get started / Activate host) in `GooeySurface` `variant="cta"`. Button class stays on the `<button>` (always visible, min 52×220, no glass, no fade-up). Child background goes transparent so the liquid fill is the pill. Press: `scale` ~0.96, `transition="bouncy"`, `contentBlur: 0`.
2. **Scene.** Do **not** wrap a scene in a filled Liquid group (that would paint a panel over the grid). Scene settle is CSS only: short overshoot on `.scene-enter` (transform + opacity). Crossfade clip → grid stays opacity-only 640ms.
3. **Wait host.** Wrap the thinking-orb slot (`agent-status__orb`) in `GooeySurface` `variant="wait"`, fill `rgba(192, 132, 252, 0.16)`. Caption stays crisp outside the droplet. Orb canvas is never filtered.

## Out of scope

- Constellation-grid engine / canvas / `OnboardingConstellation`
- April 29 hero video, portal, Goldberg Aria, locked copy, mandatory tour
- Overlay chrome geometry
- `effect="melt"` / Unsplash / demo plus-menu playground
- Packing 1.8.2 / merge

## Reduced motion / fail

`prefers-reduced-motion` and no-`window` (tests / SSR): `GooeySurface` is a pass-through. Package transitions also snap. Never throw. Never leave a blank hole.

## Files

| Path | Role |
| --- | --- |
| `docs/design/GOOEY-MOTION.md` | this contract |
| `gooey-motion.ts` | blur / contrast / fills / bounce pins |
| `GooeySurface.tsx` | Liquid wrapper; pass-through when reduced |
| `OnboardingExperience.tsx` / `OnboardingDemoScene.tsx` | CTA wraps |
| `AgentStatus.tsx` | wait-host wrap around the orb slot |
| `styles.css` | scene-enter overshoot; transparent CTA face on gooey host |

## Tests (must pass)

1. `liquid-gooey` is pinned `0.2.1` in package.json.
2. CTAs still have `onboard-cta` on the button, outside `.scene-enter`.
3. `OnboardingConstellation` / constellation engine never import `liquid-gooey`.
4. AgentStatus still renders thinking-orbs (`data-thinking-orb` / canvas). Gooey does not replace the orb.
5. Reduced-motion / no-window pass-through.
6. No demo title / Unsplash / plus-menu playground strings.
7. Existing constellation, orbs, copy, music, skip-gone pins still pass.
