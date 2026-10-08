import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTeardown, stopOwnedChild, WIN_TASKKILL } from './st-1-termination.mjs'

const ack = { state: 'acknowledged' }
const failed = (reason: string) => ({ state: 'unacknowledged', reason })
const missing = () => Object.assign(new Error('private path must not escape'), { code: 'ESRCH' })
const fixturePid = process.pid + 1
const child = () => ({ pid: fixturePid, exitCode: null as number | null, signalCode: null as string | null })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('owned ST-1 termination', () => {
  it('kills only the live detached group and requires both root exit and group absence', async () => {
    const owned = child()
    let clock = 0
    const signal = vi.fn((_pid: number, kind: number | string) => {
      if (kind === 0 && clock >= 50) throw missing()
      return true
    })
    const sleep = vi.fn(async (ms: number) => {
      clock += ms
      owned.exitCode = 0 // Root exit at 25 ms is insufficient: its group remains until 50 ms.
    })
    await expect(
      stopOwnedChild(owned, { platform: 'darwin', signal, now: () => clock, sleep, timeoutMs: 100 })
    ).resolves.toEqual(ack)
    expect(signal.mock.calls).toEqual([
      [-fixturePid, 0],
      [-fixturePid, 'SIGKILL'],
      [-fixturePid, 0],
      [-fixturePid, 0],
      [-fixturePid, 0]
    ])
    expect(sleep.mock.calls).toEqual([[25], [25]])
  })

  it('does not signal a pre-exited root with a surviving or reused numeric group', async () => {
    const signal = vi.fn(() => true)
    await expect(
      stopOwnedChild({ ...child(), exitCode: 0 }, { platform: 'linux', signal })
    ).resolves.toEqual(failed('group-still-present'))
    expect(signal.mock.calls).toEqual([[-fixturePid, 0]])
  })

  it('acknowledges an already exited root only with explicit ESRCH', async () => {
    const signal = vi.fn((_pid: number, _kind: number | string) => {
      throw missing()
    })
    await expect(
      stopOwnedChild({ ...child(), signalCode: 'SIGKILL' }, { platform: 'darwin', signal })
    ).resolves.toEqual(ack)
    expect(signal.mock.calls).toEqual([[-fixturePid, 0]])
  })

  it.each([
    ['EPERM', 'group-probe-permission'],
    ['EIO', 'group-probe-error']
  ])('does not treat %s as group absence or disclose its message', async (code, reason) => {
    const signal = vi.fn(() => {
      throw Object.assign(new Error('private stderr /owner/profile'), { code })
    })
    await expect(stopOwnedChild(child(), { platform: 'darwin', signal })).resolves.toEqual(failed(reason))
    expect(signal).toHaveBeenCalledTimes(1)
  })

  it('waits for root exit even when the group is already absent', async () => {
    let clock = 0
    const signal = vi.fn((_pid: number, _kind: number | string) => {
      throw missing()
    })
    const sleep = vi.fn(async (ms: number) => {
      clock += ms
    })
    await expect(
      stopOwnedChild(child(), { platform: 'linux', signal, now: () => clock, sleep, timeoutMs: 60 })
    ).resolves.toEqual(failed('root-exit-unobserved'))
    expect(sleep.mock.calls).toEqual([[25], [25], [10]])
    expect(signal.mock.calls.every((call) => call[1] === 0)).toBe(true)
  })

  it('times out a surviving group without leaked timers or attaching exit listeners', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const owned = { ...child(), on: vi.fn(), once: vi.fn() }
    const result = stopOwnedChild(owned, { platform: 'darwin', signal: () => true, timeoutMs: 60 })
    await vi.advanceTimersByTimeAsync(60)
    await expect(result).resolves.toEqual(failed('group-still-present'))
    expect(vi.getTimerCount()).toBe(0)
    expect(owned.on).not.toHaveBeenCalled()
    expect(owned.once).not.toHaveBeenCalled()
  })

  it('uses only the pinned taskkill target and observes owned-root exit afterward', async () => {
    let clock = 0
    const owned = child()
    const taskkill = vi.fn(() => {
      clock += 30
    })
    const sleep = vi.fn(async (ms: number) => {
      clock += ms
      owned.signalCode = 'SIGKILL'
    })
    await expect(
      stopOwnedChild(owned, { platform: 'win32', taskkill, now: () => clock, sleep, timeoutMs: 60 })
    ).resolves.toEqual(ack)
    expect(taskkill.mock.calls).toEqual([
      [
        WIN_TASKKILL,
        ['/pid', String(fixturePid), '/T', '/F'],
        { timeout: 60, killSignal: 'SIGKILL', stdio: 'ignore', windowsHide: true }
      ]
    ])
    expect(sleep.mock.calls).toEqual([[25]])
  })

  it('does not reset the deadline after taskkill or accept success after it expires', async () => {
    let clock = 0
    const owned = child()
    const sleep = vi.fn(async (_ms: number) => {})
    await expect(
      stopOwnedChild(owned, {
        platform: 'win32',
        timeoutMs: 60,
        now: () => clock,
        sleep,
        taskkill: () => {
          clock = 60
          owned.exitCode = 0
        }
      })
    ).resolves.toEqual(failed('root-exit-unobserved'))
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each([
    ['ETIMEDOUT', 'taskkill-timeout'],
    ['EIO', 'taskkill-failed']
  ])('retains %s taskkill failure even if the child exits and hides command output', async (code, reason) => {
    const owned = child()
    await expect(
      stopOwnedChild(owned, {
        platform: 'win32',
        taskkill: () => {
          owned.exitCode = 0
          throw Object.assign(new Error('/private/owner key'), { code, stdout: 'secret', stderr: 'secret' })
        }
      })
    ).resolves.toEqual(failed(reason))
  })

  it('refuses an already exited Windows root without invoking taskkill', async () => {
    const taskkill = vi.fn()
    await expect(
      stopOwnedChild({ ...child(), exitCode: 0 }, { platform: 'win32', taskkill })
    ).resolves.toEqual(failed('root-exit-unobserved'))
    expect(taskkill).not.toHaveBeenCalled()
  })

  it('rejects missing, invalid and self PIDs without signalling anything', async () => {
    const signal = vi.fn(() => true)
    const taskkill = vi.fn()
    for (const pid of [undefined, 0, 1, -42, 1.5, NaN, process.pid]) {
      await expect(stopOwnedChild({ ...child(), pid }, { signal, taskkill })).resolves.toEqual(failed('invalid-pid'))
    }
    expect(signal).not.toHaveBeenCalled()
    expect(taskkill).not.toHaveBeenCalled()
  })

  it('rejects invalid budgets and unsupported platforms before process operations', async () => {
    const signal = vi.fn(() => true)
    for (const timeoutMs of [0, -1, NaN, Infinity, 5_001]) {
      await expect(stopOwnedChild(child(), { timeoutMs, signal })).resolves.toEqual(failed('invalid-budget'))
    }
    await expect(stopOwnedChild(child(), { platform: 'aix', signal })).resolves.toEqual(failed('unsupported-platform'))
    expect(signal).not.toHaveBeenCalled()
  })

  it('cannot override the real self-PID guard through an injected option', async () => {
    const signal = vi.fn(() => true)
    const unsupported = { selfPid: fixturePid }
    await expect(
      stopOwnedChild({ ...child(), pid: process.pid }, { ...unsupported, platform: 'linux', signal })
    ).resolves.toEqual(failed('invalid-pid'))
    expect(signal).not.toHaveBeenCalled()
  })

  it.each(['C:\\untrusted\\taskkill.exe', '\\\\untrusted\\share\\taskkill.exe'])(
    'cannot substitute a caller-selected executable: %s',
    async (taskkillPath) => {
      const owned = child()
      const unsupported = { taskkillPath }
      const taskkill = vi.fn((_path: string) => {
        owned.exitCode = 0
      })
      await expect(stopOwnedChild(owned, { ...unsupported, platform: 'win32', taskkill })).resolves.toEqual(ack)
      expect(taskkill).toHaveBeenCalledTimes(1)
      expect(taskkill.mock.calls[0]?.[0]).toBe(WIN_TASKKILL)
    }
  )

  it('refuses a relative system-root target before invoking any executable', async () => {
    vi.stubEnv('SystemRoot', 'relative-system-root')
    vi.resetModules()
    const isolated = await import('./st-1-termination.mjs')
    const taskkill = vi.fn()
    await expect(isolated.stopOwnedChild(child(), { platform: 'win32', taskkill })).resolves.toEqual(
      failed('taskkill-failed')
    )
    expect(taskkill).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'never acknowledges a probe completed after the deadline (pre-exited: %s)',
    async (preExited) => {
      const owned = { ...child(), exitCode: preExited ? 0 : null }
      let clock = 0
      const signal = vi.fn((_pid: number, kind: number | string) => {
        if (kind === 0 && (preExited || clock > 0)) {
          clock = 60
          owned.exitCode = 0
          throw missing()
        }
        return true
      })
      await expect(
        stopOwnedChild(owned, {
          platform: 'linux',
          signal,
          timeoutMs: 60,
          now: () => clock,
          sleep: async (ms: number) => {
            clock += ms
          }
        })
      ).resolves.toEqual(failed('deadline-expired'))
      if (preExited) expect(signal.mock.calls).toEqual([[-fixturePid, 0]])
    }
  )
})

describe('closed teardown receipt', () => {
  it('keeps only the exact acknowledged and allowed unacknowledged shapes', () => {
    expect(normalizeTeardown(ack)).toEqual(ack)
    expect(normalizeTeardown(failed('group-still-present'))).toEqual(failed('group-still-present'))
    for (const invalid of [undefined, null, {}, { state: 'pending' }, { ...ack, path: '/private' }, failed('secret')]) {
      expect(normalizeTeardown(invalid)).toEqual(failed('invalid-receipt'))
    }
  })

  it('rejects inherited states, hidden extra keys and arrays without disclosing arbitrary properties', () => {
    const inherited = Object.assign(Object.create({ state: 'acknowledged' }), { secret: 'private' })
    const hidden = Object.defineProperty({ ...ack }, 'secret', { value: 'private' })
    const symbolic = { ...ack, [Symbol('private')]: 'private' }
    for (const invalid of [inherited, hidden, symbolic, Object.assign([], ack)]) {
      expect(normalizeTeardown(invalid)).toEqual(failed('invalid-receipt'))
    }
    expect(normalizeTeardown(Object.assign(Object.create(null), ack))).toEqual(ack)
  })
})
