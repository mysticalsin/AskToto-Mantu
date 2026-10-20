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
import { PassThrough } from 'node:stream'

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

import { start, stop, isRunning, getState } from './fm-runtime'

type FakeProc = EventEmitter & { stdout: PassThrough; stderr: PassThrough; killed: boolean; kill: () => void }
function serveProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
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
    const healthOk = { status: 200 }
    const g2Health = {
      resolve: null as ((v: typeof healthOk) => void) | null,
      signalRequested: null as (() => void) | null,
      requested: false
    }
    const g2HealthStarted = new Promise<void>((resolve) => {
      g2Health.signalRequested = resolve
    })
    const g2HealthResponse = new Promise<typeof healthOk>((resolve) => {
      g2Health.resolve = resolve
    })
    let g2: Promise<void> | null = null
    let g2Settled: Promise<{ status: 'resolved' } | { status: 'rejected'; error: unknown }> | null = null

    spawnMock.spawn.mockImplementation(() => {
      const proc = serveProc()
      procs.push(proc)
      return proc
    })

    // G1: healthy start — health poll succeeds immediately; idle timer arms on success.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => healthOk) // G1 first poll → healthy
      .mockImplementation(() => {
        if (!g2Health.requested) {
          g2Health.requested = true
          g2Health.signalRequested?.()
        }
        return g2HealthResponse
      })
    vi.stubGlobal('fetch', fetchMock)

    try {
      await start()
      expect(isRunning()).toBe(true)
      expect(procs).toHaveLength(1)

      // Crash while running: exit handler must clear the armed idle timer (the fix under test).
      procs[0].emit('exit', 1, null)
      expect(getState()).toBe('stopped')

      // G2: restart begins; its health request signals readiness and stays pending in 'starting'.
      g2 = start()
      const g2Settlement = g2.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      )
      g2Settled = g2Settlement
      const readiness = await Promise.race([
        g2HealthStarted.then(() => 'health-requested' as const),
        g2Settlement.then(() => 'start-settled' as const)
      ])
      expect(readiness).toBe('health-requested')
      expect(getState()).toBe('starting')
      expect(procs).toHaveLength(2)
      expect(procs[1].killed).toBe(false)

      // The full idle window elapses while G2 is starting. A stale G1 timer would fire stop() here,
      // bump the generation, and G2 would reject with 'start cancelled'.
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000)
      expect(getState()).toBe('starting')
      expect(procs).toHaveLength(2)
      expect(procs[1].killed).toBe(false)

      // Release G2's health poll — with the fix, the restart completes untouched.
      expect(g2Health.resolve).not.toBeNull()
      g2Health.resolve!(healthOk)
      await g2
      expect(isRunning()).toBe(true)
      const unsupervisedReasons = auditMock.auditLog.mock.calls.flatMap(([event, detail]) =>
        event === 'sidecar.unsupervised' ? [(detail as { reason?: string })?.reason] : []
      )
      expect(unsupervisedReasons).not.toContain('wrapper-spawn-failed')
      expect(unsupervisedReasons).not.toContain('wrapper-setup-failed')
      if (process.platform === 'darwin') expect(unsupervisedReasons).not.toContain('wrapper-missing')
      expect(
        auditMock.auditLog.mock.calls.some(
          ([event, detail]) => event === 'local.runtime.stop' && (detail as { reason?: string })?.reason === 'idle'
        )
      ).toBe(false)
    } finally {
      g2Health.resolve?.(healthOk)
      try {
        if (g2Settled) await g2Settled
      } finally {
        try {
          stop()
        } finally {
          for (const proc of procs) {
            proc.stdout.end()
            proc.stderr.end()
            proc.stdout.destroy()
            proc.stderr.destroy()
          }
          vi.unstubAllGlobals()
          vi.useRealTimers()
        }
      }
    }
  })
})
