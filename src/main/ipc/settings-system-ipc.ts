/**
 * settings-system-ipc.ts — what Settings needs from the operating system (Apple HIG, Settings and Privacy):
 *
 * - the real login-item state, so a toggle shows what macOS will do rather than a cached wish. Notifications are
 *   read only as far as Electron allows: `Notification.isSupported()`. Electron exposes no macOS notification
 *   authorization, so a denial in System Settings is NOT read here (deferred to 2.13: it needs a native helper);
 * - one allowlisted System Settings pane to open when the OS refuses (never an arbitrary renderer URL);
 * - how many saved meetings a shorter retention window would delete, so Settings can ask first.
 *
 * Every handler checks its sender with the caller's assertMainWindow; the meeting count is also auth-gated like
 * every other meetings read. Nothing here writes settings: the login item is still applied by settings:set.
 */
import { Notification, app, ipcMain as electronIpcMain, shell, type IpcMain } from 'electron'
import {
  RetentionPreviewDaysSchema,
  SETTINGS_OS_STATE_IPC,
  SystemSettingsPaneSchema,
  type RetentionPreviewResult,
  type SettingsOsState,
  type SystemSettingsPane
} from '@shared/contracts/settings-os-state'
import { countExpiredMeetings } from '../recall'
import { configureQuietOutput, readQuietPolicy, submitQuietOutput, type QuietOutputDependencies } from '../quiet-output'
import { QUIET_IPC } from '@shared/quiet-ipc'
import { QuietOutputChannelSchema, type QuietAction, type QuietPolicy } from '@shared/quiet-mode-settings'

type AssertMainWindow = (event: Electron.IpcMainInvokeEvent) => void

/** Electron's getLoginItemSettings: `status` is macOS 13+; `executableWillLaunchAtLogin` is Windows, false when
 *  the person turned Métis off in Settings › Apps › Startup (or Task Manager) even though it is registered. */
type LoginItemSettings = { openAtLogin: boolean; status?: string; executableWillLaunchAtLogin?: boolean }

/** The OS calls this module makes, injectable so the handlers are testable without Electron. */
export interface SettingsSystemOs {
  platform: NodeJS.Platform
  getLoginItemSettings: () => LoginItemSettings
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void
  notificationsSupported: () => boolean
  openExternal: (url: string) => Promise<void>
}

const electronOs: SettingsSystemOs = {
  platform: process.platform,
  getLoginItemSettings: () => app.getLoginItemSettings(),
  setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  notificationsSupported: () => Notification.isSupported(),
  openExternal: (url) => shell.openExternal(url)
}

const SYSTEM_SETTINGS_URLS: Partial<Record<NodeJS.Platform, Record<SystemSettingsPane, string>>> = {
  darwin: {
    loginItems: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
    notifications: 'x-apple.systempreferences:com.apple.preference.notifications'
  },
  win32: {
    loginItems: 'ms-settings:startupapps',
    notifications: 'ms-settings:notifications'
  }
}

/** Read the OS state. A failed login-item read reports unsupported rather than guessing. */
export function readSettingsOsState(os: SettingsSystemOs, refreshLoginItem: () => boolean | null): SettingsOsState {
  let loginItem: SettingsOsState['loginItem'] = { supported: false, enabled: false, requiresApproval: false }
  const openAtLogin = refreshLoginItem()
  if (openAtLogin !== null) {
    let read: LoginItemSettings | undefined
    try {
      read = os.getLoginItemSettings()
    } catch {
      read = undefined
    }
    // Either way the person must allow Métis in the OS pane: macOS Login Items approval, or Windows Startup apps.
    const blockedOnWindows = os.platform === 'win32' && openAtLogin && read?.executableWillLaunchAtLogin === false
    loginItem = {
      supported: true,
      enabled: openAtLogin,
      requiresApproval: read?.status === 'requires-approval' || blockedOnWindows
    }
  }
  let notificationsSupported = false
  try {
    notificationsSupported = os.notificationsSupported()
  } catch {
    notificationsSupported = false
  }
  return { loginItem, notifications: { supported: notificationsSupported } }
}

/**
 * Apply a launch-at-login change and re-read what the OS actually did, so the cached state Settings shows can never
 * claim a login item the OS refused (unsigned builds, Login Items approval on macOS 13+).
 */
export function applyLoginItem(
  openAtLogin: boolean,
  refreshLoginItem: () => boolean | null,
  os: SettingsSystemOs = electronOs
): void {
  try {
    os.setLoginItemSettings({ openAtLogin })
  } catch {
    /* not supported on this platform; the refresh below records what is true */
  }
  refreshLoginItem()
}

export interface SettingsSystemIpcDependencies extends QuietOutputDependencies {
  assertMainWindow: AssertMainWindow
  requireAuth: () => boolean
  /** index.ts's login-item cache refresh: reads the OS, updates the cache publicSettings uses, null on failure. */
  refreshLoginItem: () => boolean | null
  ipcMain?: Pick<IpcMain, 'handle'>
  os?: SettingsSystemOs
  countExpired?: (retentionDays: number) => Promise<number>
}

export function registerSettingsSystemIpc(deps: SettingsSystemIpcDependencies): void {
  const { assertMainWindow, requireAuth, refreshLoginItem } = deps
  const ipcMain = deps.ipcMain ?? electronIpcMain
  const os = deps.os ?? electronOs
  const countExpired = deps.countExpired ?? countExpiredMeetings
  configureQuietOutput(deps)

  ipcMain.handle(QUIET_IPC.policyGet, (e): QuietPolicy => {
    assertMainWindow(e)
    return readQuietPolicy()
  })

  ipcMain.handle(QUIET_IPC.outputOffer, (e, rawChannel: unknown): QuietAction => {
    assertMainWindow(e)
    const parsed = QuietOutputChannelSchema.safeParse(rawChannel)
    if (!parsed.success) return 'drop'
    return submitQuietOutput(parsed.data, false, () => {})
  })

  ipcMain.handle(SETTINGS_OS_STATE_IPC.osState, (e): SettingsOsState => {
    assertMainWindow(e)
    return readSettingsOsState(os, refreshLoginItem)
  })

  ipcMain.handle(SETTINGS_OS_STATE_IPC.openSystemSettings, async (e, pane: unknown): Promise<void> => {
    assertMainWindow(e)
    const parsed = SystemSettingsPaneSchema.safeParse(pane)
    const url = parsed.success ? SYSTEM_SETTINGS_URLS[os.platform]?.[parsed.data] : undefined
    if (url) await os.openExternal(url)
  })

  ipcMain.handle(
    SETTINGS_OS_STATE_IPC.retentionPreview,
    async (e, retentionDays: unknown): Promise<RetentionPreviewResult> => {
      assertMainWindow(e)
      if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
      const parsed = RetentionPreviewDaysSchema.safeParse(retentionDays)
      if (!parsed.success) return { ok: false, error: 'Not a retention window.' }
      try {
        return { ok: true, expired: await countExpired(parsed.data) }
      } catch {
        return { ok: false, error: 'Métis could not count the saved meetings.' }
      }
    }
  )
}
