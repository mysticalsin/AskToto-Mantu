import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { SETTINGS_OS_STATE_IPC } from '@shared/contracts/settings-os-state'
import { QUIET_IPC } from '@shared/quiet-ipc'

vi.mock('electron', () => ({ app: {}, ipcMain: { handle: vi.fn() }, shell: {}, Notification: {} }))
vi.mock('../recall', () => ({ countExpiredMeetings: vi.fn(async () => 0) }))

import { applyLoginItem, registerSettingsSystemIpc, type SettingsSystemOs } from './settings-system-ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function setup(
  options: {
    os?: Partial<SettingsSystemOs>
    auth?: boolean
    refresh?: () => boolean | null
    screenShare?: () => { available: boolean; state: 'sharing' | 'not-sharing' | 'unknown' }
    focus?: () => { voice: 'active' | 'inactive' | 'unknown'; text: 'active' | 'inactive' | 'unknown' }
    quietMode?: 'off' | 'calls-and-screen-sharing' | 'always'
    onQuietReleased?: (batch: unknown) => void
    now?: () => number
  } = {}
) {
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
    countExpired,
    getQuietMode: options.quietMode !== undefined ? () => options.quietMode! : undefined,
    readScreenShare: options.screenShare,
    readFocus: options.focus,
    onQuietReleased: options.onQuietReleased,
    now: options.now
  })
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.(event, ...args)
  return { handlers, assertMainWindow, os, countExpired, call }
}

const event = { sender: {} } as IpcMainInvokeEvent

beforeEach(() => vi.clearAllMocks())

describe('settings system IPC', () => {
  it('registers OS and quiet channels and checks the main-window sender on each', async () => {
    const { handlers, assertMainWindow, call } = setup()
    const channels = [...Object.values(SETTINGS_OS_STATE_IPC), QUIET_IPC.policyGet, QUIET_IPC.outputOffer]
    expect([...handlers.keys()].sort()).toEqual(channels.sort())
    for (const channel of channels) {
      assertMainWindow.mockClear()
      await call(channel, 'loginItems')
      expect(assertMainWindow, channel).toHaveBeenCalledWith(event)
    }
  })

  it('reads injected Focus and screen-share signals and coalesces deferred output until they end', async () => {
    let sharing = true
    let now = 100
    const released = vi.fn()
    const f = setup({
      screenShare: () => ({ available: true, state: sharing ? 'sharing' : 'not-sharing' }),
      focus: () => ({ voice: 'inactive', text: 'inactive' }),
      onQuietReleased: released,
      now: () => now
    })
    expect(await f.call(QUIET_IPC.policyGet)).toMatchObject({ toast: 'defer', sound: 'drop' })
    expect(await f.call(QUIET_IPC.outputOffer, 'toast')).toBe('defer')
    expect(await f.call(QUIET_IPC.outputOffer, 'toast')).toBe('defer')
    sharing = false
    now = 250
    await f.call(QUIET_IPC.policyGet)
    expect(released).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledWith({ channels: ['toast'], startedAtMs: 100, releasedAtMs: 250 })
  })

  it('returns drop for an unrecognized quiet output channel', async () => {
    expect(await setup().call(QUIET_IPC.outputOffer, 'untrusted-channel')).toBe('drop')
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
