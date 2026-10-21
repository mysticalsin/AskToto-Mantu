/**
 * permission-ask.ts — when Métis may raise a macOS permission prompt, and when it re-checks one (C26, Apple HIG).
 *
 * HIG Privacy: request access only at the moment of need, after explaining why, and never in a loop after a
 * Deny; when the person comes back from System Settings, the app reflects the new state without being asked.
 */
import type { PermissionStatus } from '@shared/screen-permission'

export interface AppActiveEnv {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
}

/**
 * Run `recheck` whenever Métis becomes active again: its window regains focus (back from System Settings or the
 * system alert) or the page becomes visible. It does not run on subscribe, so a caller's own staged first read
 * keeps its timing. Returns the unsubscribe.
 */
export function onAppActive(recheck: () => void, env: AppActiveEnv = { window, document }): () => void {
  const onFocus = (): void => recheck()
  const onVisibility = (): void => {
    if (env.document.visibilityState === 'visible') recheck()
  }
  env.window.addEventListener('focus', onFocus)
  env.document.addEventListener('visibilitychange', onVisibility)
  return () => {
    env.window.removeEventListener('focus', onFocus)
    env.document.removeEventListener('visibilitychange', onVisibility)
  }
}

/** pending = status not read yet; meter = open the microphone; test = offer Test Microphone; denied = deep link. */
export type MicMeterMode = 'pending' | 'meter' | 'test' | 'denied'

/**
 * Settings → Audio's level meter opens the microphone only when access is already granted. A not-determined
 * microphone waits for Test Microphone. On macOS that asks main for the prompt and the meter follows the
 * answer. Windows has no main-process ask, so there the test itself opens the meter: getUserMedia is what
 * resolves consent. A denied microphone never opens or asks again.
 */
export function micMeterMode(
  status: PermissionStatus | null | undefined,
  opts: { tested: boolean; windows: boolean }
): MicMeterMode {
  if (status == null) return 'pending'
  if (status === 'granted' || status === 'not-required') return 'meter'
  if (status === 'denied') return 'denied'
  return opts.tested && opts.windows ? 'meter' : 'test'
}
