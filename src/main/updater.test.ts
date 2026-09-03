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

import { app, net, Notification, BrowserWindow, type BrowserWindow as BrowserWindowType } from 'electron'
import { IPC } from '@shared/ipc'
import { shouldDisableAutoUpdate } from './cahe-edition'
import { readTrustedAdminManaged } from './win-security'
import {
  blockedUpdateChannel,
  configDisablesAutoUpdate,
  configUpdateFeedUrl,
  initAutoUpdate,
  isNewerVersion,
  parseLatestRelease,
  checkForUpdateNow,
  startUpdateDownload,
  installDownloadedUpdate,
  isInstallingUpdate
} from './updater'

/** Stand-in for electron-updater's AppUpdater: the same EventEmitter surface updater.ts wires to. */
class FakeAutoUpdater extends EventEmitter {
  logger: unknown = null
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async (): Promise<{ downloadPromise?: Promise<unknown> | null } | null> => null)
  quitAndInstall = vi.fn()
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
    delete (process as unknown as { windowsStore?: boolean }).windowsStore
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

// MQA-164 — a download that failed mid-flight was reported to the log file and nowhere else: there was no
// update:error channel at all, so Settings → About kept a frozen "Downloading update… X%" bar while the
// download-page fallback (rendered only in phase 'blocked' or 'idle') stayed hidden, and the rejected
// downloadPromise nobody held reached index.ts's unhandledRejection hook, which persists an app.crash
// audit line plus a crash-*.log for something that is not a crash.
describe('MQA-164 — a failed update download reaches the renderer', () => {
  const electronApp = app as unknown as { isPackaged?: boolean; name?: string }
  const proc = process as NodeJS.Process & { resourcesPath?: string; windowsStore?: boolean }
  const send = vi.fn()
  const win = { webContents: { send } } as unknown as BrowserWindowType
  let fake: FakeAutoUpdater
  let moduleId: string

  beforeEach(() => {
    // Only the 6-hourly re-check interval is faked: setImmediate has to stay real for the
    // unhandled-rejection probe below (Node emits the event after the microtask queue drains).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.mocked(shouldDisableAutoUpdate).mockReturnValue(false)
    vi.mocked(readTrustedAdminManaged).mockReturnValue(null)
    delete proc.windowsStore
    send.mockClear()
    vi.mocked(Notification).mockClear()
    electronApp.isPackaged = true
    electronApp.name = 'Métis'
    proc.resourcesPath = 'C:/fake-resources' // only join()'d, then handed to the mocked readFileSync above
    // updater.ts lazy-requires electron-updater (boot cost), which vi.mock cannot intercept — seed the
    // CJS cache with a fake AppUpdater instead, so both entry points get the same event emitter we drive.
    fake = new FakeAutoUpdater()
    moduleId = require.resolve('electron-updater')
    require.cache[moduleId] = { id: moduleId, filename: moduleId, loaded: true, exports: { autoUpdater: fake } } as never
  })

  afterEach(() => {
    delete require.cache[moduleId]
    delete electronApp.isPackaged
    delete proc.resourcesPath
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

describe('MQA-272 — Restart & install actually quits the tray overlay to apply the update', () => {
  let fake: FakeAutoUpdater
  let moduleId: string
  const electronApp = app as unknown as {
    removeAllListeners: ReturnType<typeof vi.fn>
    quit: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setImmediate'] })
    fake = new FakeAutoUpdater()
    moduleId = require.resolve('electron-updater')
    require.cache[moduleId] = { id: moduleId, filename: moduleId, loaded: true, exports: { autoUpdater: fake } } as never
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
    vi.mocked(electronApp.removeAllListeners).mockClear()
    vi.mocked(electronApp.quit).mockClear()
  })

  afterEach(() => {
    delete require.cache[moduleId]
    vi.useRealTimers()
  })

  it('clears window-all-closed, destroys open windows, then quitAndInstall(false, true)', () => {
    const destroy = vi.fn()
    const removeClose = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { isDestroyed: () => false, removeAllListeners: removeClose, destroy }
    ])

    expect(isInstallingUpdate()).toBe(false)
    installDownloadedUpdate()
    expect(isInstallingUpdate()).toBe(true)

    // Still deferred — the IPC invoke reply must finish before we tear the process down.
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    vi.runAllTimers()

    expect(electronApp.removeAllListeners).toHaveBeenCalledWith('window-all-closed')
    expect(removeClose).toHaveBeenCalledWith('close')
    expect(destroy).toHaveBeenCalled()
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('falls back to app.quit when quitAndInstall throws (autoInstallOnAppQuit still applies)', () => {
    fake.quitAndInstall.mockImplementation(() => {
      throw new Error('no update pending')
    })
    installDownloadedUpdate()
    vi.runAllTimers()
    expect(electronApp.quit).toHaveBeenCalled()
    expect(isInstallingUpdate()).toBe(false)
  })

  it('index.ts wires Restart & install through installDownloadedUpdate and skips before-quit delay', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const { join } = await vi.importActual<typeof import('node:path')>('node:path')
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const installHandler = src.slice(src.indexOf('IPC.updateInstall'), src.indexOf('IPC.openMailDraft'))
    expect(installHandler).toMatch(/quitFlushDone = true/)
    expect(installHandler).toMatch(/tray\?\.destroy\(\)/)
    expect(installHandler).toMatch(/installDownloadedUpdate\(\)/)
    // Code must not call quitAndInstall directly — only via installDownloadedUpdate (comment may name it).
    expect(installHandler.replace(/\/\/.*$/gm, '')).not.toMatch(/quitAndInstall\s*\(/)
    const beforeQuit = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf("app.on('will-quit'"))
    expect(beforeQuit).toMatch(/isInstallingUpdate\(\)/)
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
