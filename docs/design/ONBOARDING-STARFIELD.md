---
project: Métis
type: scene-contract
scene: Layers.ai "Starfield Close"
owner-slice: onboarding bed only
status: implement-exactly
---

# Onboarding Starfield Close bed

One change: after Next (or Start) on Act 1, the rest of the exclusive tour sits on a full-bleed WebGL recreation of Layers.ai **Starfield Close**. The canvas is background only. Showcase videos, meeting-type chips, copy, Confirm, portal, and music do not change.

This file is the contract. Implementation must not invent scroll chrome, CDN three, overlay geometry, or Act copy.

## Outcome Tony signed

- Act 1 first image / March 19 hillside-vortex hero (`onboarding-hero-video.ts`) stays until the user clicks **Next** or **Start** on that first image.
- After that click: mint / jade / bone star tunnel, twinkle, barrel roll, cursor parallax + star repel, bloom, complementary bg `#0a0a24`, cyan / violet corner flames.
- The field is **under** the existing tour UI (video showcase, meeting-type chips, glass, copy). UI stays readable. Do not replace showcase videos with the starfield.
- Skip the tour never mounts this bed (they did not start the tour).
- Overlay PR 58 chrome stays untouched. New files + onboarding mount only.

## Hard: no scroll, ever

Tony rejected a preview that waited on page scroll.

Forbidden:

- `#scroll-host` (any id or class named scroll-host)
- A "scroll ↓" hint, chevron, or caption
- `overflow: auto` / `overflow: scroll` / `overflow-y: scroll` on the bed or onboarding root
- Driving `scrollTarget` from `window.scrollY`, wheel, touch-pan, or a fake scroller
- Loading three from unpkg, jsdelivr, or any runtime URL

Required:

- `html, body, #root` stay `overflow: hidden` (already true in `styles.css`; do not regress)
- Exclusive stage already `overflow: hidden`. Do not add a scrollbar to onboarding.
- Starfield wrapper + canvas: `position: fixed; inset: 0; overflow: hidden; pointer-events: none` so UI clicks pass through
- The tunnel keeps moving on its own. Time-driven dive. Drift + spin every frame so it never reads as a still

## Scroll stand-in (the only "scroll")

Onboarding has no page scroll. Feed the Layers scroll pipeline this target, then the existing double-damp:

```
breath(t) = 0.42 + 0.28 * (0.5 + 0.5 * sin(t * 0.32))
scrollTarget = reducedMotion ? 0 : breath(tSeconds) + nextBump
smooth += (scrollTarget - smooth) * 0.10
scroll  += (smooth - scroll) * 0.06
```

`t` is seconds since the bed mounted. Period is ~19.6s. Range of `breath` is 0.42..0.70.

`nextBump` starts at 0. A scene Next/Continue after the bed is up adds `+0.16`, then decays (`bump *= exp(-dt * 2.4)`). First Next may apply one bump on mount. Never required for motion; the breath is.

Reduced motion: `scrollTarget = 0` (no dive surge). Drift and spin still run at 12% of CONFIG so the field is very slow, still a bed, still readable.

## Appear

After Next/Start mount:

```
appearProgress = clamp((elapsedMs - 300) / 1400, 0, 1)
uOpacity = appearProgress * CONFIG.opacity   // 0 → 2
```

300ms delay, 1400ms fade, destination opacity 2.

## Files (this slice)

Create only:

| Path | Role |
| --- | --- |
| `docs/design/ONBOARDING-STARFIELD.md` | this contract |
| `src/renderer/src/lib/onboarding-starfield-spec.ts` | CONFIG, LAYERS, shaders verbatim, breath / damp / appear / mount predicate. No three. |
| `src/renderer/src/lib/onboarding-starfield-engine.ts` | WebGL1 scene. Imports `three` from the local package (Vite-bundled). |
| `src/renderer/src/lib/onboarding-starfield-spec.test.ts` | math + shader/CONFIG pins + no-scroll/no-CDN contracts |
| `src/renderer/src/lib/onboarding-starfield-engine.test.ts` | dispose, WebGL fail, reduced-motion, no unpkg |
| `src/renderer/src/components/OnboardingStarfield.tsx` | canvas host, rAF lifecycle, hide-pause, unmount dispose |

Allowed edits:

- `OnboardingExperience.tsx` — mount the bed after Next/Start; keep hero video as WebGL-fail fallback; pulse on later Next/Continue. Do not rewrite Acts copy.
- `styles.css` — only `.onboard-starfield` (+ canvas) rules. Do not touch overlay chrome, portal keyframes, hero video, or Act 4 wash.
- `package.json` / lockfile — pin `three@0.143.0` in `devDependencies` (renderer deps are bundled). Exact version.

Off limits (do not open to edit):

- Island geometry, cursor-watch, hide park, `BAR_MIN_HEIGHT`, overlay click sound
- Overlay chrome picker / peek / autohide / `App.tsx` overlay park
- `onboarding-hero-video.ts` (March 19 CloudFront clip stays Act 1)
- `onboarding-portal.ts`, `onboarding-music.ts`, CSP `media-src` / music
- Act copy in Experience / demo / tell-the-room / persona-vibe
- Version bump to 1.8.1. Do not pack. Do not merge.

## Mount predicate

```
STARFIELD_SCENES = problem | reveal | setup | personalize | license | ready
shouldMountStarfield(scene) === STARFIELD_SCENES.includes(scene)
```

- `hero`: Act 1 video only. No canvas.
- `skip`: no canvas (Skip is not Next/Start).
- After Next: mount canvas. If WebGL1 init throws or has no context: unmount canvas, show the existing hero video bed. Never blank the tour.

## Three.js (local, r0.143.0)

- Package `three@0.143.0`. Import `from 'three'` and `three/examples/jsm/...`.
- Electron CSP `script-src 'self'` blocks unpkg. Never write a `<script src="https://unpkg.com/three...">` or dynamic import of a URL.
- `WebGL1Renderer({ canvas, antialias: true })`
- `renderer.shadowMap.enabled = true`; `renderer.shadowMap.type = VSMShadowMap`
- Pixel ratio `min(devicePixelRatio, 2)`

## CONFIG (exact)

```
CONFIG = {
  bgColor: '#0a0a24',
  flameColor: '#aee9ff',
  flameColor2: '#c79bff',
  flameAmt: 0.2,
  colorA: '#aef6cf',
  colorB: '#5fe6a0',
  colorC: '#eafff2',
  opacity: 2,
  pointSize: 50,
  brightness: 1.85,
  drift: 2.35,
  twinkle: 1,
  spin: 0.03,
  repelRadius: 5,
  repelStrength: 0.35,
  scrollPush: 8,
  scrollDrift: 6,
  scrollSpin: 0.1,
  parallax: 0.6,
}
LAYERS = { NONE: 0, TORUS_SCENE: 1, BLOOM_SCENE: 2, ENTIRE_SCENE: 3 }
```

## Scene

- `scene.background = 0x000000`
- `scene.fog = Fog(0x000000, 0, 15)`
- `PerspectiveCamera(45, aspect, 0.1, 80)` at `(0, 0, 5)`

Points: count 4200, depth 30.

- `x = (rand - 0.5) * 24`
- `y = (rand - 0.5) * 16`
- `z = (rand - 0.5) * 30`
- `aPalette = floor(rand * 3)`
- `aBright = 0.7 + rand * 0.6`
- `aScale = 0.5 + pow(rand, 1.4) * 2.5`
- `aPhase = rand`

Attributes: `position`, `aScale`, `aPhase`, `aPalette`, `aBright`.

`group` + `points` layers = `ENTIRE_SCENE` (`.set(3)`).

`ShaderMaterial`: transparent, `depthWrite: false`, `AdditiveBlending`.

Uniforms (initial):

```
uTime 0, uSize 50, uOpacity 0, uDrift 0, uDepth 30, uTwinkle 1,
uCursor Vector3(0,0,0), uRepelRadius 5, uRepelStrength 0.35, uActivity 0,
uColorA/B/C from hex, uBrightness 1.85
```

## Shaders (verbatim)

Vertex, fragment, FinalPass vertex, FinalPass fragment: copy the strings in `onboarding-starfield-spec.ts` exactly as in the owner-slice prompt. Tests pin the full text. Do not "clean up" whitespace or uniforms.

## Composers

Three `EffectComposer`s, each starting with `RenderPass(scene, camera)`:

1. **torusComposer** `renderToScreen = false`: RenderPass, `ShaderPass(GammaCorrectionShader)`, `UnrealBloomPass(size, 0.22, 0.2, 0)`, `ShaderPass(CopyShader)`
2. **bloomComposer** `renderToScreen = false`: RenderPass, `UnrealBloomPass(size, 0.4, 0.55, 0)`, `ShaderPass(GammaCorrectionShader)`
3. **finalComposer**: RenderPass, FinalPass `ShaderPass`. Wire `bloomTexture = bloomComposer.renderTarget1.texture`, `torusTexture = torusComposer.renderTarget1.texture`. `haloTexture`: 1×1 black `DataTexture` (never null).

Per frame render:

```
camera.layers.set(TORUS_SCENE);  torusComposer.render()
camera.layers.set(BLOOM_SCENE);  bloomComposer.render()
camera.layers.set(ENTIRE_SCENE); finalComposer.render()
```

Resize all three composers + renderer + camera aspect.

## Pointer (real mouse, not a scroller)

Listen on `window` (`pointermove`), not the canvas.

- NDC: `x = (clientX / w) * 2 - 1`, `y = -(clientY / h) * 2 + 1`
- Unproject `z = 0.5`, intersect the `z = 0` plane, lerp world cursor `0.12`
- Activity eases toward 1 at `0.06`; after 3s idle eases toward 0 at `0.06`
- `uCursor` = world cursor; `uActivity` = activity

## Per-frame motion

`dt` in seconds. When `document.hidden`, skip updates (pause). Do not advance `t` while hidden.

```
uDrift += dt * ((reduced ? drift * 0.12 : drift) + scroll * scrollDrift)
camera.position = (ndc.x * parallax, ndc.y * parallax, 5 - scroll * scrollPush)
camera.lookAt(ndc.x * parallax, ndc.y * parallax, -10)
group.rotation.z += dt * ((reduced ? spin * 0.12 : spin) + scroll * scrollSpin)
finalPass.iTime = tSeconds
```

Drift + spin run every visible frame even if `scroll === 0`.

## Lifecycle

- Dispose: cancel rAF, remove window / visibility / resize listeners, dispose composers, geometry, material, halo texture, renderer; remove canvas.
- Pause while the window is hidden (`visibilitychange` / `document.hidden`).
- Reduced motion: still the bed; no dive; very slow field.

## Tests (must pass)

1. Mount after Next/Start only (`shouldMountStarfield('hero')` and `'skip'` are false; tour scenes true). Experience source mounts `<OnboardingStarfield` only for those scenes, not Act 1.
2. Dispose path exists and the React effect returns it.
3. WebGL1 failure calls `onUnavailable` and Experience keeps `OnboardingHeroVideo` (never a blank stage).
4. Reduced-motion breath target is 0; engine still constructs the field.
5. No `unpkg`, `jsdelivr`, or `https://` three URL in spec/engine/component.
6. No `#scroll-host`, no `scroll-host`, no `scroll ↓` / `scroll down` hint anywhere in this slice.
7. CONFIG, LAYERS, and all four shader strings match this contract.
8. `breathScrollTarget` / double-damp / `appearOpacity` match the formulas above.

## Quality

Apple-grade, defaults friendly. Power stays in Settings. Do not dump Brain / ASR / Intelligence into this PR. No em dashes in user-facing copy (this bed adds none). Never auto-send. Do not claim READY TO MERGE.
