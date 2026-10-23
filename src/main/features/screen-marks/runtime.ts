import { join } from 'node:path'
import { app, screen } from 'electron'
import { devEnv } from '../../dev-env'
import { QA_IDENTITY_BUILD } from '../../qa-identity'
import { qaScreenMarksEnabled, registerScreenMarksQaIpc } from '../../ipc/screen-marks-qa-ipc'
import { createAnnotationWindow } from '../../windows/annotation-window'
import { createScreenMarksRuntimeCore, type ScreenMarksRuntimeCore } from './runtime-core'

/**
 * The real screen marks runtime (G43): displays from Electron, a click-through content-protected window per display,
 * and the screen events that keep them aligned. Build it before the screen observation and spread `.hooks` into it; it registers the QA mark IPC under the QA flag.
 */
export function createScreenMarksRuntime(
  warn: (message: string) => void,
  assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
): ScreenMarksRuntimeCore {
  let n = 0
  const devServer = devEnv('ELECTRON_RENDERER_URL')
  const core = createScreenMarksRuntimeCore({
    displays: () => screen.getAllDisplays().map((d) => ({ id: d.id, bounds: { ...d.bounds } })),
    createWindow: (_displayId, bounds) =>
      createAnnotationWindow({
        bounds,
        preload: join(__dirname, '../preload/annotation.js'),
        devUrl: devServer ? new URL('/annotation.html', devServer).toString() : null,
        file: join(__dirname, '../renderer/annotation.html')
      }),
    newId: () => `mark-${(n += 1)}`,
    warn
  })
  // The screen module is unusable before the app is ready; this runtime is built at module load.
  void app.whenReady().then(() => {
    screen.on('display-added', () => core.displaysChanged())
    screen.on('display-removed', () => core.displaysChanged())
    screen.on('display-metrics-changed', () => core.displaysChanged())
  })
  app.once('will-quit', () => core.destroy('quit'))
  if (
    QA_IDENTITY_BUILD &&
    qaScreenMarksEnabled({ qaIdentity: QA_IDENTITY_BUILD, packaged: app.isPackaged, env: process.env })
  )
    registerScreenMarksQaIpc(assertMainWindow, core)
  return core
}
