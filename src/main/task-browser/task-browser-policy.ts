/**
 * Task browser policy (G41): what the Métis-owned task window may do. Pure, so it is tested without Electron.
 *
 * - The window runs sandboxed with context isolation, no Node, and NO preload: no bridge to Métis's privileged APIs.
 * - Only https pages load. Credentials in the address, other schemes (file, http, data, javascript, blob, métis) refuse.
 * - Camera, microphone, location, notifications and every other permission are denied. Downloads are cancelled.
 * - A page is data, never instructions (G36): nothing here lets page content change what the task does.
 */
import type { WebPreferences } from 'electron'
import { fnv1a } from '@shared/hash'
import { TASK_BROWSER_PARTITION } from '@shared/task-browser'

export function taskBrowserWebPreferences(devTools: boolean): WebPreferences {
  return {
    partition: TASK_BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools
  }
}

const MAX_URL_LENGTH = 4096

/** The parsed address when it may load in the task window, else null. */
export function allowedTaskBrowserUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.hostname.length === 0 || url.username !== '' || url.password !== '') return null
  return url
}

/** The origin and a hash of the full address: all a receipt keeps of where the window went. */
export function taskBrowserUrlFingerprint(url: URL): { origin: string; urlHash: string } {
  return { origin: url.origin, urlHash: fnv1a(url.href).toString(16).padStart(8, '0') }
}

/** The slice of an Electron Session the policy sets. */
export interface TaskBrowserSessionLike {
  setPermissionRequestHandler(handler: (...args: unknown[]) => void): void
  setPermissionCheckHandler(handler: () => boolean): void
  setDevicePermissionHandler(handler: () => boolean): void
  on(event: 'will-download', listener: (event: { preventDefault(): void }, item: { cancel(): void }) => void): unknown
}

/** Deny every permission request and check, and cancel every download. Idempotent per session. */
export function applyTaskBrowserSessionPolicy(session: TaskBrowserSessionLike): void {
  session.setPermissionRequestHandler((...args: unknown[]) => {
    const callback = args[2]
    if (typeof callback === 'function') (callback as (granted: boolean) => void)(false)
  })
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.on('will-download', (event, item) => {
    event.preventDefault()
    item.cancel()
  })
}
