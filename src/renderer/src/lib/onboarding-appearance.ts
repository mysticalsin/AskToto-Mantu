/**
 * Onboarding appearance picker. Hidden, Island, Bar.
 * Contract: docs/design/ONBOARDING-APPEARANCE.md and DESIGN.md (Onboarding appearance).
 * Pure helpers so the ask, persist, and live preview can be tested without the exclusive stage.
 */
import {
  autoHideOverlayForLayout,
  parseOverlayLayout,
  type OverlayLayout
} from '@shared/overlay-chrome'
import { parseOverlayPlacement, type OverlayPlacement } from '@shared/overlay-placement'
import type { PublicSettings } from '@shared/ipc'
import { overlayPlacementSettingsPatch } from './overlay-placement-save'

export const ONBOARDING_POSITION_HEADING = 'Where should Métis sit?'
export const ONBOARDING_POSITION_LEAD =
  'Choose the top of your screen or a sidecar beside your meeting.'
export const ONBOARDING_APPEARANCE_HEADING = 'How should Métis look?'
export const ONBOARDING_APPEARANCE_LEAD =
  'Choose a resting shape. You can change it anytime in Settings.'

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

/** Physical placement is stored independently from the selected visual chrome. */
export function seedOnboardingPlacement(settings?: { overlayPlacement?: unknown } | null): OverlayPlacement {
  return parseOverlayPlacement(settings?.overlayPlacement)
}

export function placementSettingsPatch(
  placement: OverlayPlacement,
  layout: OverlayLayout
): Pick<PublicSettings, 'overlayPlacement' | 'overlayLayout' | 'autoHideOverlay'> {
  return overlayPlacementSettingsPatch(placement, layout)
}

/** Persist one choice and report whether the trusted settings reply confirms it. UI callers may preview optimistically and roll back on false. */
export async function saveOnboardingAppearanceChoice(
  patch: () => Promise<Pick<PublicSettings, 'overlayLayout' | 'overlayPlacement'>>,
  matches: (saved: Pick<PublicSettings, 'overlayLayout' | 'overlayPlacement'>) => boolean
): Promise<boolean> {
  try {
    return matches(await patch())
  } catch {
    return false
  }
}

/** Adopt managed or stored placement until the person makes an in-flow choice. */
export function resolveOnboardingPlacementSync(input: {
  current: OverlayPlacement
  incoming: unknown
  userSelected: boolean
  managed: boolean
}): OverlayPlacement | null {
  const next = parseOverlayPlacement(input.incoming)
  if (next === input.current || (input.userSelected && !input.managed)) return null
  return next
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
 * Right-edge onboarding preview only. The actual sidecar keeps its compact rail
 * at rest; this prevents the preview from claiming that Hidden opens a wide panel.
 */
export function appearancePreviewEdgeState(
  layout: OverlayLayout,
  phase: AppearancePreviewPhase
): { showRail: boolean; showDrawer: boolean; showEdgeGlow: boolean } {
  if (layout === 'hide') {
    return {
      showRail: false,
      showDrawer: phase === 'in' || phase === 'settled' || phase === 'out',
      // Hidden is truly hidden at rest in the production right-edge surface. The onboarding stage keeps
      // only a faint visual cue so the invisible hover target remains learnable without posing as a rail.
      showEdgeGlow: phase === 'rest'
    }
  }
  if (layout !== 'island') return { showRail: false, showDrawer: false, showEdgeGlow: false }
  return {
    showRail: true,
    showDrawer: phase === 'in' || phase === 'settled' || phase === 'out',
    showEdgeGlow: false
  }
}

/** A placement change is a new preview surface even when the layout name is unchanged. */
export function appearancePreviewStateKey(layout: OverlayLayout, rightEdge: boolean): string {
  return `${rightEdge ? 'right-edge' : 'top-center'}:${layout}`
}

/**
 * Live preview only. Top Hidden is click-to-open; its accessible right-edge rail
 * mirrors the runtime sidecar and opens on hover. Island hover expands. Bar stays settled.
 * No dwell. No overlay park / setBounds.
 */
export function reduceAppearancePreview(
  layout: OverlayLayout,
  phase: AppearancePreviewPhase,
  event: AppearancePreviewEvent,
  placement: OverlayPlacement = 'top-center'
): AppearancePreviewPhase {
  if (layout === 'bar') return 'settled'

  switch (event) {
    case 'click-top':
      return phase === 'rest' || phase === 'out' ? 'in' : phase
    case 'hover-enter':
      if (layout === 'hide' && placement !== 'right-edge') return phase
      return phase === 'rest' || phase === 'out' ? 'in' : phase
    case 'hover-leave':
      return phase === 'in' || phase === 'settled' ? 'out' : phase
    case 'spring-in-end':
      return phase === 'in' ? 'settled' : phase
    case 'spring-out-end':
      return phase === 'out' ? 'rest' : phase
  }
}
