import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ASK_REVEAL_MIN_HEIGHT_PX, BAR_IDLE_HEIGHT_PX, WINDOW_RESIZE_HUG_FLOOR_PX } from '../../../src/shared/overlay-chrome'
import {
  childHasExited,
  closeApp,
  findPage,
  killOwned,
  overlayChromeGeometry,
  ownedCensus,
  readNumericConstants,
  waitFor,
  withTimeout
} from './app-driver.mjs'

const ROOT = '/opt/smoke/Metis.app'

describe('withTimeout', () => {
  it('resolves with the operation result', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1_000, 'late')).resolves.toBe('done')
  })

  it('rejects with the caller message when the operation never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'stuck quitting')).rejects.toThrow('stuck quitting')
  })

  it('propagates the operation error and leaves no pending timer', async () => {
    vi.useFakeTimers()
    try {
      await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'late')).rejects.toThrow('boom')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('waitFor', () => {
  it('returns the first truthy value, retrying falsy results', async () => {
    let calls = 0
    const value = await waitFor(async () => (++calls < 3 ? null : 'ready'), 'never', 1_000, 5)
    expect(value).toBe('ready')
    expect(calls).toBe(3)
  })

  it('retries a throwing check and still succeeds', async () => {
    let calls = 0
    const value = await waitFor(
      () => {
        if (++calls < 2) throw new Error('mid-navigation')
        return 42
      },
      'never',
      1_000,
      5
    )
    expect(value).toBe(42)
  })

  it('times out with the message and the last error seen', async () => {
    await expect(
      waitFor(
        () => {
          throw new Error('page closed')
        },
        'window did not appear',
        30,
        5
      )
    ).rejects.toThrow('window did not appear (page closed)')
  })

  it('times out with the bare message when the check only returns falsy', async () => {
    await expect(waitFor(() => false, 'no bounds', 30, 5)).rejects.toThrow(/^no bounds$/)
  })

  it('checks once even with a zero timeout', async () => {
    await expect(waitFor(() => 'now', 'never', 0)).resolves.toBe('now')
  })
})

describe('findPage', () => {
  const page = (url: string, closed = false) => ({ url: () => url, isClosed: () => closed })
  const browser = (...pages: unknown[]) => ({ contexts: () => [{ pages: () => pages }] })

  it('skips closed pages and pages whose probe throws', async () => {
    const closed = page('a', true)
    const flaky = page('b')
    const good = page('c')
    const found = await findPage(
      browser(closed, flaky, good),
      (p: ReturnType<typeof page>) => {
        if (p === flaky) throw new Error('navigating')
        return p.url() === 'c'
      },
      'no page',
      100,
      5
    )
    expect(found).toBe(good)
  })

  it('reports the caller message when nothing matches in time', async () => {
    await expect(findPage(browser(page('x')), () => false, 'overlay page not found', 30, 5)).rejects.toThrow(
      'overlay page not found'
    )
  })
})

describe('ownedCensus', () => {
  const table = [
    { pid: 10, ppid: 1, startedMs: 100, exe: `${ROOT}/Contents/MacOS/Metis`, role: 'Metis' },
    { pid: 11, ppid: 10, startedMs: 101, exe: '/usr/bin/helper', role: 'helper' },
    { pid: 12, ppid: 1, startedMs: 102, exe: '/usr/bin/Metis', role: 'Metis' },
    { pid: 13, ppid: 1, startedMs: 103, exe: `${ROOT}/Contents/Resources/llama/llama-server`, role: 'llama-server' }
  ]

  it('owns main, its descendants and root residents — never a same-named outsider', () => {
    const { owned, roles } = ownedCensus({
      platform: 'darwin',
      mainPid: 10,
      installRoot: ROOT,
      listTable: () => table
    })
    expect(owned.map((entry) => entry.pid).sort()).toEqual([10, 11, 13])
    expect(roles).toEqual({ Metis: 1, helper: 1, 'llama-server': 1 })
  })

  it('with no main pid owns only what is resident under the root', () => {
    const { owned } = ownedCensus({ platform: 'darwin', mainPid: null, installRoot: ROOT, listTable: () => table })
    expect(owned.map((entry) => entry.pid).sort()).toEqual([10, 13])
  })

  it('asks the process table for the requested platform', () => {
    const listTable = vi.fn(() => [])
    ownedCensus({ platform: 'win32', mainPid: 1, installRoot: 'C:\\Metis', listTable })
    expect(listTable).toHaveBeenCalledWith('win32')
  })
})

describe('killOwned', () => {
  it('kills each owned pid, tolerating one that is already gone, and never this process', () => {
    const killed: number[] = []
    const kill = (pid: number) => {
      if (pid === 2) throw new Error('ESRCH')
      killed.push(pid)
    }
    const entry = (pid: number) => ({ pid, ppid: 1, startedMs: 1, exe: null, role: 'x' })
    killOwned([entry(1), entry(2), entry(process.pid), entry(3)], kill)
    expect(killed).toEqual([1, 3])
  })
})

describe('closeApp', () => {
  function fakeChild({ obeys }: { obeys: 'SIGTERM' | 'SIGKILL' | null }) {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      signals: [] as string[],
      kill(signal: string) {
        child.signals.push(signal)
        if (signal === obeys) {
          child.signalCode = signal
          child.emit('exit')
        }
        return true
      }
    })
    return child
  }
  const fakeApp = (child: ReturnType<typeof fakeChild>) => ({
    process: () => child,
    evaluate: () => Promise.resolve(),
    close: () => Promise.resolve()
  })

  it('does nothing without an app', async () => {
    await expect(closeApp(null)).resolves.toBeUndefined()
  })

  it('does not signal a child that already exited', async () => {
    const child = fakeChild({ obeys: null })
    child.exitCode = 0
    await closeApp(fakeApp(child), { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual([])
  })

  it('escalates SIGTERM to SIGKILL only for a child that ignores SIGTERM', async () => {
    const child = fakeChild({ obeys: 'SIGKILL' })
    await closeApp(fakeApp(child), { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(childHasExited(child)).toBe(true)
  })

  it('stops at SIGTERM when the child complies', async () => {
    const child = fakeChild({ obeys: 'SIGTERM' })
    await closeApp(fakeApp(child), { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('bounds a quit request that never answers', async () => {
    const child = fakeChild({ obeys: 'SIGTERM' })
    const app = { ...fakeApp(child), evaluate: () => new Promise(() => {}), close: () => new Promise(() => {}) }
    await closeApp(app, { requestTimeoutMs: 20, exitTimeoutMs: 20 })
    expect(child.signals).toEqual(['SIGTERM'])
  })
})

describe('overlay chrome geometry', () => {
  it('reads the same numbers the app compiles from src/shared/overlay-chrome.ts', () => {
    expect(overlayChromeGeometry()).toEqual({
      barIdleHeightPx: BAR_IDLE_HEIGHT_PX,
      askRevealMinHeightPx: ASK_REVEAL_MIN_HEIGHT_PX,
      hugFloorPx: WINDOW_RESIZE_HUG_FLOOR_PX
    })
  })

  it('refuses a constant that is missing or not a literal rather than guessing', () => {
    expect(() => readNumericConstants('export const A = 1 + 2', ['A'])).toThrow(/not a numeric export/)
    expect(() => readNumericConstants('', ['B'])).toThrow(/not a numeric export/)
    expect(readNumericConstants('export const C = 84', ['C'])).toEqual({ C: 84 })
  })
})
