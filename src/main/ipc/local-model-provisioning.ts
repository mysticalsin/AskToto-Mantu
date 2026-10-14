import { IPC } from '@shared/ipc'
import { provisionExplicitLocalModel, type ExplicitLocalModelSettingsSnapshot } from '../local-model-provisioning'

type LocalModelEnsureEvent = Electron.IpcMainInvokeEvent
type LocalModelEnsureIpcMain = Pick<Electron.IpcMain, 'handle'>

/** Register the explicit local-model request at the IPC boundary. */
export function registerExplicitLocalModelEnsure(options: {
  ipcMain: LocalModelEnsureIpcMain
  assertMainWindow: (event: LocalModelEnsureEvent) => void
  runtimeAvailable: () => Promise<boolean>
  captureActive: () => boolean
  captureIdentity: () => string
  localModelIdentity: () => string
  currentModelPolicyIdentity: () => string
  readSettings: () => Promise<ExplicitLocalModelSettingsSnapshot>
  ensure: (modelId: string, authorized: () => Promise<boolean>, validateCurrent: () => boolean) => Promise<boolean>
  onReady: () => void
  onFailure: (error: unknown) => void
}): void {
  options.ipcMain.handle(IPC.localModelsEnsure, async (event) => {
    options.assertMainWindow(event)
    try {
      return {
        ok: await provisionExplicitLocalModel({
          runtimeAvailable: options.runtimeAvailable,
          captureActive: options.captureActive,
          captureIdentity: options.captureIdentity,
          localModelIdentity: options.localModelIdentity,
          currentModelPolicyIdentity: options.currentModelPolicyIdentity,
          readSettings: options.readSettings,
          ensure: options.ensure,
          onReady: options.onReady
        })
      }
    } catch (error) {
      options.onFailure(error)
      return { ok: false }
    }
  })
}
