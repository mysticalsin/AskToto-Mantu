import type { BrowserWindow } from 'electron'
import { createMainPersistenceBootstrap, PERSISTENCE_NATIVE_KEY_INTENT } from './bootstrap'
import {
  captureMainSpeechPackRoot,
  type MainSpeechPackRootLease,
  type MainSpeechPackRootMode
} from './main-speech-pack-root'

let bootstrap: ReturnType<typeof createMainPersistenceBootstrap> | null = null
let mainWindow: BrowserWindow | null = null
let firstShowObserved = false
let mainWindowGeneration = 0

function ensureBootstrap(): void {
  if (bootstrap) return
  bootstrap = createMainPersistenceBootstrap({
    nativeKeyIntent: PERSISTENCE_NATIVE_KEY_INTENT,
    afterFirstShow: () => firstShowObserved && !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
  })
  if (firstShowObserved) void bootstrap.prime()
}

/** The existing main-window owner calls this for its actual window, never auxiliary windows. */
export function bindMainPersistenceWindow(window: BrowserWindow): void {
  if (mainWindow !== window) mainWindowGeneration += 1
  mainWindow = window
  window.once('show', () => {
    firstShowObserved = true
    void bootstrap?.prime()
  })
  if (window.isVisible()) firstShowObserved = true
  ensureBootstrap()
}

/** Main-action facade with a first-show lease bound to this exact window instance. */
export function captureMainSpeechPackPurposeRoot(mode: MainSpeechPackRootMode): Promise<MainSpeechPackRootLease> {
  const capturedWindow = mainWindow
  const capturedGeneration = mainWindowGeneration
  return captureMainSpeechPackRoot(mode, {
    afterFirstShow: () =>
      firstShowObserved &&
      mainWindow === capturedWindow &&
      mainWindowGeneration === capturedGeneration &&
      !!capturedWindow &&
      !capturedWindow.isDestroyed() &&
      capturedWindow.isVisible()
  })
}

/** Existing app-quit owner composes this after its accepted final-tail flush. */
export function persistenceQuitOwner(): Pick<ReturnType<typeof createMainPersistenceBootstrap>, 'dispose'> | null {
  return bootstrap
}
