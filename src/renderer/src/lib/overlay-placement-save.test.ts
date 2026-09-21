import { describe, expect, it, vi } from 'vitest'
import { persistOverlayPlacement } from './overlay-placement-save'

describe('persistOverlayPlacement', () => {
  it('accepts only a durable reply that confirms the requested placement', async () => {
    const patch = vi.fn(async () => ({
      overlayPlacement: 'right-edge' as const,
      overlayLayout: 'island' as const,
      autoHideOverlay: true
    }))
    await expect(persistOverlayPlacement('right-edge', 'bar', patch)).resolves.toBe(true)
    expect(patch).toHaveBeenCalledExactlyOnceWith({
      overlayPlacement: 'right-edge',
      overlayLayout: 'island',
      autoHideOverlay: true
    })
  })

  it('fails closed when a managed policy returns a mismatched layout or auto-hide setting', async () => {
    const mismatchedLayout = vi.fn(async () => ({
      overlayPlacement: 'right-edge' as const,
      overlayLayout: 'bar' as const,
      autoHideOverlay: true
    }))
    const mismatchedAutoHide = vi.fn(async () => ({
      overlayPlacement: 'right-edge' as const,
      overlayLayout: 'island' as const,
      autoHideOverlay: false
    }))
    await expect(persistOverlayPlacement('right-edge', 'bar', mismatchedLayout)).resolves.toBe(false)
    await expect(persistOverlayPlacement('right-edge', 'bar', mismatchedAutoHide)).resolves.toBe(false)
    expect(mismatchedLayout).toHaveBeenCalledOnce()
    expect(mismatchedAutoHide).toHaveBeenCalledOnce()
  })

  it('fails closed when encrypted-profile storage rejects the write', async () => {
    await expect(
      persistOverlayPlacement('right-edge', 'island', async () => {
        throw new Error('keychain unavailable')
      })
    ).resolves.toBe(false)
  })
})
