import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { desktopCapturer, systemPreferences } from 'electron'
import { clearScreenProbe, getPlatformPermissions, probeScreenCapture } from './platform-perms'

vi.mock('electron', () => ({
  systemPreferences: { getMediaAccessStatus: vi.fn() },
  desktopCapturer: { getSources: vi.fn() }
}))

const REAL_PLATFORM = process.platform

/** process.platform is configurable in Node — flip it for the duration of a platform-specific test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  clearScreenProbe()
})

afterEach(() => {
  setPlatform(REAL_PLATFORM)
  vi.mocked(systemPreferences.getMediaAccessStatus).mockReset()
  vi.mocked(desktopCapturer.getSources).mockReset()
  clearScreenProbe()
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
})

// MQA-002 (docs/qa/BUG-LEDGER.md): Windows screen-recording readiness was hardcoded 'unknown', so the
// setup checklist could never tell a Windows user whether screenshots would work — the first failed
// capture mid-meeting was the discovery mechanism. Status is now backed by a real capture probe.
describe('Windows screen-capture readiness is probe-backed, not hardcoded (MQA-002)', () => {
  it('stays unknown until an actual capture has been attempted — never optimistically granted', () => {
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted')
    expect(getPlatformPermissions().screenRecording).toBe('unknown')
  })

  it('reports granted once a probe returns at least one source', async () => {
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted')
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ id: 'screen:0' }] as never)

    await expect(probeScreenCapture()).resolves.toBe(true)
    expect(getPlatformPermissions().screenRecording).toBe('granted')
  })

  it('reports denied when the probe comes back empty (capture blocked by policy)', async () => {
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted')
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([] as never)

    await expect(probeScreenCapture()).resolves.toBe(false)
    expect(getPlatformPermissions().screenRecording).toBe('denied')
  })

  it('treats a throwing probe as denied rather than propagating — readiness must never crash boot', async () => {
    setPlatform('win32')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted')
    vi.mocked(desktopCapturer.getSources).mockRejectedValue(new Error('access denied'))

    await expect(probeScreenCapture()).resolves.toBe(false)
    expect(getPlatformPermissions().screenRecording).toBe('denied')
  })
})

describe('getPlatformPermissions — macOS screen recording (MQA-002)', () => {
  it('trusts TCC over probe evidence when TCC has committed', async () => {
    setPlatform('darwin')
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ id: 'screen:0' }] as never)
    await probeScreenCapture() // probe says granted…
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('denied') // …but TCC says no

    expect(getPlatformPermissions().screenRecording).toBe('denied')
  })

  it('falls back to probe evidence only while TCC is non-committal (not-determined)', async () => {
    setPlatform('darwin')
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([{ id: 'screen:0' }] as never)
    await probeScreenCapture()
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('not-determined')

    expect(getPlatformPermissions().screenRecording).toBe('granted')
  })

  it('is unknown on macOS when TCC is undecided and nothing has been probed', () => {
    setPlatform('darwin')
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('not-determined')
    expect(getPlatformPermissions().screenRecording).toBe('unknown')
  })
})

describe('non-desktop platforms', () => {
  it('reports not-required rather than pretending a permission model exists', () => {
    setPlatform('linux')
    expect(getPlatformPermissions()).toEqual({ microphone: 'not-required', screenRecording: 'not-required' })
  })
})
