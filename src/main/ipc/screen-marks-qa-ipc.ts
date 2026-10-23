import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { QaPlaceMarkInputSchema, SCREEN_MARKS_IPC, type PlaceMarkResult, type ScreenMarkShape } from '@shared/screen-marks'

/**
 * QA-only mark placement (G43): lets the QA build place and clear a mark on a named screenshot, standing in for the
 * walkthrough (G44) and voice side until they place marks through ScreenMarksRuntime.place themselves. Registered only
 * when METIS_QA_SCREEN_MARKS=1 in a non-packaged build; every call is checked against the main window and the schema.
 */
export function registerScreenMarksQaIpc(
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  marks: { place(input: { screenshotId: string; shape: ScreenMarkShape }): PlaceMarkResult; clear(reason: string): void }
): void {
  ipcMain.handle(SCREEN_MARKS_IPC.qaPlace, (event, raw: unknown): PlaceMarkResult | { ok: false; reason: 'invalid' } => {
    assertMainWindow(event)
    const parsed = QaPlaceMarkInputSchema.safeParse(raw)
    return parsed.success ? marks.place(parsed.data) : { ok: false, reason: 'invalid' }
  })
  ipcMain.handle(SCREEN_MARKS_IPC.qaClear, (event) => {
    assertMainWindow(event)
    marks.clear('qa-clear')
    return { ok: true }
  })
}
