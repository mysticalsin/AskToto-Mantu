import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH_POLL_MS, BOOT_IPC_TIMEOUT_MS, PERMISSIONS_POLL_MS, startAuthRefreshLoop, startPermissionRefreshLoop, withBootIpcTimeout } from './state'

describe('startPermissionRefreshLoop', () => {
  it('refreshes immediately, polls every PERMISSIONS_POLL_MS, refreshes on focus/visibility, and cleans up', () => {
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

describe('useAuth boot recovery contract', () => {
  it('clears a stale boot error after a later successful auth refresh', () => {
    const source = readFileSync(join(__dirname, 'state.ts'), 'utf8')
    const auth = source.slice(source.indexOf('export function useAuth'), source.indexOf('export const PERMISSIONS_POLL_MS'))
    const refresh = auth.slice(auth.indexOf('const refresh = useCallback'), auth.indexOf('useEffect(() =>'))
    expect(refresh).toMatch(/setStatus\(await window\.toto\.authStatus\(\)\)/)
    expect(refresh).toMatch(/setBootError\(null\)/)
  })
})


describe('FITO-185-G-TIMEOUT withBootIpcTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    await expect(withBootIpcTimeout(Promise.resolve('ok'), 'getSettings', 50)).resolves.toBe('ok')
  })

  it('rejects when the promise hangs past the timeout', async () => {
    vi.useFakeTimers()
    try {
      const hung = new Promise<string>(() => {})
      const pending = withBootIpcTimeout(hung, 'getSettings', BOOT_IPC_TIMEOUT_MS)
      const assertion = expect(pending).rejects.toThrow(/getSettings timed out after 2000ms/)
      await vi.advanceTimersByTimeAsync(BOOT_IPC_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
