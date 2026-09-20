import {
  DEFAULT_OVERLAY_LAYOUT,
  isOverlayLayout,
  type OverlayLayout
} from './overlay-chrome'
import type { OverlayPlacement } from './overlay-placement'

const TOP_CENTER_LAYOUTS = ['hide', 'island', 'bar'] as const satisfies readonly OverlayLayout[]
const RIGHT_EDGE_LAYOUTS = ['hide', 'island'] as const satisfies readonly Exclude<OverlayLayout, 'bar'>[]

export type OverlayPresentation =
  | { placement: 'top-center'; layout: OverlayLayout; surface: 'top-bar' }
  | { placement: 'right-edge'; layout: Exclude<OverlayLayout, 'bar'>; surface: 'edge-chat' }

export function allowedOverlayLayouts(placement: OverlayPlacement): readonly OverlayLayout[] {
  return placement === 'right-edge' ? RIGHT_EDGE_LAYOUTS : TOP_CENTER_LAYOUTS
}

/**
 * The only place a persisted legacy `right-edge + bar` pairing is adapted for
 * presentation. Storage preserves its original values for backwards compatibility.
 */
export function normalizeOverlayLayoutForPlacement(
  layout: OverlayLayout,
  placement: 'right-edge'
): Exclude<OverlayLayout, 'bar'>
export function normalizeOverlayLayoutForPlacement(
  layout: OverlayLayout,
  placement: 'top-center'
): OverlayLayout
export function normalizeOverlayLayoutForPlacement(
  layout: OverlayLayout,
  placement: OverlayPlacement
): OverlayLayout {
  const normalizedLayout = isOverlayLayout(layout) ? layout : DEFAULT_OVERLAY_LAYOUT
  return placement === 'right-edge' && normalizedLayout === 'bar' ? 'island' : normalizedLayout
}

export function resolveOverlayPresentation(input: {
  placement: OverlayPlacement
  layout: OverlayLayout
}): OverlayPresentation {
  if (input.placement === 'right-edge') {
    return {
      placement: 'right-edge',
      layout: normalizeOverlayLayoutForPlacement(input.layout, input.placement),
      surface: 'edge-chat'
    }
  }
  return {
    placement: 'top-center',
    layout: normalizeOverlayLayoutForPlacement(input.layout, input.placement),
    surface: 'top-bar'
  }
}
