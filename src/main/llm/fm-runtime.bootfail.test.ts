/**
 * Boot-failure contract for fm-runtime (review findings, 2026-07-16): a `fm serve` that exits before
 * becoming healthy must fail the start() FAST (never sit out the 20s health budget polling a dead port)
 * and must count against the session crash budget so repeated boot failures settle the engine on
 * 'unavailable' (llama fallback) instead of re-paying spawn+fail on every text request.
 *
 * Isolated from fm-runtime.test.ts because these tests mock node:child_process and node:net, which would
 * break that file's real-binary integration test.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock.spawn }))

// findFreePort binds a real ephemeral port — mock it out so the suite stays sandbox-safe (CI runners and
// the local sandbox both restrict socket binds).
vi.mock('node:net', () => ({
  createServer: () => {
    const srv = new EventEmitter() as EventEmitter & {
      unref: () => void
      listen: (port: number, host: string, cb: () => void) => void
      address: () => { port: number }
      close: (cb: () => void) => void
    }
    srv.unref = () => {}
    srv.listen = (_port, _host, cb) => cb()
    srv.address = () => ({ port: 45_678 })
    srv.close = (cb) => cb()
    return srv
  }
}))

import { start, getState } from './fm-runtime'

/** A fake fm-serve child that exits (code 1) almost immediately after spawn — the boot-failure shape. */
function instantExitProc(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: () => void } {
  const proc = new EventEmitter() as ReturnType<typeof instantExitProc>
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
  }
  setTimeout(() => {
    proc.stderr.emit('data', Buffer.from('bind: operation not permitted\n'))
    proc.emit('exit', 1, null)
  }, 10)
  return proc
}

describe('fm-runtime boot failure', () => {
  it('start() rejects FAST when fm serve exits pre-health, and the crash budget lands on unavailable', async () => {
    spawnMock.spawn.mockImplementation(() => instantExitProc())

    // 1st boot failure: fast rejection, state 'stopped' (budget not yet exhausted).
    const t0 = Date.now()
    await expect(start()).rejects.toThrow(/exited before becoming healthy/)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(5_000) // the pre-fix behavior burned the full 20s health budget
    expect(getState()).toBe('stopped')

    // 2nd boot failure inside the window: budget (2) exhausted → 'unavailable' for the session.
    await expect(start()).rejects.toThrow(/exited before becoming healthy/)
    expect(getState()).toBe('unavailable')

    // 3rd attempt never spawns — the session refuses immediately so text asks fall to llama with no tax.
    const spawnsBefore = spawnMock.spawn.mock.calls.length
    await expect(start()).rejects.toThrow(/unavailable for this session/)
    expect(spawnMock.spawn.mock.calls.length).toBe(spawnsBefore)
  })
})
