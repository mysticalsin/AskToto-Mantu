/**
 * Regression lock for the stale-idle-timer crash fix (review fix, 2026-07-16): a crash while 'running'
 * must cancel the 15-minute idle-stop timer armed for that instance. Without the fix, the stale timer
 * fires into a LATER start()'s 'starting' window, stop() bumps the generation, and the recovery start
 * spuriously rejects — Apple-FM recovery silently broken for up to 15 minutes after any crash.
 *
 * Deliberately fakes ONLY timers (not Date): pollHealth's deadline math uses Date.now(), and advancing
 * a faked Date 15 minutes would expire the health budget and mask what this test proves.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'

const auditMock = vi.hoisted(() => ({ auditLog: vi.fn() }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: auditMock.auditLog }))
const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock.spawn }))
vi.mock('node:net', () => ({
  createServer: () => {
    const srv = new EventEmitter() as EventEmitter & {
      unref: () => void
      listen: (port: number, host: string, cb: () => void) => void
      address: () => { port: number }
      close: (cb: () => void) => void
    }
    srv.unref = () => {}
    srv.listen = (_p, _h, cb) => cb()
    srv.address = () => ({ port: 45_679 })
    srv.close = (cb) => cb()
    return srv
  }
}))

import { start, isRunning, getState } from './fm-runtime'

type FakeProc = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: () => void }
function serveProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
  }
  return proc
}

beforeAll(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterAll(() => vi.useRealTimers())

describe('crash clears the idle-stop timer', () => {
  it('a crash-then-restart survives the full idle window while the restart is still starting', async () => {
    const procs: FakeProc[] = []
    spawnMock.spawn.mockImplementation(() => {
      const proc = serveProc()
      procs.push(proc)
      return proc
    })

    // G1: healthy start — health poll succeeds immediately; idle timer arms on success.
    const healthOk = { status: 200 }
    let resolveG2Health: ((v: typeof healthOk) => void) | null = null
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => healthOk) // G1 first poll → healthy
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveG2Health = resolve as typeof resolveG2Health // G2 polls held pending
          })
      )
    vi.stubGlobal('fetch', fetchMock)

    await start()
    expect(isRunning()).toBe(true)
    expect(procs).toHaveLength(1)

    // Crash while running: exit handler must clear the armed idle timer (the fix under test).
    procs[0].emit('exit', 1, null)
    expect(getState()).toBe('stopped')

    // G2: restart begins; health held pending so it sits in 'starting'.
    const g2 = start()
    // Give the async start body a tick to spawn + attach before advancing timers.
    await Promise.resolve()
    await Promise.resolve()
    expect(procs).toHaveLength(2)

    // The full idle window elapses while G2 is starting. A stale G1 timer would fire stop() here,
    // bump the generation, and G2 would reject with 'start cancelled'.
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000)

    // Release G2's health poll — with the fix, the restart completes untouched.
    expect(resolveG2Health).not.toBeNull()
    resolveG2Health!(healthOk)
    await g2
    expect(isRunning()).toBe(true)
    expect(
      auditMock.auditLog.mock.calls.some(
        ([event, detail]) => event === 'local.runtime.stop' && (detail as { reason?: string })?.reason === 'idle'
      )
    ).toBe(false)
    vi.unstubAllGlobals()
  })
})
