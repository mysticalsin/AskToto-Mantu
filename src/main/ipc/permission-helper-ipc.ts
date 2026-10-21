/**
 * permission-helper-ipc.ts — the guided grant helper's IPC and its Electron wiring (C32 Part D).
 *
 * The main window may only ask to open the helper; the helper window may only read its state, start the native
 * drag of the running app, reveal it in Finder, cancel, or relaunch (the normal quit path flushes a live
 * meeting first). Each channel checks its sender: the main window for `open`, the helper's own webContents for
 * the rest. The pane URL comes from the allowlisted permissionSettingsUrl, never from the renderer.
 */
import { app, ipcMain, nativeImage, screen, shell, type NativeImage, type WebContents } from 'electron'
import { join } from 'node:path'
import {
  HELPER_SIZE,
  PERMISSION_HELPER_IPC,
  placeHelper,
  type HelperKind,
  type HelperState,
  type HelperStatus,
  type HelperView
} from '@shared/permission-helper'
import { appBundlePathFromExecPath } from '../capture-permissions/diagnose'
import { devEnv } from '../dev-env'
import { afterPermissionHelperDelay, startPermissionHelperPoll } from '../infra/scheduler/permission-helper-poll'
import { createPermissionHelper, type PermissionHelper } from '../permission-helper'
import { getPlatformPermissions, probeScreenCapture } from '../platform-perms'
import { createPermissionHelperWindow } from '../windows/permission-helper-window'

type AssertMainWindow = (event: Electron.IpcMainInvokeEvent) => void

/** The live status behind a helper. macOS Screen Recording applies to the next process, hence needsRelaunch. */
export async function readHelperStatus(kind: HelperKind, platform: NodeJS.Platform): Promise<HelperStatus> {
  const perms = getPlatformPermissions()
  if (platform === 'darwin') {
    const diagnosis = perms.screenDiagnosis?.state
    if (diagnosis)
      return {
        granted: diagnosis === 'granted' || diagnosis === 'needs-relaunch',
        needsRelaunch: diagnosis !== 'granted'
      }
    return { granted: perms.screenRecording === 'granted', needsRelaunch: true }
  }
  if (kind === 'screenRecording') return { granted: await probeScreenCapture(), needsRelaunch: false }
  return { granted: perms.microphone === 'granted', needsRelaunch: false }
}

export function registerPermissionHelperIpc(deps: {
  assertMainWindow: AssertMainWindow
  paneUrl: (kind: unknown) => string | null
  relaunch: () => void
}): PermissionHelper {
  const platform = process.platform
  const bundle = platform === 'darwin' ? appBundlePathFromExecPath(process.execPath) : null
  let helperContents: WebContents | null = null
  let dragIcon: NativeImage | null = null
  let iconUrl: string | null = null
  // The app's own icon, for the drag image and the helper's app item. Read on first use, never at boot.
  let iconRead: Promise<void> | null = null
  const ensureIcon = (): Promise<void> =>
    (iconRead ??= app
      .getFileIcon(bundle ?? process.execPath, { size: 'normal' })
      .then((icon) => {
        dragIcon = icon
        iconUrl = icon.isEmpty() ? null : icon.toDataURL()
      })
      .catch(() => undefined))
  const view = (state: HelperState): HelperView => ({
    ...state,
    drag: state.drag && !!bundle,
    appName: app.getName(),
    icon: iconUrl
  })

  const helper = createPermissionHelper({
    platform,
    paneUrl: deps.paneUrl,
    openPane: (url) => void shell.openExternal(url),
    readStatus: (kind) => readHelperStatus(kind, platform),
    poll: startPermissionHelperPoll,
    delay: afterPermissionHelperDelay,
    relaunch: deps.relaunch,
    place: (helperPlatform) =>
      placeHelper(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, HELPER_SIZE, helperPlatform),
    showWindow: (_state, at) => {
      const devServer = devEnv('ELECTRON_RENDERER_URL')
      const win = createPermissionHelperWindow({
        bounds: { x: at.x, y: at.y, ...HELPER_SIZE },
        preload: join(__dirname, '../preload/permission-helper.js'),
        devUrl: devServer ? new URL('/permission-helper.html', devServer).toString() : null,
        file: join(__dirname, '../renderer/permission-helper.html')
      })
      helperContents = win.webContents
      return {
        send: (next) => {
          if (!win.isDestroyed()) win.webContents.send(PERMISSION_HELPER_IPC.state, view(next))
        },
        close: () => {
          if (!win.isDestroyed()) win.close()
        },
        onClosed: (listener) =>
          win.on('closed', () => {
            if (helperContents === win.webContents) helperContents = null
            listener()
          })
      }
    }
  })

  const fromHelper = (sender: WebContents): boolean => helperContents !== null && sender === helperContents

  ipcMain.handle(PERMISSION_HELPER_IPC.open, async (e, kind: unknown) => {
    deps.assertMainWindow(e)
    await ensureIcon()
    return helper.open(kind)
  })
  ipcMain.handle(PERMISSION_HELPER_IPC.getState, (e) => {
    const state = helper.state()
    return fromHelper(e.sender) && state ? view(state) : null
  })
  ipcMain.handle(PERMISSION_HELPER_IPC.cancel, (e) => {
    if (fromHelper(e.sender)) helper.cancel()
  })
  ipcMain.handle(PERMISSION_HELPER_IPC.relaunch, (e) => {
    if (fromHelper(e.sender)) helper.relaunch()
  })
  ipcMain.handle(PERMISSION_HELPER_IPC.reveal, (e) => {
    if (fromHelper(e.sender) && bundle) shell.showItemInFolder(bundle)
  })
  // A native file drag of the running app into the System Settings list (Electron requires a non-empty icon).
  ipcMain.on(PERMISSION_HELPER_IPC.startDrag, (e) => {
    if (!fromHelper(e.sender) || !bundle) return
    const icon =
      dragIcon && !dragIcon.isEmpty()
        ? dragIcon
        : nativeImage.createFromPath(join(bundle, 'Contents/Resources/icon.icns'))
    if (icon.isEmpty()) return
    e.sender.startDrag({ file: bundle, icon })
  })
  // Back from System Settings: re-read at once rather than at the next tick.
  app.on('browser-window-focus', () => helper.appActive())
  if (platform === 'darwin') app.on('did-become-active', () => helper.appActive())
  return helper
}
