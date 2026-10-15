import type { IpcMainInvokeEvent } from 'electron'
import { app, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { getDustRefreshToken, hasKeysMap, resetCredentialReadCachesAfterProfileUnlock } from '../store'
import {
  authorizeMacKeychainUnlock,
  KeychainKeyRecoveryError,
  MacKeychainUnlockRequiredError,
  prepareFileKeyForWrite,
  resetMacKeychainUnlockAuthorization
} from '../secrets'
import { reloadSessionAfterProfileUnlock } from '../auth'

/** Register the visible-consent unlock action in the IPC layer. */
export function registerMacProfileUnlockIpc(
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  publicSettingsWithSpeakerPolicy: () => unknown,
  getMainWindow: () => { isDestroyed: () => boolean; webContents: { send: (channel: string) => void } } | null,
  unlockStartupAfterProfileUnlock: () => void
): void {
  ipcMain.handle(IPC.settingsUnlockProfile, (event) => {
    assertMainWindow(event)
    authorizeMacKeychainUnlock()
    try {
      prepareFileKeyForWrite()
      reloadSessionAfterProfileUnlock()
      resetCredentialReadCachesAfterProfileUnlock()
      void hasKeysMap()
      void getDustRefreshToken()
      const settings = publicSettingsWithSpeakerPolicy()
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.settingsChanged)
      unlockStartupAfterProfileUnlock()
      return settings
    } catch (error) {
      resetMacKeychainUnlockAuthorization()
      resetCredentialReadCachesAfterProfileUnlock()
      if (app.isPackaged && process.platform === 'darwin' && error instanceof KeychainKeyRecoveryError) {
        throw new MacKeychainUnlockRequiredError()
      }
      throw error
    }
  })
}
