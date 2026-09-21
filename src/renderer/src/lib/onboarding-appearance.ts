/**
 * Onboarding appearance 2.0  -  placement first, then chrome.
 * Contract: docs/design/ONBOARDING-APPEARANCE-2.0-LOCK.md
 */
import {
  autoHideOverlayForLayout,
  parseOverlayLayout,
  type OverlayLayout
} from '@shared/overlay-chrome'
import { parseOverlayPlacement, type OverlayPlacement } from '@shared/overlay-placement'
import type { PublicSettings } from '@shared/ipc'

export type OverlayOrbStyle = 'bar' | 'jakub' | 'obsidian'

export const ONBOARDING_PLACEMENT_HEADING = 'Where should Métis sit?'
export const ONBOARDING_PLACEMENT_LEAD = 'Top along the screen, or right beside your meeting.'

export const ONBOARDING_CHROME_HEADING = 'How should it look?'
export const ONBOARDING_CHROME_LEAD = 'Pick the chrome for that edge. Change it anytime in Settings.'

/** @deprecated flat three-card ask  -  superseded by 2.0 two-step */
export const ONBOARDING_APPEARANCE_HEADING = ONBOARDING_PLACEMENT_HEADING
export const ONBOARDING_APPEARANCE_LEAD = ONBOARDING_PLACEMENT_LEAD

export const ONBOARDING_PLACEMENT_COPY: Record<
  OverlayPlacement,
  { title: string; desc: string }
> = {
  'top-center': { title: 'Top', desc: 'Along the top of the screen.' },
  'right-edge': { title: 'Right', desc: 'Along the right edge.' }
}

export const ONBOARDING_PLACEMENTS: readonly OverlayPlacement[] = ['top-center', 'right-edge']

export type OnboardingChromeId =
  | 'hidden'
  | 'bar-hides'
  | 'bar-stays'
  | 'circle'
  | 'jarvis'
  | 'dock'
  | 'dock-hidden'

export type OnboardingChromeSpec = {
  id: OnboardingChromeId
  title: string
  desc: string
  layout: OverlayLayout
  autoHideOverlay: boolean
  overlayOrbStyle: OverlayOrbStyle
  /** Dock only. 'hidden' rests invisibly; the hover band is unchanged, so it stays as reachable. */
  dockRest?: 'sliver' | 'hidden'
  default?: boolean
}

/** Tony voice 2026-09-21: Step2 order Invisible → Pill → Orbs (Circle/Jarvis). */
const STYLE_CHROME: readonly OnboardingChromeSpec[] = [
  {
    id: 'hidden',
    title: 'Invisible',
    desc: 'Nothing on screen until you move to the top.',
    layout: 'hide',
    autoHideOverlay: true,
    overlayOrbStyle: 'jakub',
    default: true
  },
  {
    id: 'bar-stays',
    title: 'Pill',
    desc: 'A slim pill stays along the top.',
    layout: 'bar',
    autoHideOverlay: false,
    overlayOrbStyle: 'bar'
  },
  {
    id: 'circle',
    title: 'Circle',
    desc: 'Thinking orb rest.',
    layout: 'bar',
    autoHideOverlay: false,
    overlayOrbStyle: 'jakub'
  },
  {
    id: 'jarvis',
    title: 'Jarvis',
    desc: 'Particle sphere rest.',
    layout: 'bar',
    autoHideOverlay: false,
    overlayOrbStyle: 'obsidian'
  }
]

/** Right-edge rests + Settings seed. Onboard Step2 order: Invisible → Pill → Orbs. */
const DOCK_CHROME: readonly OnboardingChromeSpec[] = [
  {
    id: 'dock-hidden',
    title: 'Invisible',
    desc: 'Nothing on screen until you reach the edge.',
    layout: 'dock',
    autoHideOverlay: autoHideOverlayForLayout('dock'),
    overlayOrbStyle: 'jakub',
    dockRest: 'hidden',
    default: true
  },
  {
    id: 'dock',
    title: 'Pill',
    desc: 'A slim rail on the edge; hover opens the chat.',
    layout: 'dock',
    autoHideOverlay: autoHideOverlayForLayout('dock'),
    overlayOrbStyle: 'jakub'
  },
  {
    id: 'bar-hides',
    title: 'Hidden bar',
    desc: 'Full bar; tucks away when idle.',
    layout: 'bar',
    autoHideOverlay: true,
    overlayOrbStyle: 'bar'
  }
]

/**
 * Which styles a given edge can actually wear.
 *
 * The top takes everything: a full bar across the top of the screen is what the bar IS. The right edge
 * takes the compact rests and the dock, and deliberately not the two full-bar styles: Bar is an
 * 880-wide horizontal strip, so "full bar on the right edge" is not a placement but a combination that
 * cannot be built, and choosing one saved a top-centre chrome against a right-edge placement, which is
 * how a sliver ended up floating in the middle of the screen.
 *
 * Circle and Jarvis stay on the right on purpose: their REST is a 41px circle, which sits on an edge
 * perfectly well. That is the part of "right-edge park is a geometry duty" that holds.
 */
export function onboardingChromeForPlacement(placement: OverlayPlacement): readonly OnboardingChromeSpec[] {
  // HARD Tony 2026-09-21: Invisible → Pill → Orbs (Circle/Jarvis) on both edges.
  const catalog = [...STYLE_CHROME, ...DOCK_CHROME]
  const order: readonly OnboardingChromeId[] =
    placement === 'right-edge'
      ? ['dock-hidden', 'dock', 'circle', 'jarvis']
      : ['hidden', 'bar-stays', 'circle', 'jarvis']
  return order.map((id) => catalog.find((c) => c.id === id)).filter(
    (c): c is OnboardingChromeSpec => Boolean(c)
  )
}

function chromeCatalog(): readonly OnboardingChromeSpec[] {
  return [...STYLE_CHROME, ...DOCK_CHROME]
}


/** Placement-step demo: never preview default Hidden (3px hint). Show unmistakable Top bar / Right dock. */
export function placementDemoLayout(placement: OverlayPlacement): OverlayLayout {
  return placement === 'right-edge' ? 'dock' : 'bar'
}

export function placementDemoChromeId(placement: OverlayPlacement): OnboardingChromeId {
  return placement === 'right-edge' ? 'dock' : 'bar-stays'
}

export function placementPreviewCaption(placement: OverlayPlacement): string {
  return placement === 'right-edge' ? 'Along the right edge' : 'Along the top'
}

export function defaultChromeId(placement: OverlayPlacement): OnboardingChromeId {
  const list = onboardingChromeForPlacement(placement)
  return (list.find((c) => c.default) ?? list[0]).id
}

export function chromeSpec(placement: OverlayPlacement, id: OnboardingChromeId): OnboardingChromeSpec {
  const hit = chromeCatalog().find((c) => c.id === id)
  if (hit) return hit
  return onboardingChromeForPlacement(placement)[0]
}

/** Infer chrome id from saved settings for seed. */
export function seedOnboardingChrome(
  placement: OverlayPlacement,
  settings?: {
    overlayLayout?: unknown
    autoHideOverlay?: unknown
    overlayOrbStyle?: unknown
    dockRest?: unknown
  } | null
): OnboardingChromeId {
  const layout = parseOverlayLayout(settings?.overlayLayout)
  const orb = (settings?.overlayOrbStyle as OverlayOrbStyle | undefined) ?? 'jakub'
  const autoHide =
    typeof settings?.autoHideOverlay === 'boolean'
      ? settings.autoHideOverlay
      : autoHideOverlayForLayout(layout)

  if (placement === 'right-edge' && layout === 'dock') {
    return settings?.dockRest === 'hidden' ? 'dock-hidden' : 'dock'
  }
  if (layout === 'hide') return 'hidden'
  if (layout === 'bar') {
    if (orb === 'obsidian') return 'jarvis'
    if (orb === 'bar') return 'bar-stays'
    if (orb === 'jakub') return 'circle'
    return autoHide ? 'hidden' : 'bar-stays'
  }
  if (layout === 'island') return 'circle'
  return defaultChromeId(placement)
}

/** @deprecated flat copy map  -  kept for Settings/tests that still import it */
export const ONBOARDING_APPEARANCE_COPY: Record<OverlayLayout, { title: string; desc: string }> = {
  hide: { title: 'Hidden', desc: 'Move to the top, then click to open.' },
  island: { title: 'Island', desc: 'A small island stays visible. Hover opens it.' },
  bar: { title: 'Bar', desc: 'The bar stays on screen.' },
  dock: { title: 'Dock', desc: 'A tall panel on the edge. Hover opens it.' }
}

/** @deprecated Island omitted from onboarding 2.0 */
export const ONBOARDING_APPEARANCE_LAYOUTS: readonly OverlayLayout[] = ['hide', 'bar', 'dock']

export function seedOnboardingAppearance(settings?: { overlayLayout?: unknown } | null): OverlayLayout {
  return parseOverlayLayout(settings?.overlayLayout)
}

export function appearanceSettingsPatch(layout: OverlayLayout): {
  overlayLayout: OverlayLayout
  autoHideOverlay: boolean
} {
  return {
    overlayLayout: layout,
    autoHideOverlay: autoHideOverlayForLayout(layout)
  }
}

export function chromeSettingsPatch(
  placement: OverlayPlacement,
  id: OnboardingChromeId
): {
  overlayLayout: OverlayLayout
  autoHideOverlay: boolean
  overlayOrbStyle: OverlayOrbStyle
  overlayPlacement: OverlayPlacement
  dockRest: 'sliver' | 'hidden'
} {
  const spec = chromeSpec(placement, id)
  return {
    overlayLayout: spec.layout,
    autoHideOverlay: spec.autoHideOverlay,
    overlayOrbStyle: spec.overlayOrbStyle,
    overlayPlacement: placement,
    // Always written, never left to whatever a previous run happened to store: picking the visible
    // Dock after the invisible one must actually bring the sliver back.
    dockRest: spec.dockRest ?? 'sliver'
  }
}

export function seedOnboardingPlacement(settings?: { overlayPlacement?: unknown } | null): OverlayPlacement {
  return parseOverlayPlacement(settings?.overlayPlacement)
}

export function placementSettingsPatch(placement: OverlayPlacement): { overlayPlacement: OverlayPlacement } {
  return { overlayPlacement: placement }
}

/** Persist one choice and report whether the trusted settings reply confirms it. UI callers may preview optimistically and roll back on false. */
export async function saveOnboardingAppearanceChoice(
  patch: () => Promise<
    Pick<PublicSettings, 'overlayLayout' | 'overlayPlacement'> &
      Partial<Pick<PublicSettings, 'autoHideOverlay' | 'overlayOrbStyle'>>
  >,
  matches: (
    saved: Pick<PublicSettings, 'overlayLayout' | 'overlayPlacement'> &
      Partial<Pick<PublicSettings, 'autoHideOverlay' | 'overlayOrbStyle'>>
  ) => boolean
): Promise<boolean> {
  try {
    return matches(await patch())
  } catch {
    return false
  }
}

export function resolveOnboardingPlacementSync(input: {
  current: OverlayPlacement
  incoming: unknown
  userSelected: boolean
  managed: boolean
}): OverlayPlacement | null {
  const next = parseOverlayPlacement(input.incoming)
  if (input.managed) return next
  if (input.userSelected) return null
  return next !== input.current ? next : null
}

export type AppearancePreviewPhase = 'rest' | 'in' | 'settled' | 'out'

export type AppearancePreviewEvent =
  | 'click-top'
  | 'hover-enter'
  | 'hover-leave'
  | 'spring-in-end'
  | 'spring-out-end'

export function appearancePreviewInitialPhase(layout: OverlayLayout): AppearancePreviewPhase {
  // Tony FAIL 2026-09-21: dock must NOT open as a fat whitish panel on first paint.
  // Pill rests as a slim rail; Invisible stays empty (soft edge glow). Hover opens.
  if (layout === 'bar') return 'settled'
  if (layout === 'dock') return 'rest'
  return 'rest'
}

export function appearancePreviewRestKind(layout: OverlayLayout): 'empty' | 'island' | 'bar' | 'dock' {
  if (layout === 'hide') return 'empty'
  if (layout === 'island') return 'island'
  if (layout === 'dock') return 'dock'
  return 'bar'
}

export function appearancePreviewShowsBar(phase: AppearancePreviewPhase): boolean {
  return phase === 'in' || phase === 'settled' || phase === 'out'
}

export function appearancePreviewShowsIsland(layout: OverlayLayout, phase: AppearancePreviewPhase): boolean {
  return layout === 'island' && phase === 'rest'
}

export function appearancePreviewShowsDock(
  layout: OverlayLayout,
  phase: AppearancePreviewPhase,
  chromeId?: OnboardingChromeId
): boolean {
  if (layout !== 'dock') return false
  // Invisible (dock-hidden): soft edge glow via desktop CSS only - never a dock slab.
  if (chromeId === 'dock-hidden') return false
  // Pill: slim rail at rest; open panel only while hovering / settling.
  return phase === 'settled' || phase === 'in' || phase === 'out' || phase === 'rest'
}

/** Fat open sidecar is only for Pill hover demo - never Invisible, never first paint. */
export function appearancePreviewDockOpen(
  chromeId: OnboardingChromeId,
  phase: AppearancePreviewPhase
): boolean {
  if (chromeId === 'dock-hidden') return false
  if (chromeId !== 'dock') return false
  return phase === 'settled' || phase === 'in'
}

export function appearancePreviewShowsHint(layout: OverlayLayout, phase: AppearancePreviewPhase): boolean {
  return layout === 'hide' && phase === 'rest'
}

export function appearancePreviewShowsCircle(
  chromeId: OnboardingChromeId,
  phase: AppearancePreviewPhase
): boolean {
  return (chromeId === 'circle' || chromeId === 'jarvis') && appearancePreviewShowsBar(phase)
}

export function reduceAppearancePreview(
  layout: OverlayLayout,
  phase: AppearancePreviewPhase,
  event: AppearancePreviewEvent
): AppearancePreviewPhase {
  if (layout === 'bar') return 'settled'
  if (layout === 'dock') {
    switch (event) {
      case 'hover-enter':
        return phase === 'rest' || phase === 'out' ? 'in' : phase
      case 'hover-leave':
        return phase === 'in' || phase === 'settled' ? 'out' : phase
      case 'spring-in-end':
        return phase === 'in' ? 'settled' : phase
      case 'spring-out-end':
        return phase === 'out' ? 'rest' : phase
      case 'click-top':
        return phase
    }
  }

  switch (event) {
    case 'click-top':
      return phase === 'rest' || phase === 'out' ? 'in' : phase
    case 'hover-enter':
      if (layout === 'hide') return phase
      return phase === 'rest' || phase === 'out' ? 'in' : phase
    case 'hover-leave':
      return phase === 'in' || phase === 'settled' ? 'out' : phase
    case 'spring-in-end':
      return phase === 'in' ? 'settled' : phase
    case 'spring-out-end':
      return phase === 'out' ? 'rest' : phase
  }
}
