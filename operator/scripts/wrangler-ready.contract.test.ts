import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wranglerReadyEndpoint, waitForWranglerReady } from './wrangler-ready.mjs'

const ready = (port = 43123) => JSON.stringify({ event: 'DEV_SERVER_READY', ip: '127.0.0.1', port })

class DevChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

describe('Wrangler readiness messages', () => {
  it.each([1, 43123, 65535])('accepts only the child-announced loopback endpoint at port %i', (port) => {
    expect(wranglerReadyEndpoint(ready(port))).toBe(`http://127.0.0.1:${port}`)
  })

  it('ignores unrelated named IPC events', () => {
    expect(wranglerReadyEndpoint(JSON.stringify({ event: 'BUILD_START' }))).toBeNull()
  })

  it.each([
    null,
    42,
    true,
    {},
    [],
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 43123 },
    'not json',
    'null',
    '[]',
    '{}',
    '{"event":null}',
    '{"event":""}'
  ])('rejects malformed IPC data %#', (message) => {
    expect(() => wranglerReadyEndpoint(message)).toThrow('Invalid Wrangler readiness message')
  })

  it.each([
    { event: 'DEV_SERVER_READY', ip: 'localhost', port: 43123 },
    { event: 'DEV_SERVER_READY', ip: '0.0.0.0', port: 43123 },
    { event: 'DEV_SERVER_READY', ip: '192.0.2.1', port: 43123 },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1' },
    { event: 'DEV_SERVER_READY', port: 43123 },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 0 },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: -1 },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: '43123' },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 1.5 },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 65536 },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: null },
    { event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 43123, extra: true }
  ])('rejects an invalid ready record %#', (message) => {
    expect(() => wranglerReadyEndpoint(JSON.stringify(message))).toThrow('Invalid Wrangler readiness message')
  })
})

describe('owned Wrangler startup', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  function start(
    checkHealth: (base: string, signal: AbortSignal) => Promise<boolean> = async () => false,
    child = new DevChild()
  ) {
    const clock = { value: 0 }
    const promise = waitForWranglerReady(child, {
      deadline: 90_000,
      now: () => clock.value,
      checkHealth
    })
    const advance = async (ms: number) => {
      clock.value += ms
      await vi.advanceTimersByTimeAsync(ms)
    }
    return { child, clock, promise, advance }
  }

  function expectClean(child: DevChild) {
    expect(child.listenerCount('message')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }

  it('waits for exact-child IPC before checking health and cleans up on success', async () => {
    const checkHealth = vi.fn(async (_base: string, _signal: AbortSignal) => true)
    const { child, promise } = start(checkHealth)
    new DevChild().emit('message', ready(43124))
    child.emit('message', JSON.stringify({ event: 'BUILD_START' }))
    expect(checkHealth).not.toHaveBeenCalled()
    child.emit('message', ready())
    await expect(promise).resolves.toBe('http://127.0.0.1:43123')
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expect(checkHealth.mock.calls[0][0]).toBe('http://127.0.0.1:43123')
    expect(checkHealth.mock.calls[0][1].aborted).toBe(true)
    expectClean(child)
  })

  it('latches the first endpoint and never retargets an outstanding health check', async () => {
    let resolveHealth!: (healthy: boolean) => void
    const checkHealth = vi.fn(
      (_base: string, _signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          resolveHealth = resolve
        })
    )
    const { child, promise } = start(checkHealth)
    child.emit('message', ready())
    child.emit('message', ready(43124))
    resolveHealth(true)
    await expect(promise).resolves.toBe('http://127.0.0.1:43123')
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expectClean(child)
  })

  it.each(['not json', JSON.stringify({ event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: 0 })])(
    'fails closed on malformed readiness without probing another endpoint: %s',
    async (message) => {
      const checkHealth = vi.fn(async () => true)
      const { child, promise } = start(checkHealth)
      const rejected = expect(promise).rejects.toThrow('Invalid Wrangler readiness message')
      child.emit('message', message)
      await rejected
      expect(checkHealth).not.toHaveBeenCalled()
      expectClean(child)
    }
  )

  it('keeps the 500ms interval after an unhealthy response or a rejected request', async () => {
    const checkHealth = vi.fn(async (_base: string, _signal: AbortSignal) => false)
    checkHealth.mockRejectedValueOnce(new Error('not listening')).mockResolvedValueOnce(false).mockResolvedValue(true)
    const { child, promise, advance } = start(checkHealth)
    child.emit('message', ready())
    await advance(0)
    await advance(499)
    expect(checkHealth).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(checkHealth).toHaveBeenCalledTimes(2)
    await advance(500)
    await expect(promise).resolves.toBe('http://127.0.0.1:43123')
    expect(checkHealth).toHaveBeenCalledTimes(3)
    expectClean(child)
  })

  it('rejects missing readiness at the original deadline', async () => {
    const checkHealth = vi.fn(async () => true)
    const { child, promise, advance } = start(checkHealth)
    const rejected = expect(promise).rejects.toThrow('Wrangler startup deadline exceeded')
    await advance(90_000)
    await rejected
    expect(checkHealth).not.toHaveBeenCalled()
    expectClean(child)
  })

  it('does not grant a fresh health budget after late readiness', async () => {
    const checkHealth = vi.fn(async (_base: string, _signal: AbortSignal) => false)
    const { child, promise, advance } = start(checkHealth)
    const rejected = expect(promise).rejects.toThrow('Wrangler startup deadline exceeded')
    await advance(89_500)
    child.emit('message', ready())
    await advance(0)
    await advance(500)
    await rejected
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expect(checkHealth.mock.calls[0][1].aborted).toBe(true)
    expectClean(child)
  })

  it('aborts a stalled health request at the deadline and ignores its later success', async () => {
    let resolveHealth!: (healthy: boolean) => void
    const checkHealth = vi.fn(
      (_base: string, _signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          resolveHealth = resolve
        })
    )
    const { child, promise, advance } = start(checkHealth)
    const rejected = expect(promise).rejects.toThrow('Wrangler startup deadline exceeded')
    child.emit('message', ready())
    await advance(90_000)
    await rejected
    expect(checkHealth.mock.calls[0][1].aborted).toBe(true)
    resolveHealth(true)
    await advance(0)
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expectClean(child)
  })

  it('rejects late health success even before the deadline timer callback runs', async () => {
    let resolveHealth!: (healthy: boolean) => void
    const { child, clock, promise } = start(
      () =>
        new Promise<boolean>((resolve) => {
          resolveHealth = resolve
        })
    )
    const rejected = expect(promise).rejects.toThrow('Wrangler startup deadline exceeded')
    child.emit('message', ready())
    clock.value = 90_001
    resolveHealth(true)
    await rejected
    expectClean(child)
  })

  it('never starts health work when readiness arrives after the original deadline', async () => {
    const checkHealth = vi.fn(async () => true)
    const { child, clock, promise } = start(checkHealth)
    const rejected = expect(promise).rejects.toThrow('Wrangler startup deadline exceeded')
    clock.value = 90_000
    child.emit('message', ready())
    await rejected
    expect(checkHealth).not.toHaveBeenCalled()
    expectClean(child)
  })

  it('fails closed and aborts health if a later readiness record is malformed', async () => {
    const checkHealth = vi.fn((_base: string, _signal: AbortSignal) => new Promise<boolean>(() => {}))
    const { child, promise } = start(checkHealth)
    const rejected = expect(promise).rejects.toThrow('Invalid Wrangler readiness message')
    child.emit('message', ready())
    child.emit('message', JSON.stringify({ event: 'DEV_SERVER_READY', ip: 'localhost', port: 43124 }))
    await rejected
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expect(checkHealth.mock.calls[0][1].aborted).toBe(true)
    expectClean(child)
  })

  it.each(['error', 'exit'])('rejects child %s before IPC readiness without making a request', async (event) => {
    const checkHealth = vi.fn(async () => true)
    const { child, promise } = start(checkHealth)
    const rejected = expect(promise).rejects.toThrow('Wrangler child stopped before readiness')
    child.emit(event, event === 'error' ? new Error('spawn failed') : 1)
    await rejected
    expect(checkHealth).not.toHaveBeenCalled()
    expectClean(child)
  })

  it.each(['error', 'exit'])('rejects child %s and aborts outstanding health work', async (event) => {
    const checkHealth = vi.fn((_base: string, _signal: AbortSignal) => new Promise<boolean>(() => {}))
    const { child, promise } = start(checkHealth)
    const rejected = expect(promise).rejects.toThrow('Wrangler child stopped before readiness')
    child.emit('message', ready())
    child.emit(event, event === 'error' ? new Error('spawn failed') : 1)
    await rejected
    expect(checkHealth.mock.calls[0][1].aborted).toBe(true)
    expectClean(child)
  })

  it.each(['exitCode', 'signalCode'] as const)('rejects an already stopped child with %s', async (field) => {
    const child = new DevChild()
    if (field === 'exitCode') child.exitCode = 0
    else child.signalCode = 'SIGTERM'
    const { promise } = start(async () => true, child)
    await expect(promise).rejects.toThrow('Wrangler child stopped before readiness')
    expectClean(child)
  })

  it('does not remove listeners owned by the caller', async () => {
    const child = new DevChild()
    const observer = vi.fn()
    child.on('message', observer)
    const { promise } = start(async () => true, child)
    child.emit('message', ready())
    await expect(promise).resolves.toBe('http://127.0.0.1:43123')
    expect(child.listeners('message')).toEqual([observer])
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
