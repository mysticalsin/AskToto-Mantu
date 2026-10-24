import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// G86 — download and install are separate steps; an install never closes a meeting or a running task; a staged
// download is verified before it can install; a boot after an install re-checks the helpers.
vi.mock('electron')
vi.mock('./win-security', () => ({ readTrustedAdminManaged: vi.fn((): string | null => null) }))
vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => 'provider: github\nowner: mysticalsin\n') }))
// The install receipt has its own suite (update/update-receipt.test.ts); here it is recorded, not written.
vi.mock('./update/update-receipt', () => ({
  readInstallReceipt: vi.fn(async () => null),
  writeInstallReceipt: vi.fn(async () => {}),
  clearInstallReceipt: vi.fn(async () => {})
}))

import { app, Notification, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { isHelperQuarantined } from './update/helper-quarantine'
import { clearInstallReceipt, readInstallReceipt, writeInstallReceipt } from './update/update-receipt'
import {
  getUpdateState,
  initAutoUpdate,
  reconcileAfterUpdate,
  requestInstall,
  resetUpdateLifecycleForTests,
  startUpdateDownload
} from './updater'

class FakeAutoUpdater extends EventEmitter {
  logger: unknown = null
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(
    async (): Promise<{ downloadPromise?: Promise<unknown> | null; isUpdateAvailable?: boolean } | null> => null
  )
  downloadUpdate = vi.fn(async (): Promise<unknown> => null)
  quitAndInstall = vi.fn()
}

function pinPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

describe('G86 — update lifecycle', () => {
  const electronApp = app as unknown as { isPackaged?: boolean; name?: string }
  const proc = process as NodeJS.Process & { resourcesPath?: string; windowsStore?: boolean }
  const send = vi.fn()
  const win = { webContents: { send } } as unknown as BrowserWindow
  let fake: FakeAutoUpdater
  let moduleId: string
  let restorePlatform: () => void
  let busy: Array<'meeting' | 'task'> = []
  const GOOD = { fileSize: async () => 10, sha512Base64: async () => 'h' }
  const deps = (verify = GOOD) => ({ busyReasons: () => [...busy], userDataDir: () => 'userdata', verify })
  const offer = (version = '99.0.0'): void => void fake.emit('update-available', { version })
  const download = async (version = '99.0.0'): Promise<void> => {
    fake.emit('update-downloaded', {
      version,
      downloadedFile: `/cache/Metis-${version}.zip`,
      files: [{ url: `Metis-${version}.zip`, sha512: 'h' }]
    })
    await flushAsync()
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    resetUpdateLifecycleForTests()
    busy = []
    send.mockClear()
    vi.mocked(Notification).mockClear()
    vi.mocked(readInstallReceipt).mockReset().mockResolvedValue(null)
    vi.mocked(writeInstallReceipt).mockClear()
    vi.mocked(clearInstallReceipt).mockClear()
    vi.mocked(app.on).mockClear()
    electronApp.isPackaged = true
    electronApp.name = 'Métis'
    proc.resourcesPath = 'C:/fake-resources'
    Reflect.deleteProperty(proc, 'windowsStore')
    fake = new FakeAutoUpdater()
    moduleId = require.resolve('electron-updater')
    require.cache[moduleId] = {
      id: moduleId,
      filename: moduleId,
      loaded: true,
      exports: { autoUpdater: fake }
    } as never
    restorePlatform = pinPlatform('linux')
  })

  afterEach(() => {
    restorePlatform()
    delete require.cache[moduleId]
    delete electronApp.isPackaged
    Reflect.deleteProperty(proc, 'resourcesPath')
    resetUpdateLifecycleForTests()
    vi.useRealTimers()
  })

  it('downloads and installs are separate: both flags are turned off', () => {
    initAutoUpdate(() => win, deps())
    expect(fake.autoDownload).toBe(false)
    expect(fake.autoInstallOnAppQuit).toBe(false)
  })

  it('a background offer downloads when idle, and reaches ready only after verification', async () => {
    initAutoUpdate(() => win, deps())
    offer()
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(getUpdateState().phase).toBe('downloading')
    expect(fake.autoInstallOnAppQuit).toBe(false)
    await download()
    expect(fake.autoInstallOnAppQuit).toBe(true)
    expect(getUpdateState()).toEqual({ phase: 'ready', version: '99.0.0' })
    expect(send).toHaveBeenCalledWith(IPC.updateDownloaded, { version: '99.0.0', notes: undefined })
  })

  it('a background offer during a meeting waits, then downloads once the app is idle', () => {
    initAutoUpdate(() => win, deps())
    busy = ['meeting']
    offer()
    expect(fake.downloadUpdate).not.toHaveBeenCalled()
    expect(getUpdateState()).toEqual({ phase: 'available-deferred', version: '99.0.0', deferred: ['meeting'] })
    vi.advanceTimersByTime(15_000)
    expect(fake.downloadUpdate).not.toHaveBeenCalled() // still busy
    busy = []
    vi.advanceTimersByTime(15_000)
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('a hash mismatch is rejected: not ready, quit-install stays off, nothing is announced', async () => {
    initAutoUpdate(() => win, deps({ ...GOOD, sha512Base64: async () => 'tampered' }))
    offer()
    await download()
    expect(getUpdateState().phase).toBe('verify-failed')
    expect(fake.autoInstallOnAppQuit).toBe(false)
    expect(send.mock.calls.some((c) => c[0] === IPC.updateDownloaded)).toBe(false)
  })

  it('requestInstall during a meeting does not relaunch and writes no receipt', async () => {
    initAutoUpdate(() => win, deps())
    offer()
    await download()
    vi.mocked(writeInstallReceipt).mockClear() // the receipt left when the update became ready
    busy = ['meeting', 'task']
    expect(await requestInstall()).toEqual({ installed: false, deferred: ['meeting', 'task'] })
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    expect(writeInstallReceipt).not.toHaveBeenCalled()
    expect(getUpdateState().phase).toBe('install-deferred')
  })

  it('a deferred install is re-offered through the quiet gate when idle, and never relaunches by itself', async () => {
    initAutoUpdate(() => win, deps())
    offer()
    await download()
    busy = ['task']
    await requestInstall()
    vi.mocked(Notification).mockClear()
    busy = []
    vi.advanceTimersByTime(15_000)
    expect(getUpdateState().phase).toBe('ready')
    expect(vi.mocked(Notification)).toHaveBeenCalledWith(expect.objectContaining({ title: 'Update ready to install' }))
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
  })

  it('writes the receipt before quitAndInstall when idle', async () => {
    initAutoUpdate(() => win, deps())
    offer()
    await download()
    expect(await requestInstall()).toEqual({ installed: true })
    expect(vi.mocked(writeInstallReceipt)).toHaveBeenCalledWith('userdata', {
      schema: 1,
      fromVersion: '0.1.0-test',
      toVersion: '99.0.0',
      at: expect.any(Number)
    })
    expect(vi.mocked(writeInstallReceipt).mock.invocationCallOrder[0]).toBeLessThan(
      fake.quitAndInstall.mock.invocationCallOrder[0]
    )
  })

  it('does not relaunch when capture starts while the receipt is being written', async () => {
    initAutoUpdate(() => win, deps())
    offer()
    await download()
    vi.mocked(writeInstallReceipt).mockImplementationOnce(async () => {
      busy = ['meeting']
    })
    expect(await requestInstall()).toEqual({ installed: false, deferred: ['meeting'] })
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    expect(clearInstallReceipt).toHaveBeenCalled()
  })

  it('refuses to install when nothing verified is staged', async () => {
    initAutoUpdate(() => win, deps())
    expect(await requestInstall()).toEqual({ installed: false, reason: 'not-ready' })
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
  })

  it('leaves a receipt as soon as a verified update can install on a quit the user chooses', async () => {
    initAutoUpdate(() => win, deps())
    offer()
    expect(writeInstallReceipt).not.toHaveBeenCalled() // downloaded, not yet verified
    await download()
    expect(writeInstallReceipt).toHaveBeenCalledWith(
      'userdata',
      expect.objectContaining({ fromVersion: '0.1.0-test', toVersion: '99.0.0' })
    )
  })

  describe('reconcileAfterUpdate — the first boot after an install', () => {
    const receipt = { schema: 1 as const, fromVersion: '2.0.0', toVersion: '2.1.0', at: 1 }
    const run = (currentVersion: string, reverify = vi.fn(async () => [])): Promise<void> =>
      reconcileAfterUpdate({ userDataDir: () => 'userdata', currentVersion, reverify })

    it('still on the old version: the install failed, the prior app is intact, the receipt is cleared', async () => {
      vi.mocked(readInstallReceipt).mockResolvedValue(receipt)
      const reverify = vi.fn(async () => [])
      await run('2.0.0', reverify)
      expect(getUpdateState()).toEqual({ phase: 'install-failed', fromVersion: '2.0.0', version: '2.1.0' })
      expect(reverify).not.toHaveBeenCalled()
      expect(clearInstallReceipt).toHaveBeenCalled()
    })

    it('on the new version: helpers are held back until re-verification passes, then released', async () => {
      vi.mocked(readInstallReceipt).mockResolvedValue(receipt)
      let release: (v: never[]) => void = () => {}
      const reverify = vi.fn(() => new Promise<never[]>((res) => (release = res)))
      const done = reconcileAfterUpdate({ userDataDir: () => 'userdata', currentVersion: '2.1.0', reverify })
      expect(isHelperQuarantined()).toBe(true) // pending from the first synchronous moment
      await flushAsync()
      expect(getUpdateState().phase).toBe('post-verify')
      expect(isHelperQuarantined()).toBe(true) // still pending while the helpers are being checked
      release([])
      await done
      expect(isHelperQuarantined()).toBe(false)
      expect(getUpdateState().phase).toBe('current')
      expect(clearInstallReceipt).toHaveBeenCalled()
    })

    it('a failed re-verification quarantines helpers and offers a guided reinstall of the previous version', async () => {
      vi.mocked(readInstallReceipt).mockResolvedValue(receipt)
      const reverify = vi.fn(async () => [{ id: 'mac-helper', result: 'fail' as const, reason: 'codesign' }])
      await run('2.1.0', reverify as never)
      const state = getUpdateState()
      expect(state.phase).toBe('helpers-quarantined')
      expect(state.rollbackUrl).toBe('https://github.com/mysticalsin/Metis-Releases/releases/tag/v2.0.0')
      expect(isHelperQuarantined()).toBe(true)
      expect(clearInstallReceipt).not.toHaveBeenCalled() // kept so the next boot re-checks
    })

    it('an unexpected version is reported and the receipt cleared', async () => {
      vi.mocked(readInstallReceipt).mockResolvedValue(receipt)
      await run('1.9.0')
      expect(getUpdateState().phase).toBe('unknown-version')
      expect(clearInstallReceipt).toHaveBeenCalled()
    })

    it('no receipt: nothing changes', async () => {
      await run('2.1.0')
      expect(getUpdateState()).toEqual({ phase: 'idle' })
      expect(isHelperQuarantined()).toBe(false)
    })
  })
})

describe('G86 — an explicit Download works at any time', () => {
  it('starts the download itself even while a meeting is recording', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    resetUpdateLifecycleForTests()
    const electronApp = app as unknown as { isPackaged?: boolean }
    electronApp.isPackaged = true
    const fake = new FakeAutoUpdater()
    const moduleId = require.resolve('electron-updater')
    require.cache[moduleId] = {
      id: moduleId,
      filename: moduleId,
      loaded: true,
      exports: { autoUpdater: fake }
    } as never
    const restore = pinPlatform('linux')
    try {
      const { net } = await import('electron')
      vi.mocked(net.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: 'v99.0.0',
          assets: [
            { name: 'Metis-99.0.0.dmg' },
            { name: 'Metis-Setup-99.0.0.exe' },
            { name: 'Metis-Native-99.0.0.zip' }
          ]
        })
      } as unknown as Response)
      initAutoUpdate(() => ({ webContents: { send: vi.fn() } }) as unknown as BrowserWindow, {
        busyReasons: () => ['meeting']
      })
      fake.checkForUpdates.mockImplementation(async () => {
        fake.emit('update-available', { version: '99.0.0' })
        return { isUpdateAvailable: true }
      })
      expect(await startUpdateDownload()).toEqual({ started: true })
      expect(fake.downloadUpdate).toHaveBeenCalledTimes(1)
      expect(getUpdateState().phase).toBe('downloading')
    } finally {
      restore()
      delete require.cache[moduleId]
      delete electronApp.isPackaged
      resetUpdateLifecycleForTests()
      vi.useRealTimers()
    }
  })
})
