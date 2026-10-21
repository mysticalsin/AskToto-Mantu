import { contextBridge, ipcRenderer } from 'electron'
import type { HelperView, PermissionHelperApi } from '@shared/permission-helper'

/**
 * Preload for the guided grant helper window (C32 Part D) — deliberately tiny: read its state, start the native
 * drag of Métis, reveal Métis in Finder, cancel, relaunch. Nothing else of the overlay's API is reachable here.
 *
 * Channel names are string literals ON PURPOSE (they equal PERMISSION_HELPER_IPC in @shared/permission-helper,
 * pinned by a test): a value import shared with the main preload would make Rollup split a chunk, and a
 * sandboxed preload cannot require() secondary chunks. Type-only imports are erased and safe.
 */
const api: PermissionHelperApi = {
  getState: (): Promise<HelperView | null> => ipcRenderer.invoke('permissionHelper:getState'),
  onState: (listener: (state: HelperView) => void): (() => void) => {
    const handler = (_event: unknown, state: HelperView): void => listener(state)
    ipcRenderer.on('permissionHelper:state', handler)
    return () => ipcRenderer.removeListener('permissionHelper:state', handler)
  },
  startDrag: (): void => ipcRenderer.send('permissionHelper:startDrag'),
  reveal: (): Promise<void> => ipcRenderer.invoke('permissionHelper:reveal'),
  cancel: (): Promise<void> => ipcRenderer.invoke('permissionHelper:cancel'),
  relaunch: (): Promise<void> => ipcRenderer.invoke('permissionHelper:relaunch')
}

contextBridge.exposeInMainWorld('metisHelper', api)
