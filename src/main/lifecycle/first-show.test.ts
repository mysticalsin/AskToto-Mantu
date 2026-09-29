import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { scheduleFirstShow, type FirstShowWindow } from './first-show'

function fakeWindow(opts: { destroyed?: boolean } = {}): EventEmitter & FirstShowWindow {
  const win = new EventEmitter() as EventEmitter & FirstShowWindow
  win.isDestroyed = () => opts.destroyed ?? false
  return win
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('scheduleFirstShow (M2-0031)', () => {
  it('never shows in the constructing task, and shows in the next task without any renderer event', async () => {
    const win = fakeWindow()
    const show = vi.fn()
    scheduleFirstShow(win, show)
    expect(show).not.toHaveBeenCalled()
    await flush()
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('shows at ready-to-show when that comes first, and only once', async () => {
    const win = fakeWindow()
    const show = vi.fn()
    scheduleFirstShow(win, show)
    win.emit('ready-to-show')
    expect(show).toHaveBeenCalledTimes(1)
    await flush()
    win.emit('ready-to-show')
    expect(show).toHaveBeenCalledTimes(1)
    expect(win.listenerCount('ready-to-show')).toBe(0)
  })

  it('releases its ready-to-show listener after the next-task show', async () => {
    const win = fakeWindow()
    scheduleFirstShow(win, vi.fn())
    await flush()
    expect(win.listenerCount('ready-to-show')).toBe(0)
  })

  it('does not show a window destroyed before its turn', async () => {
    const show = vi.fn()
    scheduleFirstShow(fakeWindow({ destroyed: true }), show)
    await flush()
    expect(show).not.toHaveBeenCalled()
  })
})
