import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTrayInStages, scheduleTrayAfterFirstPaint, yieldToEventLoop, type TrayGateWindow } from './boot-tray'

function fakeWindow(opts: { loading?: boolean; url?: string; destroyed?: boolean } = {}) {
  type Gate = Omit<TrayGateWindow, 'webContents'> & { webContents: EventEmitter & TrayGateWindow['webContents'] }
  const win = new EventEmitter() as EventEmitter & Gate
  const contents = new EventEmitter()
  win.isDestroyed = () => opts.destroyed ?? false
  win.webContents = Object.assign(contents, {
    isLoading: () => opts.loading ?? true,
    getURL: () => opts.url ?? ''
  })
  return win
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('scheduleTrayAfterFirstPaint (M2-0422)', () => {
  afterEach(() => vi.useRealTimers())

  it('does not build the tray until the window has painted, then builds it in a later task', async () => {
    const win = fakeWindow()
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(win, build)
    await flush()
    expect(build).not.toHaveBeenCalled()

    win.emit('ready-to-show')
    expect(build).not.toHaveBeenCalled()
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('builds the tray once when both ready-to-show and did-finish-load fire', async () => {
    const win = fakeWindow()
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(win, build)
    win.emit('ready-to-show')
    win.webContents.emit('did-finish-load')
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('builds the tray at once when there is no usable window', () => {
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(null, build)
    scheduleTrayAfterFirstPaint(fakeWindow({ destroyed: true }), build)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('builds the tray after the current task when the window has already loaded', async () => {
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(fakeWindow({ loading: false, url: 'app://index' }), build)
    expect(build).not.toHaveBeenCalled()
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('falls back to a bounded timer when the paint never reports', async () => {
    vi.useFakeTimers()
    const build = vi.fn()
    scheduleTrayAfterFirstPaint(fakeWindow(), build)
    await vi.advanceTimersByTimeAsync(5000)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('buildTrayInStages loads the icon, creates the tray and attaches the menu in three separate tasks', async () => {
    const order: string[] = []
    const labels: string[] = []
    const fail = vi.fn()
    const done = buildTrayInStages<string>({
      loadIcon: async () => {
        order.push('load')
        return 'icon'
      },
      create: (icon) => order.push(`create:${icon}`),
      attachMenu: () => order.push('menu'),
      time: (label, fn) => {
        labels.push(label)
        return fn()
      },
      fail
    })
    // Every stage boundary is a task boundary: an immediate queued now runs before the tray is created,
    // and one queued after the create runs before the menu is attached.
    setImmediate(() => {
      order.push('between-load-and-create')
      setImmediate(() => order.push('between-create-and-menu'))
    })
    await done
    expect(order).toEqual(['load', 'between-load-and-create', 'create:icon', 'between-create-and-menu', 'menu'])
    expect(labels).toEqual(['createTray.newTray', 'createTray.attachMenu'])
    expect(fail).not.toHaveBeenCalled()
  })

  it('buildTrayInStages reports a failing stage once and runs no later stage', async () => {
    const attachMenu = vi.fn()
    const fail = vi.fn()
    await buildTrayInStages<string>({
      loadIcon: async () => 'icon',
      create: () => {
        throw new Error('status item refused')
      },
      attachMenu,
      time: (_label, fn) => fn(),
      fail
    })
    expect(attachMenu).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledExactlyOnceWith(new Error('status item refused'))
  })

  it('buildTrayInStages reports an icon load rejection without creating a tray', async () => {
    const create = vi.fn()
    const fail = vi.fn()
    await buildTrayInStages<string>({
      loadIcon: () => Promise.reject(new Error('decode failed')),
      create,
      attachMenu: vi.fn(),
      time: (_label, fn) => fn(),
      fail
    })
    expect(create).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledExactlyOnceWith(new Error('decode failed'))
  })

  it('yieldToEventLoop resolves in a later task', async () => {
    const order: string[] = []
    setImmediate(() => order.push('immediate'))
    await yieldToEventLoop()
    order.push('after-yield')
    expect(order).toEqual(['immediate', 'after-yield'])
  })
})
