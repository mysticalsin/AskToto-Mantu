import { describe, expect, it, vi } from 'vitest'
import type { TaskBrowserReceipt } from '@shared/task-browser'
import { MAX_TASK_BROWSER_WINDOWS, TASK_BROWSER_PARTITION } from '@shared/task-browser'
import { TaskBrowserManager, type TaskBrowserSurface } from './task-browser-manager'
import {
  allowedTaskBrowserUrl,
  applyTaskBrowserSessionPolicy,
  taskBrowserWebPreferences,
  type TaskBrowserSessionLike
} from './task-browser-policy'

interface FakeSurface extends TaskBrowserSurface {
  loads: string[]
  closed: boolean
  navigate(url: string): boolean
  newWindow(url: string): void
  finish(url: string): void
  fail(url: string): void
  personCloses(): void
}

function fakeSurface(): FakeSurface {
  let allow: (url: string) => boolean = () => true
  let newWin: (url: string) => void = () => undefined
  let finished: (url: string) => void = () => undefined
  let failed: (url: string) => void = () => undefined
  let onClosed: () => void = () => undefined
  const surface: FakeSurface = {
    loads: [],
    closed: false,
    load: (url) => {
      surface.loads.push(url)
      return Promise.resolve()
    },
    onNavigate: (fn) => (allow = fn),
    onNewWindow: (fn) => (newWin = fn),
    onLoadFinished: (fn) => (finished = fn),
    onLoadFailed: (fn) => (failed = fn),
    onClosed: (fn) => (onClosed = fn),
    close: () => {
      surface.closed = true
    },
    navigate: (url) => allow(url),
    newWindow: (url) => newWin(url),
    finish: (url) => finished(url),
    fail: (url) => failed(url),
    personCloses: () => onClosed()
  }
  return surface
}

function setup(opts: { acknowledged?: boolean } = {}) {
  const surfaces: FakeSurface[] = []
  const receipts: TaskBrowserReceipt[] = []
  let acknowledged = opts.acknowledged ?? true
  const clear = vi.fn(() => Promise.resolve())
  const manager = new TaskBrowserManager({
    createSurface: () => {
      const s = fakeSurface()
      surfaces.push(s)
      return s
    },
    session: { clear },
    disclosure: {
      acknowledged: () => Promise.resolve(acknowledged),
      acknowledge: () => {
        acknowledged = true
        return Promise.resolve()
      }
    },
    observe: (r) => receipts.push(r)
  })
  return { manager, surfaces, receipts, clear }
}

describe('task browser webPreferences hardening', () => {
  it('is sandboxed, isolated, node-free, preload-free and on its own persistent partition', () => {
    const prefs = taskBrowserWebPreferences(false)
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: TASK_BROWSER_PARTITION
    })
    expect('preload' in prefs).toBe(false)
    expect(TASK_BROWSER_PARTITION).toBe('persist:metis-task-browser')
  })
})

describe('task browser address policy', () => {
  it.each([
    'http://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'blob:https://example.com/x',
    'metis://handoff',
    'about:blank',
    'https://user:pw@example.com/',
    'not a url',
    '',
    `https://example.com/${'a'.repeat(5000)}`
  ])('refuses %s', (raw) => {
    expect(allowedTaskBrowserUrl(raw)).toBeNull()
  })
  it('allows https', () => {
    expect(allowedTaskBrowserUrl('https://example.com/a?b=1')?.origin).toBe('https://example.com')
  })
})

describe('task browser session policy', () => {
  it('denies every permission request and check and cancels downloads', () => {
    let request: ((...a: unknown[]) => void) | undefined
    let check: (() => boolean) | undefined
    let device: (() => boolean) | undefined
    let download: ((e: { preventDefault(): void }, i: { cancel(): void }) => void) | undefined
    const session: TaskBrowserSessionLike = {
      setPermissionRequestHandler: (h) => (request = h),
      setPermissionCheckHandler: (h) => (check = h),
      setDevicePermissionHandler: (h) => (device = h),
      on: (_event, listener) => {
        download = listener
      }
    }
    applyTaskBrowserSessionPolicy(session)
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi']) {
      const callback = vi.fn()
      request?.({}, permission, callback)
      expect(callback).toHaveBeenCalledExactlyOnceWith(false)
    }
    expect(check?.()).toBe(false)
    expect(device?.()).toBe(false)
    const preventDefault = vi.fn()
    const cancel = vi.fn()
    download?.({ preventDefault }, { cancel })
    expect(preventDefault).toHaveBeenCalled()
    expect(cancel).toHaveBeenCalled()
  })
})

describe('task browser manager', () => {
  it('needs the one-time profile disclosure before the first window', async () => {
    const { manager, surfaces } = setup({ acknowledged: false })
    expect(await manager.open('t1', 'https://example.com/')).toEqual({ ok: false, reason: 'disclosure_required' })
    expect(surfaces).toHaveLength(0)
    await manager.acknowledgeDisclosure()
    expect(await manager.open('t1', 'https://example.com/')).toEqual({ ok: true, reused: false })
  })

  it('refuses a non-https address without creating a window', async () => {
    const { manager, surfaces, receipts } = setup()
    expect(await manager.open('t1', 'http://example.com/')).toEqual({ ok: false, reason: 'blocked_url' })
    expect(surfaces).toHaveLength(0)
    expect(receipts.map((r) => r.kind)).toEqual(['navigation_blocked'])
  })

  it('keeps one window per task and caps the total', async () => {
    const { manager, surfaces } = setup()
    await manager.open('t1', 'https://a.example/')
    expect(await manager.open('t1', 'https://b.example/')).toEqual({ ok: true, reused: true })
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.loads).toEqual(['https://a.example/', 'https://b.example/'])
    for (let i = 2; i <= MAX_TASK_BROWSER_WINDOWS; i += 1) await manager.open(`t${i}`, 'https://a.example/')
    expect(await manager.open('overflow', 'https://a.example/')).toEqual({ ok: false, reason: 'too_many_windows' })
  })

  it('cancels navigation and redirects to a refused address and allows https', async () => {
    const { manager, surfaces, receipts } = setup()
    await manager.open('t1', 'https://a.example/')
    const s = surfaces[0]!
    expect(s.navigate('https://b.example/x')).toBe(true)
    for (const bad of ['http://b.example/', 'file:///etc/hosts', 'javascript:1', 'data:text/html,x']) {
      expect(s.navigate(bad)).toBe(false)
    }
    expect(receipts.filter((r) => r.kind === 'navigation_blocked')).toHaveLength(4)
  })

  it('opens a page-requested new window in the same window or refuses it', async () => {
    const { manager, surfaces } = setup()
    await manager.open('t1', 'https://a.example/')
    const s = surfaces[0]!
    s.newWindow('https://popup.example/p')
    s.newWindow('http://popup.example/p')
    s.newWindow('file:///x')
    expect(s.loads).toEqual(['https://a.example/', 'https://popup.example/p'])
    expect(surfaces).toHaveLength(1)
  })

  it('reports receipts bound to the task with an origin and a hash, never the address', async () => {
    const { manager, surfaces, receipts } = setup()
    await manager.open('t1', 'https://a.example/secret?token=abc')
    surfaces[0]?.finish('https://a.example/secret?token=abc')
    surfaces[0]?.fail('https://a.example/other')
    expect(receipts.map((r) => r.kind)).toEqual(['opened', 'navigation_started', 'load_finished', 'load_failed'])
    expect(receipts.every((r) => r.taskId === 't1')).toBe(true)
    const json = JSON.stringify(receipts)
    expect(json).not.toContain('secret')
    expect(json).not.toContain('token')
    expect(receipts[2]).toMatchObject({ origin: 'https://a.example', urlHash: expect.stringMatching(/^[0-9a-f]{8}$/) })
  })

  it('a throwing observer never breaks the window', async () => {
    const surface = fakeSurface()
    const manager = new TaskBrowserManager({
      createSurface: () => surface,
      session: { clear: () => Promise.resolve() },
      disclosure: { acknowledged: () => Promise.resolve(true), acknowledge: () => Promise.resolve() },
      observe: () => {
        throw new Error('observer')
      }
    })
    expect(await manager.open('t1', 'https://a.example/')).toEqual({ ok: true, reused: false })
  })

  it('releases the window when the task ends and when the owner stops everything', async () => {
    const { manager, surfaces, receipts } = setup()
    await manager.open('t1', 'https://a.example/')
    await manager.open('t2', 'https://a.example/')
    expect(manager.release('t1')).toBe(true)
    expect(surfaces[0]?.closed).toBe(true)
    expect(manager.hasWindow('t1')).toBe(false)
    expect(manager.release('t1')).toBe(false)
    expect(manager.releaseAll()).toBe(1)
    expect(surfaces[1]?.closed).toBe(true)
    expect((await manager.status()).openWindows).toBe(0)
    expect(receipts.filter((r) => r.kind === 'released').map((r) => r.taskId)).toEqual(['t1', 't2'])
  })

  it('forgets a window the person closed and ignores a late close of a released one', async () => {
    const { manager, surfaces, receipts } = setup()
    await manager.open('t1', 'https://a.example/')
    surfaces[0]?.personCloses()
    expect(manager.hasWindow('t1')).toBe(false)
    expect(receipts.at(-1)?.kind).toBe('closed_by_person')
    await manager.open('t2', 'https://a.example/')
    manager.release('t2')
    const before = receipts.length
    surfaces[1]?.personCloses()
    expect(receipts).toHaveLength(before)
  })

  it('clears the task profile after closing the windows, and reports a failure', async () => {
    const { manager, surfaces, clear } = setup()
    await manager.open('t1', 'https://a.example/')
    expect(await manager.clearProfile()).toBe(true)
    expect(surfaces[0]?.closed).toBe(true)
    expect(clear).toHaveBeenCalledOnce()
    clear.mockRejectedValueOnce(new Error('disk'))
    expect(await manager.clearProfile()).toBe(false)
  })

  it('reports the current tab as unavailable and opens nothing (D-21)', async () => {
    const { manager, surfaces } = setup()
    expect(manager.openCurrentTab()).toEqual({
      ok: false,
      reason: 'current_tab_unavailable',
      copy: "Using your current browser tab isn't available yet."
    })
    expect((await manager.status()).currentTab).toEqual({
      status: 'unavailable',
      copy: "Using your current browser tab isn't available yet."
    })
    expect(surfaces).toHaveLength(0)
  })
})
