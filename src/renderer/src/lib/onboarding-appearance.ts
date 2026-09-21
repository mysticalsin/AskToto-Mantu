/**
 * Onboarding appearance 2.0 — placement first, then chrome.
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

/** @deprecated flat three-card ask — superseded by 2.0 two-step */
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

export type OnboardingChromeSpec = {
  id: OnboardingChromeId
  title: string
  desc: string
  layout: OverlayLayout
  autoHideOverlay: boolean
  overlayOrbStyle: OverlayOrbStyle
  default?: boolean
}

const TOP_CHROME: readonly OnboardingChromeSpec[] = [
  {
    id: 'hidden',
    title: 'Hidden',
    desc: 'Move to the top, then click to open.',
    layout: 'hide',
    autoHideOverlay: true,
    overlayOrbStyle: 'jakub',
    default: true
  },
  {
    id: 'bar-hides',
    title: 'Full bar that hides',
    desc: 'Full bar; tucks away when idle.',
    layout: 'bar',
    autoHideOverlay: true,
    overlayOrbStyle: 'bar'
  },
  {
    id: 'bar-stays',
    title: 'Full bar that stays',
    desc: 'Full bar stays on screen.',
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
    title: 'Jarvis circle',
    desc: 'Particle sphere rest.',
    layout: 'bar',
    autoHideOverlay: false,
    overlayOrbStyle: 'obsidian'
  }
]

const RIGHT_CHROME: readonly OnboardingChromeSpec[] = [
  {
    id: 'dock',
    title: 'Dock',
    desc: 'Tall sidecar; hover opens.',
    layout: 'dock',
    autoHideOverlay: autoHideOverlayForLayout('dock'),
    overlayOrbStyle: 'jakub',
    default: true
  },
  {
    id: 'bar-hides',
    title: 'Full bar that hides',
    desc: 'Full bar on the edge; tucks away.',
    layout: 'bar',
    autoHideOverlay: true,
    overlayOrbStyle: 'bar'
  },
  {
    id: 'bar-stays',
    title: 'Full bar that stays',
    desc: 'Full bar stays visible.',
    layout: 'bar',
    autoHideOverlay: false,
    overlayOrbStyle: 'bar'
  },
  {
    id: 'circle',
    title: 'Circle',
    desc: 'Circle rest on the edge.',
    layout: 'bar',
    autoHideOverlay: false,
    overlayOrbStyle: 'jakub'
  },
  {
    id: 'jarvis',
    title: 'Jarvis circle',
    desc: 'Jarvis rest on the edge.',
    layout: 'bar',
    autoHideOverlay: false,
    overlayOrbStyle: 'obsidian'
  }
]

export function onboardingChromeForPlacement(placement: OverlayPlacement): readonly OnboardingChromeSpec[] {
  return placement === 'right-edge' ? RIGHT_CHROME : TOP_CHROME
}

export function defaultChromeId(placement: OverlayPlacement): OnboardingChromeId {
  const list = onboardingChromeForPlacement(placement)
  return (list.find((c) => c.default) ?? list[0]).id
}

export function chromeSpec(placement: OverlayPlacement, id: OnboardingChromeId): OnboardingChromeSpec {
  const hit = onboardingChromeForPlacement(placement).find((c) => c.id === id)
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
  } | null
): OnboardingChromeId {
  const layout = parseOverlayLayout(settings?.overlayLayout)
  const orb = (settings?.overlayOrbStyle as OverlayOrbStyle | undefined) ?? 'jakub'
  const autoHide =
    typeof settings?.autoHideOverlay === 'boolean'
      ? settings.autoHideOverlay
      : autoHideOverlayForLayout(layout)

  if (placement === 'right-edge' && layout === 'dock') return 'dock'
  if (layout === 'hide') return 'hidden'
  if (layout === 'bar') {
    if (orb === 'obsidian') return 'jarvis'
    if (orb === 'jakub') return 'circle'
    return autoHide ? 'bar-hides' : 'bar-stays'
  }
  if (layout === 'island') return placement === 'right-edge' ? 'dock' : 'hidden'
  return defaultChromeId(placement)
}

/** @deprecated flat copy map — kept for Settings/tests that still import it */
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
} {
  const spec = chromeSpec(placement, id)
  return {
    overlayLayout: spec.layout,
    autoHideOverlay: spec.autoHideOverlay,
    overlayOrbStyle: spec.overlayOrbStyle,
    overlayPlacement: placement
  }
}

export function seedOnboardingPlacement(settings?: { overlayPlacement?: unknown } | null): OverlayPlacement {
  return parseOverlayPlacement(settings?.overlayPlacement)
}

export function placementSettingsPatch(placement: OverlayPlacement): { overlayPlacement: OverlayPlacement } {
  return { overlayPlacement: placement }
}

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
  if (layout === 'bar' || layout === 'dock') return 'settled'
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

export function appearancePreviewShowsDock(layout: OverlayLayout, phase: AppearancePreviewPhase): boolean {
  return layout === 'dock' && (phase === 'settled' || phase === 'in' || phase === 'out' || phase === 'rest')
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
