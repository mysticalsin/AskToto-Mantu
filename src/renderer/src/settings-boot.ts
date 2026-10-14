import { useEffect } from 'react'
import type { PublicSettings } from '@shared/ipc'
import { isMacKeychainUnlockMessage } from '@shared/encrypted-profile-recovery'

export const BOOT_IPC_TIMEOUT_MS = 2000
export const BOOT_DEADLINE_MS = 15_000

export function withBootIpcTimeout<T>(promise: Promise<T>, label: string, ms = BOOT_IPC_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function useSettingsBoot(
  refresh: () => Promise<void>,
  setSettings: (settings: PublicSettings) => void,
  setBootError: (message: string | null) => void
): void {
  useEffect(() => {
    let cancelled = false
    const deadline = Date.now() + BOOT_DEADLINE_MS
    void (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const settings = await withBootIpcTimeout(window.toto.getSettings(), 'getSettings')
          if (!cancelled) {
            setSettings(settings)
            setBootError(null)
          }
          return
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isMacKeychainUnlockMessage(message)) {
            if (!cancelled) setBootError(message)
            return
          }
          if (attempt >= 20 || Date.now() >= deadline) {
            console.error('[boot] getSettings failed after retries; app cannot start', error)
            if (!cancelled) setBootError(message)
            return
          }
          const wait = Math.min(150 * (attempt + 1), 1500, Math.max(0, deadline - Date.now()))
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
    })()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    const unsubscribe = window.toto.onSettingsChanged(onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      unsubscribe()
    }
  }, [refresh, setSettings, setBootError])
}
