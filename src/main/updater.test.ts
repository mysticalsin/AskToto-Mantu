import { beforeEach, describe, expect, it, vi } from 'vitest'

// Activate __mocks__/electron.ts — checkForUpdateNow needs app.getVersion() + net.fetch, and outside a
// real Electron process the 'electron' package resolves to a binary-path string, not an API surface.
vi.mock('electron')

// The two channel guards checkForUpdateNow consults. Stubbed so the suite states the channel instead of
// inheriting the test machine's real edition/ProgramData policy (readTrustedAdminManaged would otherwise
// probe C:\ProgramData on win32 and make these cases machine-dependent).
vi.mock('./cahe-edition', () => ({ shouldDisableAutoUpdate: vi.fn(() => false) }))
vi.mock('./win-security', () => ({ readTrustedAdminManaged: vi.fn((): string | null => null) }))

import { net } from 'electron'
import { shouldDisableAutoUpdate } from './cahe-edition'
import { readTrustedAdminManaged } from './win-security'
import {
  blockedUpdateChannel,
  configDisablesAutoUpdate,
  isNewerVersion,
  parseLatestRelease,
  checkForUpdateNow,
  startUpdateDownload
} from './updater'

describe('configDisablesAutoUpdate — enterprise auto-update kill-switch', () => {
  it('disables updates only when disableAutoUpdate is exactly true', () => {
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": true}')).toBe(true)
  })

  it('leaves updates on when the key is false, absent, or a truthy-but-not-true value', () => {
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": false}')).toBe(false)
    expect(configDisablesAutoUpdate('{"provider": "anthropic"}')).toBe(false)
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": "true"}')).toBe(false) // string, not boolean
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": 1}')).toBe(false)
  })

  it('fails open (updates on) on malformed or empty config, never throws', () => {
    expect(configDisablesAutoUpdate('')).toBe(false)
    expect(configDisablesAutoUpdate('not json')).toBe(false)
    expect(configDisablesAutoUpdate('null')).toBe(false)
  })
})

describe('isNewerVersion — manual release-feed compare (Settings → About → Updates)', () => {
  it('compares plain numeric semver, leading v tolerated, missing parts = 0', () => {
    expect(isNewerVersion('1.2.1', '1.2.0')).toBe(true)
    expect(isNewerVersion('v1.3.0', '1.2.9')).toBe(true)
    expect(isNewerVersion('1.10.0', '1.9.2')).toBe(true) // numeric, not lexicographic
    expect(isNewerVersion('2.0', '1.9.9')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.2.0', '1.2.1')).toBe(false)
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false)
  })
})

describe('parseLatestRelease — GitHub latest-release payload → UpdateCheckResult', () => {
  it('reports an available update with the feed-provided https release page', () => {
    const r = parseLatestRelease(
      { tag_name: 'v1.3.0', html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v1.3.0' },
      '1.2.0'
    )
    expect(r).toEqual({
      ok: true,
      current: '1.2.0',
      latest: '1.3.0',
      available: true,
      url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v1.3.0'
    })
  })

  it('reports up-to-date when the feed tag equals (or is older than) the running version', () => {
    expect(parseLatestRelease({ tag_name: 'v1.2.0', html_url: 'https://x.example/r' }, '1.2.0').available).toBe(false)
    expect(parseLatestRelease({ tag_name: 'v1.1.9', html_url: 'https://x.example/r' }, '1.2.0').available).toBe(false)
  })

  it('falls back to the fixed releases page when html_url is missing or not https', () => {
    const fixed = 'https://github.com/mysticalsin/Metis-Releases/releases/latest'
    expect(parseLatestRelease({ tag_name: 'v9.9.9' }, '1.2.0').url).toBe(fixed)
    expect(parseLatestRelease({ tag_name: 'v9.9.9', html_url: 'javascript:alert(1)' }, '1.2.0').url).toBe(fixed)
  })

  it('returns a clean error (never throws) on a payload without a version tag', () => {
    expect(parseLatestRelease({}, '1.2.0').ok).toBe(false)
    expect(parseLatestRelease(null, '1.2.0').ok).toBe(false)
    expect(parseLatestRelease({ tag_name: '   ' }, '1.2.0').ok).toBe(false)
  })
})

describe('checkForUpdateNow — never throws, always a human-readable result', () => {
  it('resolves available:true from a healthy feed response', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v99.0.0' })
    } as unknown as Response)
    const r = await checkForUpdateNow()
    expect(r.ok).toBe(true)
    expect(r.available).toBe(true)
    expect(r.current).toBe('0.1.0-test') // the shared electron mock's app.getVersion()
  })

  it('maps a 404 (no release published yet) and a network failure to short errors, not throws', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response)
    const notFound = await checkForUpdateNow()
    expect(notFound.ok).toBe(false)
    expect(notFound.error).toMatch(/no published release/i)

    vi.mocked(net.fetch).mockRejectedValueOnce(new Error('offline'))
    const offline = await checkForUpdateNow()
    expect(offline.ok).toBe(false)
    expect(offline.error).toMatch(/could not reach/i)
  })
})

// MQA-079 — the manual "Check for updates" row (Settings → About, auto-fired on mount) used to query the
// shared Metis-Releases feed with no edition/Store/policy check, so a Cahê pilot was offered the standard
// Métis installer — a different app with an empty profile — and a Store package / an IT-frozen fleet got
// a working out-of-band download link.
describe('MQA-079 — blockedUpdateChannel guards the manual check, not just initAutoUpdate', () => {
  const proc = process as NodeJS.Process & { windowsStore?: boolean }

  beforeEach(() => {
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(false)
    vi.mocked(readTrustedAdminManaged).mockReturnValue(null)
    delete proc.windowsStore
    vi.mocked(net.fetch).mockClear()
  })

  it('reports the three channels that must never consume the shared release feed', () => {
    expect(blockedUpdateChannel()).toBe(null)

    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(true)
    expect(blockedUpdateChannel()).toBe('cahe')
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(false)

    proc.windowsStore = true
    expect(blockedUpdateChannel()).toBe('store')
    delete proc.windowsStore

    vi.mocked(readTrustedAdminManaged).mockReturnValue('{"disableAutoUpdate": true}')
    expect(blockedUpdateChannel()).toBe('policy')
  })

  it('never contacts the feed from a Cahê pilot — it is updated with its own installer', async () => {
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(true)
    const r = await checkForUpdateNow()
    expect(net.fetch).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.available).toBeUndefined() // no version comparison, so no download link can render
    expect(r.error).toMatch(/Cahê installer/)
    expect(r.current).toBe('0.1.0-test')
  })

  it('never contacts the feed from a Store/AppX package', async () => {
    proc.windowsStore = true
    const r = await checkForUpdateNow()
    expect(net.fetch).not.toHaveBeenCalled()
    expect(r.error).toMatch(/microsoft store/i)
  })

  it('never contacts the feed on a fleet frozen by an admin managed-config', async () => {
    vi.mocked(readTrustedAdminManaged).mockReturnValue('{"disableAutoUpdate": true}')
    const r = await checkForUpdateNow()
    expect(net.fetch).not.toHaveBeenCalled()
    expect(r.error).toMatch(/managed by your organisation/i)
  })

  it('still checks the feed on an ordinary build (guard must not disable updates for everyone)', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v99.0.0' })
    } as unknown as Response)
    const r = await checkForUpdateNow()
    expect(net.fetch).toHaveBeenCalledTimes(1)
    expect(r.available).toBe(true)
  })
})

describe('startUpdateDownload — Settings "Update now" in-app download guard', () => {
  beforeEach(() => {
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(false)
    vi.mocked(readTrustedAdminManaged).mockReturnValue(null)
    delete (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore
  })

  it('does not start a download outside the installed app (app.isPackaged false in test)', async () => {
    const r = await startUpdateDownload()
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/installed app/i)
  })

  it('returns the channel reason (never starts a self-install) for a blocked channel', async () => {
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(true) // Cahê pilot
    const r = await startUpdateDownload()
    expect(r.started).toBe(false)
    expect(r.reason).toMatch(/Cahê installer/)
  })
})
