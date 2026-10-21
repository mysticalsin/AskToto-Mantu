import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { SETTINGS_OS_STATE_IPC } from '@shared/contracts/settings-os-state'

vi.mock('electron', () => ({ app: {}, ipcMain: { handle: vi.fn() }, shell: {}, Notification: {} }))
vi.mock('../recall', () => ({ countExpiredMeetings: vi.fn(async () => 0) }))

import { applyLoginItem, registerSettingsSystemIpc, type SettingsSystemOs } from './settings-system-ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function setup(options: { os?: Partial<SettingsSystemOs>; auth?: boolean; refresh?: () => boolean | null } = {}) {
  const handlers = new Map<string, Handler>()
  const assertMainWindow = vi.fn()
  const os: SettingsSystemOs = {
    platform: 'darwin',
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: true, status: 'enabled' })),
    setLoginItemSettings: vi.fn(),
    notificationsSupported: vi.fn(() => true),
    openExternal: vi.fn(async () => {}),
    ...options.os
  }
  const countExpired = vi.fn(async (days: number) => (days === 30 ? 7 : 0))
  registerSettingsSystemIpc({
    ipcMain: { handle: (channel: string, h: unknown) => void handlers.set(channel, h as Handler) } as Pick<
      IpcMain,
      'handle'
    >,
    assertMainWindow,
    requireAuth: () => options.auth ?? true,
    refreshLoginItem: options.refresh ?? (() => true),
    os,
    countExpired
  })
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.(event, ...args)
  return { handlers, assertMainWindow, os, countExpired, call }
}

const event = { sender: {} } as IpcMainInvokeEvent

beforeEach(() => vi.clearAllMocks())

describe('settings system IPC', () => {
  it('registers three channels and checks the main-window sender on each', async () => {
    const { handlers, assertMainWindow, call } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(SETTINGS_OS_STATE_IPC).sort())
    for (const channel of Object.values(SETTINGS_OS_STATE_IPC)) {
      assertMainWindow.mockClear()
      await call(channel, 'loginItems')
      expect(assertMainWindow, channel).toHaveBeenCalledWith(event)
    }
  })

  it('a sender that fails the main-window check gets nothing', async () => {
    const { assertMainWindow, os, call } = setup()
    assertMainWindow.mockImplementation(() => {
      throw new Error('unauthorized sender')
    })
    await expect(async () => call(SETTINGS_OS_STATE_IPC.openSystemSettings, 'loginItems')).rejects.toThrow()
    expect(os.openExternal).not.toHaveBeenCalled()
  })

  it('reports the OS login-item and notification state, including macOS approval', async () => {
    const { call } = setup({
      os: { getLoginItemSettings: () => ({ openAtLogin: false, status: 'requires-approval' }) },
      refresh: () => false
    })
    expect(await call(SETTINGS_OS_STATE_IPC.osState)).toEqual({
      loginItem: { supported: true, enabled: false, requiresApproval: true },
      notifications: { supported: true }
    })
  })

  it('reports an unreadable login item as unsupported rather than guessing', async () => {
    const { call } = setup({ refresh: () => null, os: { notificationsSupported: () => false } })
    expect(await call(SETTINGS_OS_STATE_IPC.osState)).toEqual({
      loginItem: { supported: false, enabled: false, requiresApproval: false },
      notifications: { supported: false }
    })
  })

  it('opens only allowlisted System Settings panes', async () => {
    const { os, call } = setup()
    await call(SETTINGS_OS_STATE_IPC.openSystemSettings, 'loginItems')
    await call(SETTINGS_OS_STATE_IPC.openSystemSettings, 'notifications')
    await call(SETTINGS_OS_STATE_IPC.openSystemSettings, 'https://attacker.invalid')
    await call(SETTINGS_OS_STATE_IPC.openSystemSettings, { pane: 'loginItems' })
    expect(vi.mocked(os.openExternal).mock.calls).toEqual([
      ['x-apple.systempreferences:com.apple.LoginItems-Settings.extension'],
      ['x-apple.systempreferences:com.apple.preference.notifications']
    ])
  })

  it('counts the meetings a retention window would delete, behind auth and input validation', async () => {
    const { call, countExpired } = setup()
    expect(await call(SETTINGS_OS_STATE_IPC.retentionPreview, 30)).toEqual({ ok: true, expired: 7 })
    expect(await call(SETTINGS_OS_STATE_IPC.retentionPreview, -1)).toMatchObject({ ok: false })
    expect(await call(SETTINGS_OS_STATE_IPC.retentionPreview, '30')).toMatchObject({ ok: false })
    expect(await call(SETTINGS_OS_STATE_IPC.retentionPreview, 1.5)).toMatchObject({ ok: false })
    expect(countExpired).toHaveBeenCalledTimes(1)
    const signedOut = setup({ auth: false })
    expect(await signedOut.call(SETTINGS_OS_STATE_IPC.retentionPreview, 30)).toMatchObject({ ok: false })
    expect(signedOut.countExpired).not.toHaveBeenCalled()
  })
})

describe('C32: Windows panes and Startup apps', () => {
  it('opens the Windows Settings pages for login items and notifications', async () => {
    const { os, call } = setup({ os: { platform: 'win32' } })
    await call(SETTINGS_OS_STATE_IPC.openSystemSettings, 'loginItems')
    await call(SETTINGS_OS_STATE_IPC.openSystemSettings, 'notifications')
    await call(SETTINGS_OS_STATE_IPC.openSystemSettings, 'https://example.com')
    expect(os.openExternal).toHaveBeenNthCalledWith(1, 'ms-settings:startupapps')
    expect(os.openExternal).toHaveBeenNthCalledWith(2, 'ms-settings:notifications')
    expect(os.openExternal).toHaveBeenCalledTimes(2)
  })

  it('a login item turned off in Startup apps needs the person, like macOS approval', async () => {
    const blocked = setup({
      os: {
        platform: 'win32',
        getLoginItemSettings: vi.fn(() => ({ openAtLogin: true, executableWillLaunchAtLogin: false }))
      }
    })
    expect((await blocked.call(SETTINGS_OS_STATE_IPC.osState)) as { loginItem: unknown }).toMatchObject({
      loginItem: { supported: true, enabled: true, requiresApproval: true }
    })
    const allowed = setup({
      os: {
        platform: 'win32',
        getLoginItemSettings: vi.fn(() => ({ openAtLogin: true, executableWillLaunchAtLogin: true }))
      }
    })
    expect((await allowed.call(SETTINGS_OS_STATE_IPC.osState)) as { loginItem: unknown }).toMatchObject({
      loginItem: { requiresApproval: false }
    })
    // Not wanted: Windows reporting it will not launch is just the off state, nothing to approve.
    const off = setup({
      refresh: () => false,
      os: {
        platform: 'win32',
        getLoginItemSettings: vi.fn(() => ({ openAtLogin: false, executableWillLaunchAtLogin: false }))
      }
    })
    expect((await off.call(SETTINGS_OS_STATE_IPC.osState)) as { loginItem: unknown }).toMatchObject({
      loginItem: { enabled: false, requiresApproval: false }
    })
  })
})

describe('applyLoginItem', () => {
  it('re-reads the OS after writing, so a refused login item is never cached as on', () => {
    const refresh = vi.fn(() => false)
    const os = { setLoginItemSettings: vi.fn() } as unknown as SettingsSystemOs
    applyLoginItem(true, refresh, os)
    expect(os.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('still refreshes when the OS throws', () => {
    const refresh = vi.fn(() => null)
    const os = {
      setLoginItemSettings: vi.fn(() => {
        throw new Error('Operation not permitted')
      })
    } as unknown as SettingsSystemOs
    expect(() => applyLoginItem(true, refresh, os)).not.toThrow()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
