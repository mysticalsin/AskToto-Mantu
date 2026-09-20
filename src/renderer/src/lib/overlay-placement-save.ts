import type { PublicSettings } from '@shared/ipc'
import { autoHideOverlayForLayout, type OverlayLayout } from '@shared/overlay-chrome'
import type { OverlayPlacement } from '@shared/overlay-placement'
import { resolveOverlayPresentation } from '@shared/overlay-presentation'

export type OverlayPlacementSettingsPatch = Pick<
  PublicSettings,
  'overlayPlacement' | 'overlayLayout' | 'autoHideOverlay'
>

/** Build the one atomic patch for a position change without adding per-position layout memory. */
export function overlayPlacementSettingsPatch(
  placement: OverlayPlacement,
  layout: OverlayLayout
): OverlayPlacementSettingsPatch {
  const overlayLayout = resolveOverlayPresentation({ layout, placement }).layout
  return {
    overlayPlacement: placement,
    overlayLayout,
    autoHideOverlay: autoHideOverlayForLayout(overlayLayout)
  }
}

/** Confirm a position change rather than optimistically claiming that a protected-profile write landed. */
export async function persistOverlayPlacement(
  id: OverlayPlacement,
  layout: OverlayLayout,
  patch: (next: Partial<PublicSettings>) => Promise<OverlayPlacementSettingsPatch>
): Promise<boolean> {
  try {
    const next = overlayPlacementSettingsPatch(id, layout)
    const saved = await patch(next)
    return (
      saved.overlayPlacement === next.overlayPlacement &&
      saved.overlayLayout === next.overlayLayout &&
      saved.autoHideOverlay === next.autoHideOverlay
    )
  } catch {
    return false
  }
}
