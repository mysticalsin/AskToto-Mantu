import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Activate __mocks__/electron.ts — checkForUpdateNow needs app.getVersion() + net.fetch, and outside a
// real Electron process the 'electron' package resolves to a binary-path string, not an API surface.
vi.mock('electron')

// The two channel guards checkForUpdateNow consults. Stubbed so the suite states the channel instead of
// inheriting the test machine's real edition/ProgramData policy (readTrustedAdminManaged would otherwise
// probe C:\ProgramData on win32 and make these cases machine-dependent).
vi.mock('./cahe-edition', () => ({ shouldDisableAutoUpdate: vi.fn(() => false) }))
vi.mock('./win-security', () => ({ readTrustedAdminManaged: vi.fn((): string | null => null) }))
// initAutoUpdate reads app-update.yml out of process.resourcesPath, which does not exist outside a
// packaged app — the only fs read in this module, stubbed to a configured feed so the wiring runs.
vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => 'provider: github\nowner: mysticalsin\n') }))

import { app, net, Notification, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { shouldDisableAutoUpdate } from './cahe-edition'
import { readTrustedAdminManaged } from './win-security'
import {
  blockedUpdateChannel,
  configDisablesAutoUpdate,
  configUpdateFeedUrl,
  initAutoUpdate,
  isNewerVersion,
  latestReleaseIsOfferable,
  latestReleaseHasApprovedInstallers,
  parseLatestRelease,
  checkForUpdateNow,
  startUpdateDownload
} from './updater'

/** Stand-in for electron-updater's AppUpdater: the same EventEmitter surface updater.ts wires to. */
class FakeAutoUpdater extends EventEmitter {
  logger: unknown = null
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async (): Promise<{ downloadPromise?: Promise<unknown> | null } | null> => null)
}

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
  let restorePlatform: () => void

  beforeEach(() => {
    restorePlatform = pinPlatform('linux')
  })

  afterEach(() => {
    restorePlatform()
  })

  it('reports an available update with the feed-provided https release page', () => {
    const r = parseLatestRelease(
      {
        tag_name: 'v1.3.0',
        html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v1.3.0',
        assets: [{ name: 'Metis-1.3.0.dmg' }, { name: 'Metis-Setup-1.3.0.exe' }, { name: 'Metis-Native-1.3.0.zip' }]
      },
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
    expect(
      parseLatestRelease(
        {
          tag_name: 'v1.2.0',
          html_url: 'https://x.example/r',
          assets: [{ name: 'Metis-1.2.0.dmg' }, { name: 'Metis-Setup-1.2.0.exe' }, { name: 'Metis-Native-1.2.0.zip' }]
        },
        '1.2.0'
      ).available
    ).toBe(false)
    expect(
      parseLatestRelease(
        {
          tag_name: 'v1.1.9',
          html_url: 'https://x.example/r',
          assets: [{ name: 'Metis-1.1.9.dmg' }, { name: 'Metis-Setup-1.1.9.exe' }, { name: 'Metis-Native-1.1.9.zip' }]
        },
        '1.2.0'
      ).available
    ).toBe(false)
  })

  it('falls back to the fixed releases page when html_url is missing or not https', () => {
    const fixed = 'https://github.com/mysticalsin/Metis-Releases/releases/latest'
    expect(
      parseLatestRelease(
        {
          tag_name: 'v9.9.9',
          assets: [{ name: 'Metis-9.9.9.dmg' }, { name: 'Metis-Setup-9.9.9.exe' }, { name: 'Metis-Native-9.9.9.zip' }]
        },
        '1.2.0'
      ).url
    ).toBe(fixed)
    expect(
      parseLatestRelease(
        {
          tag_name: 'v9.9.9',
          html_url: 'javascript:alert(1)',
          assets: [{ name: 'Metis-9.9.9.dmg' }, { name: 'Metis-Setup-9.9.9.exe' }, { name: 'Metis-Native-9.9.9.zip' }]
        },
        '1.2.0'
      ).url
    ).toBe(fixed)
  })

  it('returns a clean error (never throws) on a payload without a version tag', () => {
    expect(parseLatestRelease({}, '1.2.0').ok).toBe(false)
    expect(parseLatestRelease(null, '1.2.0').ok).toBe(false)
    expect(parseLatestRelease({ tag_name: '   ' }, '1.2.0').ok).toBe(false)
  })

  it('refuses draft or prerelease Latest (QA + Ultron stamp only)', () => {
    expect(latestReleaseIsOfferable({ tag_name: 'v1.8.4', draft: true })).toBe(false)
    expect(latestReleaseIsOfferable({ tag_name: 'v1.8.4', prerelease: true })).toBe(false)
    expect(latestReleaseIsOfferable({ tag_name: 'v1.8.4' })).toBe(true)
    expect(parseLatestRelease({ tag_name: 'v9.9.9', draft: true }, '1.2.0').ok).toBe(false)
    expect(parseLatestRelease({ tag_name: 'v9.9.9', prerelease: true }, '1.2.0').error).toMatch(/QA-approved/)
  })

  it('full board Latest carries EXE + DMG + Native, not a partial upload', () => {
    expect(
      latestReleaseHasApprovedInstallers(
        {
          tag_name: 'v1.8.4',
          assets: [
            { name: 'Metis-1.8.4.dmg' },
            { name: 'Metis-Setup-1.8.4.exe' },
            { name: 'Metis-Native-1.8.4.zip' }
          ]
        },
        '1.8.4',
        'linux'
      )
    ).toBe(true)
    expect(
      latestReleaseHasApprovedInstallers(
        {
          tag_name: 'v1.8.4',
          assets: [{ name: 'Metis-1.8.4.dmg' }]
        },
        '1.8.4',
        'linux'
      )
    ).toBe(false)
    expect(latestReleaseHasApprovedInstallers({ tag_name: 'v1.8.4' }, '1.8.4', 'linux')).toBe(false)
  })

  it.each([
    { platform: 'darwin', assets: ['Metis-1.8.4.dmg', 'Metis-1.8.4.zip', 'latest-mac.yml'], ready: true },
    { platform: 'darwin', assets: ['Metis-1.8.4.zip', 'latest-mac.yml'], ready: false },
    { platform: 'darwin', assets: ['Metis-1.8.4.dmg', 'latest-mac.yml'], ready: false },
    { platform: 'darwin', assets: ['Metis-1.8.4.dmg', 'Metis-1.8.4.zip'], ready: false },
    { platform: 'darwin', assets: ['Metis-1.8.3.dmg', 'Metis-1.8.3.zip', 'latest-mac.yml'], ready: false },
    { platform: 'darwin', assets: ['Metis-Setup-1.8.4.exe', 'latest.yml'], ready: false },
    { platform: 'win32', assets: ['Metis-Setup-1.8.4.exe', 'latest.yml'], ready: true },
    { platform: 'win32', assets: ['latest.yml'], ready: false },
    { platform: 'win32', assets: ['Metis-Setup-1.8.4.exe'], ready: false },
    { platform: 'win32', assets: ['Metis-Setup-1.8.3.exe', 'latest.yml'], ready: false },
    { platform: 'win32', assets: ['Metis-1.8.4.dmg', 'Metis-1.8.4.zip', 'latest-mac.yml'], ready: false }
  ] as const)('offers updates on $platform only when its versioned files are ready: $assets', ({ platform, assets, ready }) => {
    const restore = pinPlatform(platform)
    try {
      const result = parseLatestRelease({
        tag_name: 'v1.8.4',
        assets: assets.map((name) => ({ name }))
      }, '1.8.3')
      expect(result.ok).toBe(ready)
      if (ready) {
        expect(result.available).toBe(true)
        expect(result.url).toBe('https://github.com/mysticalsin/Metis-Releases/releases/latest')
      } else {
        expect(result.available).toBeUndefined()
        expect(result.error).toMatch(/not yet fully published for this platform/)
      }
    } finally {
      restore()
    }
  })
})

describe('checkForUpdateNow — never throws, always a human-readable result', () => {
  let restorePlatform: () => void

  beforeEach(() => {
    restorePlatform = pinPlatform('linux')
  })

  afterEach(() => {
    restorePlatform()
  })

  it('resolves available:true from a healthy feed response', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tag_name: 'v99.0.0',
        html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v99.0.0',
        assets: [{ name: 'Metis-99.0.0.dmg' }, { name: 'Metis-Setup-99.0.0.exe' }, { name: 'Metis-Native-99.0.0.zip' }]
      })
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
    Reflect.deleteProperty(proc, 'windowsStore')
    vi.mocked(net.fetch).mockClear()
  })

  it('reports the three channels that must never consume the shared release feed', () => {
    expect(blockedUpdateChannel()).toBe(null)

    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(true)
    expect(blockedUpdateChannel()).toBe('cahe')
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(false)

    proc.windowsStore = true
    expect(blockedUpdateChannel()).toBe('store')
    Reflect.deleteProperty(proc, 'windowsStore')

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

  it.each(['darwin', 'win32', 'linux'] as const)('still checks the feed on an ordinary %s build', async (platform) => {
    const restore = pinPlatform(platform)
    try {
      vi.mocked(net.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v99.0.0',
          assets: [
            { name: 'Metis-99.0.0.dmg' },
            { name: 'Metis-99.0.0.zip' },
            { name: 'latest-mac.yml' },
            { name: 'Metis-Setup-99.0.0.exe' },
            { name: 'latest.yml' },
            { name: 'Metis-Native-99.0.0.zip' }
          ]
        })
      } as unknown as Response)
      const r = await checkForUpdateNow()
      expect(net.fetch).toHaveBeenCalledTimes(1)
      expect(net.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/mysticalsin/Metis-Releases/releases/latest',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      expect(r.available).toBe(true)
    } finally {
      restore()
    }
  })
})

/** updater.ts refuses the in-app install on darwin — Squirrel.Mac cannot replace an ad-hoc-signed
 *  bundle — so any suite asserting the download path must pin a non-darwin platform. Without this the
 *  suite passes on CI's ubuntu/windows runners and fails on a maintainer's Mac. 'linux' rather than
 *  'win32' so the PORTABLE_EXECUTABLE_FILE branch stays out of the way too. */
function pinPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

describe('startUpdateDownload — Settings "Update now" in-app download guard', () => {
  let restorePlatform: () => void

  beforeEach(() => {
    restorePlatform = pinPlatform('linux')
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(false)
    vi.mocked(readTrustedAdminManaged).mockReturnValue(null)
    delete (process as unknown as { windowsStore?: boolean }).windowsStore
  })

  afterEach(() => {
    restorePlatform()
  })

  it('sends macOS to the DMG instead of a download that Squirrel.Mac could never install', async () => {
    const electronApp = app as unknown as { isPackaged?: boolean }
    electronApp.isPackaged = true
    const restore = pinPlatform('darwin')
    vi.mocked(net.fetch).mockClear() // earlier suites in this file exercise the feed
    try {
      const r = await startUpdateDownload()
      expect(r.started).toBe(false)
      expect(r.reason).toMatch(/\.dmg/i)
      // The refusal must be free: no feed round-trip for an install we are going to decline anyway,
      // so an offline Mac still gets the right message instead of a network error.
      expect(net.fetch).not.toHaveBeenCalled()
    } finally {
      restore()
      delete electronApp.isPackaged
    }
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

  it('refuses to start a download when GitHub Latest is draft or prerelease', async () => {
    const electronApp = app as unknown as { isPackaged?: boolean }
    electronApp.isPackaged = true
    try {
      vi.mocked(net.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tag_name: 'v99.0.0', draft: true, html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v99.0.0' })
      } as unknown as Response)
      const draft = await startUpdateDownload()
      expect(draft.started).toBe(false)
      expect(draft.reason).toMatch(/QA-approved/)

      vi.mocked(net.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tag_name: 'v99.0.0', prerelease: true, html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v99.0.0' })
      } as unknown as Response)
      const pre = await startUpdateDownload()
      expect(pre.started).toBe(false)
      expect(pre.reason).toMatch(/QA-approved/)
    } finally {
      delete electronApp.isPackaged
    }
  })
})

// MQA-164 — a download that failed mid-flight was reported to the log file and nowhere else: there was no
// update:error channel at all, so Settings → About kept a frozen "Downloading update… X%" bar while the
// download-page fallback (rendered only in phase 'blocked' or 'idle') stayed hidden, and the rejected
// downloadPromise nobody held reached index.ts's unhandledRejection hook, which persists an app.crash
// audit line plus a crash-*.log for something that is not a crash.
describe('MQA-164 — a failed update download reaches the renderer', () => {
  const electronApp = app as unknown as { isPackaged?: boolean; name?: string }
  const proc = process as NodeJS.Process & { resourcesPath?: string; windowsStore?: boolean }
  const send = vi.fn()
  const win = { webContents: { send } } as unknown as BrowserWindow
  let fake: FakeAutoUpdater
  let moduleId: string
  let restorePlatform: () => void

  beforeEach(() => {
    // Only the 6-hourly re-check interval is faked: setImmediate has to stay real for the
    // unhandled-rejection probe below (Node emits the event after the microtask queue drains).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(false)
    vi.mocked(readTrustedAdminManaged).mockReturnValue(null)
    Reflect.deleteProperty(proc, 'windowsStore')
    send.mockClear()
    vi.mocked(Notification).mockClear()
    electronApp.isPackaged = true
    electronApp.name = 'Métis'
    proc.resourcesPath = 'C:/fake-resources' // only join()'d, then handed to the mocked readFileSync above
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v99.0.0',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v99.0.0',
        assets: [{ name: 'Metis-99.0.0.dmg' }, { name: 'Metis-Setup-99.0.0.exe' }, { name: 'Metis-Native-99.0.0.zip' }]
      })
    } as unknown as Response)
    // updater.ts lazy-requires electron-updater (boot cost), which vi.mock cannot intercept — seed the
    // CJS cache with a fake AppUpdater instead, so both entry points get the same event emitter we drive.
    fake = new FakeAutoUpdater()
    moduleId = require.resolve('electron-updater')
    require.cache[moduleId] = { id: moduleId, filename: moduleId, loaded: true, exports: { autoUpdater: fake } } as never
    // Both entry points bail early on darwin (see pinPlatform above), which would make every
    // assertion below vacuous on a Mac.
    restorePlatform = pinPlatform('linux')
  })

  afterEach(() => {
    restorePlatform()
    delete require.cache[moduleId]
    delete electronApp.isPackaged
    Reflect.deleteProperty(proc, 'resourcesPath')
    vi.useRealTimers()
  })

  it('MQA-164 — forwards a mid-flight download failure so the download-page fallback becomes reachable', async () => {
    initAutoUpdate(() => win)
    let failDownload = (_e: Error): void => {}
    fake.checkForUpdates.mockResolvedValue({
      downloadPromise: new Promise<never>((_resolve, reject) => {
        failDownload = reject
      })
    })

    expect(await startUpdateDownload()).toEqual({ started: true })

    // electron-updater emits 'error' from downloadUpdate's errorHandler BEFORE rejecting the promise.
    fake.emit('error', new Error('HttpError: 403 for https://objects.githubusercontent.com/x?token=abc123'))

    const call = send.mock.calls.find((c) => c[0] === IPC.updateError)
    expect(call, 'no update:error was sent to the renderer').toBeTruthy()
    expect(call?.[1].message).toMatch(/download page/i)
    // electron-updater's own message embeds the feed URL and request context; nothing crosses the bridge raw.
    expect(call?.[1].message).not.toMatch(/githubusercontent|token=/)

    failDownload(new Error('403'))
    await Promise.resolve()
  })

  it('MQA-164 — holds the download promise so a failure is not recorded as a fake app crash', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (r: unknown): void => void unhandled.push(r)
    process.on('unhandledRejection', onUnhandled)
    try {
      initAutoUpdate(() => win)
      const failure = new Error('sha512 checksum mismatch')
      fake.checkForUpdates.mockImplementation(async () => ({ downloadPromise: Promise.reject(failure) }))
      await startUpdateDownload()
      fake.emit('error', failure)
      await new Promise((r) => setImmediate(r))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  it('MQA-164 — the silent background check never flips an untouched Settings row into an error', () => {
    initAutoUpdate(() => win)
    // No user-started download: this is the boot / 6-hourly check failing on a flaky network.
    fake.emit('error', new Error('getaddrinfo ENOTFOUND github.com'))
    expect(send.mock.calls.some((c) => c[0] === IPC.updateError)).toBe(false)
  })

  // Dropping checkForUpdatesAndNotify (it leaked the unhandled rejection above) must not cost the OS
  // notification it used to raise for a download the user never asked for.
  it('MQA-164 — a background download still shows the OS "update ready" notification', () => {
    initAutoUpdate(() => win)
    fake.emit('update-downloaded', { version: '1.5.5', releaseNotes: 'Fixes the thing' })

    expect(send).toHaveBeenCalledWith(IPC.updateDownloaded, { version: '1.5.5', notes: 'Fixes the thing' })
    expect(vi.mocked(Notification)).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('1.5.5') })
    )
  })
})

describe('enterprise private update feed (admin managed-config `updateFeedUrl`)', () => {
  it('accepts only an https URL', () => {
    expect(configUpdateFeedUrl('{"updateFeedUrl":"https://updates.corp.example/metis/"}')).toBe(
      'https://updates.corp.example/metis/'
    )
    expect(configUpdateFeedUrl('{"updateFeedUrl":"  https://u.example/x "}')).toBe('https://u.example/x')
  })

  it('rejects http, non-strings, missing keys, and malformed JSON (fall back to the built-in feed)', () => {
    expect(configUpdateFeedUrl('{"updateFeedUrl":"http://insecure.example/"}')).toBeNull()
    expect(configUpdateFeedUrl('{"updateFeedUrl":42}')).toBeNull()
    expect(configUpdateFeedUrl('{}')).toBeNull()
    expect(configUpdateFeedUrl('not json')).toBeNull()
    expect(configUpdateFeedUrl('{"updateFeedUrl":"ftp://x"}')).toBeNull()
  })

  it('is applied at BOTH updater entry points, and only from the ACL-trusted ADMIN policy path', async () => {
    // Whoever controls the feed controls what binary gets offered — a user-writable config must never
    // redirect the channel. applyAdminUpdateFeed reads readTrustedAdminManaged(), the same fd-pinned
    // path disableAutoUpdate trusts, and both require('electron-updater') sites call it.
    // node:fs is MOCKED at the top of this file — reach for the real one to read the source.
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const { join } = await vi.importActual<typeof import('node:path')>('node:path')
    const src = readFileSync(join(__dirname, 'updater.ts'), 'utf8')
    const fn = src.slice(src.indexOf('function applyAdminUpdateFeed'), src.indexOf('export type BlockedUpdateChannel'))
    expect(fn).toMatch(/readTrustedAdminManaged\(\)/)
    expect(fn).not.toMatch(/userData/)
    const callSites = src.split('applyAdminUpdateFeed(autoUpdater)').length - 1
    expect(callSites, 'the manual check AND initAutoUpdate must both apply the feed').toBe(2)
  })
})

describe('MQA-292 Metis-Releases feed rules — QA Latest only', () => {
  it('the in-app check and electron-builder publish the same public owner/repo', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const { join } = await vi.importActual<typeof import('node:path')>('node:path')
    const src = readFileSync(join(__dirname, 'updater.ts'), 'utf8')
    const yml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(src).toContain('https://api.github.com/repos/mysticalsin/Metis-Releases/releases/latest')
    expect(src).toContain('https://github.com/mysticalsin/Metis-Releases/releases/latest')
    expect(yml).toMatch(/provider:\s*github/)
    expect(yml).toMatch(/owner:\s*mysticalsin/)
    expect(yml).toMatch(/repo:\s*Metis-Releases/)
    expect(yml).toMatch(/releaseType:\s*release/)
    expect(src).toMatch(/allowPrerelease = false/)
    expect(src).toMatch(/allowDowngrade = false/)
  })

  it('release.yml does not undraft Latest until EXE + DMG + Native are in the bundle', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const { join } = await vi.importActual<typeof import('node:path')>('node:path')
    const workflow = readFileSync(join(__dirname, '../../.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('Metis-${version}.dmg')
    expect(workflow).toContain('Metis-Setup-${version}.exe')
    expect(workflow).toContain('Metis-Native-${version}.zip')
    expect(workflow).toMatch(/gh release create .* --draft/)
    expect(workflow).toMatch(/gh release edit .* --draft=false/)
    const create = workflow.indexOf('gh release create')
    const undraft = workflow.indexOf('--draft=false')
    expect(create).toBeGreaterThan(-1)
    expect(undraft).toBeGreaterThan(create)
  })

  it('Download & install re-checks GitHub Latest before electron-updater runs', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const { join } = await vi.importActual<typeof import('node:path')>('node:path')
    const src = readFileSync(join(__dirname, 'updater.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export async function startUpdateDownload'), src.indexOf('const isNotFound'))
    expect(fn.indexOf('checkForUpdateNow()')).toBeGreaterThan(-1)
    expect(fn.indexOf('checkForUpdateNow()')).toBeLessThan(fn.indexOf('autoUpdater.checkForUpdates()'))
    expect(fn).toMatch(/No QA-approved update is available/)
  })
})
