import { describe, it, expect, afterEach, vi } from 'vitest'
import { systemPreferences } from 'electron'
import { getPlatformPermissions } from './platform-perms'

vi.mock('electron', () => ({
  systemPreferences: { getMediaAccessStatus: vi.fn() }
}))

const REAL_PLATFORM = process.platform

/** process.platform is configurable in Node — flip it for the duration of a platform-specific test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

afterEach(() => {
  setPlatform(REAL_PLATFORM)
  vi.mocked(systemPreferences.getMediaAccessStatus).mockReset()
})

describe('getPlatformPermissions — Windows microphone', () => {
  // systemPreferences.getMediaAccessStatus('microphone') is supported on win32 as well as darwin
  // (electron.d.ts marks it `@platform win32,darwin`) — Windows should report a real status instead
  // of the old hardcoded 'unknown'.
  it('reports granted when the OS says granted', () => {
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted')
    expect(getPlatformPermissions().microphone).toBe('granted')
  })

  it('reports denied when the OS says denied', () => {
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('denied')
    expect(getPlatformPermissions().microphone).toBe('denied')
  })

  it('reports unknown for any other status (not-determined, restricted)', () => {
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('not-determined')
    expect(getPlatformPermissions().microphone).toBe('unknown')
  })

  it('still reports Windows screen recording as unknown regardless of the mic status', () => {
    // windowsScreenStatus is deliberately left non-committal — the OS API always claims 'granted' for
    // 'screen' on Windows regardless of truth, so surfacing it would be misleading.
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted')
    expect(getPlatformPermissions().screenRecording).toBe('unknown')
  })
})
