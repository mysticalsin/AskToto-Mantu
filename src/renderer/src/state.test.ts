import { describe, expect, it, vi } from 'vitest'
import { AUTH_POLL_MS, PERMISSIONS_POLL_MS, startAuthRefreshLoop, startPermissionRefreshLoop } from './state'

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

describe('startAuthRefreshLoop', () => {
  // Regression test for the silent-refresh bug: main/auth.ts revalidates the MSAL session on a 30-min
  // interval and can drop a revoked session at any time, but has no push channel to the renderer.
  // useAuth() used to fetch status once at mount and never again, so the UI kept showing "signed in"
  // long after the main process had actually signed the user out. This loop must poll + refresh on focus.
  it('refreshes immediately, polls every AUTH_POLL_MS, refreshes on focus, and cleans up', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const windowListeners = new Map<string, () => void>()
      const win = {
        addEventListener: vi.fn((type: string, fn: () => void) => windowListeners.set(type, fn)),
        removeEventListener: vi.fn((type: string, fn: () => void) => {
          if (windowListeners.get(type) === fn) windowListeners.delete(type)
        })
      }

      const cleanup = startAuthRefreshLoop(refresh, { window: win })

      expect(refresh).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(AUTH_POLL_MS)
      expect(refresh).toHaveBeenCalledTimes(2)

      windowListeners.get('focus')?.()
      expect(refresh).toHaveBeenCalledTimes(3)

      cleanup()
      vi.advanceTimersByTime(AUTH_POLL_MS * 2)
      windowListeners.get('focus')?.()
      expect(refresh).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
