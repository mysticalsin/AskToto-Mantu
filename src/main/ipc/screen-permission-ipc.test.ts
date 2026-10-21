import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, ipcMain: { handle: vi.fn() }, shell: {} }))
vi.mock('../logger', () => ({ auditLog: vi.fn() }))
vi.mock('../permission-repair', () => ({ repairScreenPermission: vi.fn() }))
vi.mock('../infra/process/exec-file', () => ({ execFileNoShell: vi.fn() }))
vi.mock('../capture-permissions/screen-permission-runtime', () => ({
  APP_BUNDLE_ID: 'test',
  screenPermission: vi.fn()
}))

import { permissionSettingsUrl } from './screen-permission-ipc'

/** C32 (HIG Privacy): a denied permission opens its exact privacy pane on each platform, and nothing else. */
describe('permissionSettingsUrl', () => {
  it('macOS opens the Privacy & Security anchor for each permission', () => {
    expect(permissionSettingsUrl('darwin', 'microphone')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
    expect(permissionSettingsUrl('darwin', 'screenRecording')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
  })

  it('Windows opens the per-capability privacy page', () => {
    expect(permissionSettingsUrl('win32', 'microphone')).toBe('ms-settings:privacy-microphone')
    expect(permissionSettingsUrl('win32', 'screenRecording')).toBe('ms-settings:privacy-graphicscaptureprogrammatic')
  })

  it('any other kind or platform opens nothing (no renderer-chosen pane falls through to the microphone)', () => {
    for (const kind of [undefined, null, '', 'camera', 'Privacy_Microphone', 42, { kind: 'microphone' }]) {
      expect(permissionSettingsUrl('darwin', kind)).toBeNull()
      expect(permissionSettingsUrl('win32', kind)).toBeNull()
    }
    expect(permissionSettingsUrl('linux', 'microphone')).toBeNull()
  })
})
