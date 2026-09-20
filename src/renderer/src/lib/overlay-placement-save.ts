import type { PublicSettings } from '@shared/ipc'
import type { OverlayPlacement } from '@shared/overlay-placement'

/** Confirm a position change rather than optimistically claiming that a protected-profile write landed. */
export async function persistOverlayPlacement(
  id: OverlayPlacement,
  patch: (next: Partial<PublicSettings>) => Promise<Pick<PublicSettings, 'overlayPlacement'>>
): Promise<boolean> {
  try {
    return (await patch({ overlayPlacement: id })).overlayPlacement === id
  } catch {
    return false
  }
}
