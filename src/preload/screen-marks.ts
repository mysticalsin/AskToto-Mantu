import type { IpcRenderer } from 'electron'
import type { PlaceMarkResult, ScreenMarkShape } from '../shared/screen-marks'

/**
 * `window.toto.screenMarks` (G43): the QA-only way for the renderer's walkthrough or voice side to place a mark on a
 * named screenshot. Main registers the handler only under METIS_QA_SCREEN_MARKS=1; otherwise the call rejects and
 * this returns a refusal. Channel names are literals (equal to SCREEN_MARKS_IPC, pinned by a test).
 */
export function createScreenMarksPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  screenMarks: {
    qaPlace(screenshotId: string, shape: ScreenMarkShape): Promise<PlaceMarkResult | { ok: false; reason: 'unavailable' }>
    qaClear(): Promise<{ ok: boolean }>
  }
} {
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
