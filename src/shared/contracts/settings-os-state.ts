/**
 * settings-os-state.ts — the IPC contract Settings uses to show what macOS (or Windows) actually allows, rather
 * than the app's own cached preference, and to ask before a retention change deletes saved meetings.
 *
 * Apple HIG (Settings, Privacy): a control that depends on a system setting reflects the system's state, and when
 * the system refuses, the app says so in one line with a button that opens the right System Settings pane.
 */
import { z } from 'zod'

export const SETTINGS_OS_STATE_IPC = {
  /** Renderer → main: the current OS login-item and notification state. */
  osState: 'settings:osState',
  /** Renderer → main: open one allowlisted System Settings pane. */
  openSystemSettings: 'settings:openSystemSettings',
  /** Renderer → main: how many saved meetings a retention window would delete. */
  retentionPreview: 'settings:retentionPreview'
} as const

export type LoginItemOsState = {
  /** False when the OS gives Métis no login-item API (unknown platform or a failed read). */
  supported: boolean
  /** What the OS will do at the next login. */
  enabled: boolean
  /** Registered, but the person must allow it: macOS 13+ System Settings › General › Login Items, or Windows
   *  Settings › Apps › Startup (turned off there or in Task Manager). */
  requiresApproval: boolean
}

export type NotificationOsState = {
  /** Whether the OS lets this app post notifications at all (Electron's Notification.isSupported()). */
  supported: boolean
}

export type SettingsOsState = {
  loginItem: LoginItemOsState
  notifications: NotificationOsState
}

export const SystemSettingsPaneSchema = z.enum(['loginItems', 'notifications'])
export type SystemSettingsPane = z.infer<typeof SystemSettingsPaneSchema>

/** Retention windows are whole days; 0 means keep forever. Ten years bounds a hostile value. */
export const RetentionPreviewDaysSchema = z.number().int().min(0).max(3650)

export type RetentionPreviewResult = { ok: true; expired: number } | { ok: false; error: string }

/** settings:set is untyped about refusals; the meetings-folder picker answers with what actually happened. */
export type MeetingsFolderPickResult<Settings = unknown> =
  | { ok: true; settings: Settings }
  | { ok: false; reason: 'cancelled' | 'signed-out' | 'not-writable' }
