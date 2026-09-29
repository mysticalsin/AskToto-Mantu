import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleTrayAfterFirstPaint, yieldToEventLoop, type TrayGateWindow } from './boot-tray'

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

  it('yieldToEventLoop resolves in a later task', async () => {
    const order: string[] = []
    setImmediate(() => order.push('immediate'))
    await yieldToEventLoop()
    order.push('after-yield')
    expect(order).toEqual(['immediate', 'after-yield'])
  })
})
