import type { IpcRenderer } from 'electron'
import type { PlaceMarkResult, ScreenMarkShape } from '../shared/screen-marks'

declare const __METIS_QA_IDENTITY__: boolean

export interface ScreenMarksQaApi {
  screenMarks: {
    qaPlace(
      screenshotId: string,
      shape: ScreenMarkShape
    ): Promise<PlaceMarkResult | { ok: false; reason: 'unavailable' }>
    qaClear(): Promise<{ ok: boolean }>
  }
}

/**
 * The QA bridge itself. Channel names are literals (equal to QA_SCREEN_MARKS_IPC, pinned by a test) and double as the
 * packaged-bytes marker for the preload bundle. Reached only through createScreenMarksPreloadApi under the QA identity.
 */
export function createScreenMarksQaApi(ipc: Pick<IpcRenderer, 'invoke'>): ScreenMarksQaApi {
  return {
    screenMarks: {
      async qaPlace(screenshotId, shape) {
        try {
          return (await ipc.invoke('screenMarks:qaPlace', { screenshotId, shape })) as PlaceMarkResult
        } catch {
          return { ok: false, reason: 'unavailable' }
        }
      },
      async qaClear() {
        try {
          return (await ipc.invoke('screenMarks:qaClear')) as { ok: boolean }
        } catch {
          return { ok: false }
        }
      }
    }
  }
}

/**
 * `window.toto.screenMarks` (G43) exists only in the QA-identity build: the identity is a compile-time literal, so a
 * shipping preload carries neither the bridge nor its channel names, and scripts/lib/qa-fault-hook.mjs fails packaging
 * if it does. Everywhere else this returns nothing.
 */
export function createScreenMarksPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): Partial<ScreenMarksQaApi> {
  return __METIS_QA_IDENTITY__ ? createScreenMarksQaApi(ipc) : {}
}
