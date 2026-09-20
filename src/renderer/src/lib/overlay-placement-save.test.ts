import { describe, expect, it, vi } from 'vitest'
import { persistOverlayPlacement } from './overlay-placement-save'

describe('persistOverlayPlacement', () => {
  it('accepts only a durable reply that confirms the requested placement', async () => {
    const patch = vi.fn(async () => ({ overlayPlacement: 'right-edge' as const }))
    await expect(persistOverlayPlacement('right-edge', patch)).resolves.toBe(true)
    expect(patch).toHaveBeenCalledWith({ overlayPlacement: 'right-edge' })
  })

  it('fails closed when a managed policy returns an unchanged placement', async () => {
    await expect(
      persistOverlayPlacement('right-edge', async () => ({ overlayPlacement: 'top-center' }))
    ).resolves.toBe(false)
  })

  it('fails closed when encrypted-profile storage rejects the write', async () => {
    await expect(
      persistOverlayPlacement('right-edge', async () => {
        throw new Error('keychain unavailable')
      })
    ).resolves.toBe(false)
  })
})
