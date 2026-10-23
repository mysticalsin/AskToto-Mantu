import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { PlaceMarkResult, ScreenMarkShape } from '@shared/screen-marks'
import { QA_SCREEN_MARKS_ENV, QA_SCREEN_MARKS_IPC, QaPlaceMarkInputSchema } from '@shared/screen-marks-qa'

/**
 * QA-only mark placement (G43): lets the QA build place and clear a mark on a named screenshot, standing in for the
 * walkthrough (G44) and voice side until they place marks through ScreenMarksRuntime.place themselves. Registered only
 * for a packaged QA-identity build on an isolated profile with METIS_QA_SCREEN_MARKS=1 (same rule as the V08 desktop sink); every call is checked against the main window and the schema.
 */
export function registerScreenMarksQaIpc(
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  marks: {
    place(input: { screenshotId: string; shape: ScreenMarkShape }): PlaceMarkResult
    clear(reason: string): void
  }
): void {
  ipcMain.handle(
    QA_SCREEN_MARKS_IPC.place,
    (event, raw: unknown): PlaceMarkResult | { ok: false; reason: 'invalid' } => {
      assertMainWindow(event)
      const parsed = QaPlaceMarkInputSchema.safeParse(raw)
      return parsed.success ? marks.place(parsed.data) : { ok: false, reason: 'invalid' }
    }
  )
  ipcMain.handle(QA_SCREEN_MARKS_IPC.clear, (event) => {
    assertMainWindow(event)
    marks.clear('qa-clear')
    return { ok: true }
  })
}

/**
 * On only for a packaged QA-identity build running on an isolated profile (ASKTOTO_USERDATA) with the value `1`: the
 * V08 rule (qa-voice-hooks.ts). The QA identity is a compile-time literal, so shipping bytes carry none of this;
 * devEnv() is not used because it returns nothing in a packaged build, which is exactly where the QA build runs.
 */
export function qaScreenMarksEnabled(input: {
  qaIdentity: boolean
  packaged: boolean
  env: Readonly<Record<string, string | undefined>>
}): boolean {
  const { qaIdentity, packaged, env } = input
  return qaIdentity && packaged && Boolean(env.ASKTOTO_USERDATA?.trim()) && env[QA_SCREEN_MARKS_ENV]?.trim() === '1'
}
