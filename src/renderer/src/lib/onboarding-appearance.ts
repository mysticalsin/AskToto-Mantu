/**
 * Onboarding appearance picker — Hidden / Island / Bar.
 * Contract: docs/design/ONBOARDING-APPEARANCE.md and DESIGN.md (Onboarding appearance).
 * Pure helpers so the ask, persist, and live preview can be tested without the exclusive stage.
 */
import {
  autoHideOverlayForLayout,
  parseOverlayLayout,
  type OverlayLayout
} from '@shared/overlay-chrome'

export const ONBOARDING_APPEARANCE_HEADING = 'Where should Métis live?'
export const ONBOARDING_APPEARANCE_LEAD =
  'Hidden is the default. Move to the top, then click to open. Change it anytime in Settings.'

export const ONBOARDING_APPEARANCE_COPY: Record<OverlayLayout, { title: string; desc: string }> = {
  hide: {
    title: 'Hidden',
    desc: 'Move to the top, then click to open.'
  },
  island: {
    title: 'Island',
    desc: 'A small island stays visible. Hover opens it.'
  },
  bar: {
    title: 'Bar',
    desc: 'The bar stays on screen.'
  }
}

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

export type AppearancePreviewPhase = 'rest' | 'in' | 'settled' | 'out'

export type AppearancePreviewEvent =
  | 'click-top'
  | 'hover-enter'
  | 'hover-leave'
  | 'spring-in-end'
  | 'spring-out-end'

export function appearancePreviewInitialPhase(layout: OverlayLayout): AppearancePreviewPhase {
  return layout === 'bar' ? 'settled' : 'rest'
}

/** Hidden rest is empty. Island rest is the camera/notch square. Bar is always the mock bar. */
export function appearancePreviewRestKind(layout: OverlayLayout): 'empty' | 'island' | 'bar' {
  if (layout === 'hide') return 'empty'
  if (layout === 'island') return 'island'
  return 'bar'
}

export function appearancePreviewShowsBar(phase: AppearancePreviewPhase): boolean {
  return phase === 'in' || phase === 'settled' || phase === 'out'
}

export function appearancePreviewShowsIsland(layout: OverlayLayout, phase: AppearancePreviewPhase): boolean {
  return layout === 'island' && phase === 'rest'
}

export function appearancePreviewShowsHint(layout: OverlayLayout, phase: AppearancePreviewPhase): boolean {
  return layout === 'hide' && phase === 'rest'
}

/**
 * Live preview only. Hidden is click-to-open (hover does not reveal).
 * Island hover expands. Bar stays settled. No dwell. No overlay park / setBounds.
 */
export function reduceAppearancePreview(
  layout: OverlayLayout,
  phase: AppearancePreviewPhase,
  event: AppearancePreviewEvent
): AppearancePreviewPhase {
  if (layout === 'bar') return 'settled'

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
