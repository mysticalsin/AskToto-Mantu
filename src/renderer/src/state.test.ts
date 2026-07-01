import { describe, expect, it, vi } from 'vitest'
import { PERMISSIONS_POLL_MS, startPermissionRefreshLoop } from './state'

describe('startPermissionRefreshLoop', () => {
  it('refreshes immediately, polls every 2.5s, refreshes on focus/visibility, and cleans up', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const windowListeners = new Map<string, () => void>()
      const documentListeners = new Map<string, () => void>()
      const win = {
        addEventListener: vi.fn((type: string, fn: () => void) => windowListeners.set(type, fn)),
        removeEventListener: vi.fn((type: string, fn: () => void) => {
          if (windowListeners.get(type) === fn) windowListeners.delete(type)
        })
      }
      const doc = {
        visibilityState: 'visible',
        addEventListener: vi.fn((type: string, fn: () => void) => documentListeners.set(type, fn)),
        removeEventListener: vi.fn((type: string, fn: () => void) => {
          if (documentListeners.get(type) === fn) documentListeners.delete(type)
        })
      }

      const cleanup = startPermissionRefreshLoop(refresh, { window: win, document: doc })

      expect(refresh).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(PERMISSIONS_POLL_MS)
      expect(refresh).toHaveBeenCalledTimes(2)

      windowListeners.get('focus')?.()
      expect(refresh).toHaveBeenCalledTimes(3)

      documentListeners.get('visibilitychange')?.()
      expect(refresh).toHaveBeenCalledTimes(4)

      doc.visibilityState = 'hidden'
      documentListeners.get('visibilitychange')?.()
      expect(refresh).toHaveBeenCalledTimes(4)

      cleanup()
      vi.advanceTimersByTime(PERMISSIONS_POLL_MS * 2)
      windowListeners.get('focus')?.()
      documentListeners.get('visibilitychange')?.()
      expect(refresh).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
