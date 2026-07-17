/**
 * Regression lock for probeAvailability's asymmetric cache TTL (review fix, 2026-07-16): the probe
 * spawns a real `fm available` subprocess on the TTFT-critical suggest path. Unavailable results must
 * cache for 10 minutes (machines with Apple Intelligence off pay ~zero recurring cost); available
 * results keep the short 60s TTL so a mid-session toggle-OFF is noticed quickly. Collapsing the two
 * TTLs flips the spawn counts below.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: () => true }
})
const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock.spawn }))

import { probeAvailability } from './fm-runtime'

const realPlatform = process.platform
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  // Fake Date so TTL windows are controllable; timers stay faked too so the probe's own timeout timer
  // (setTimeout) never fires a stray SIGKILL between tests.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  vi.useRealTimers()
})

function probeProc(output: string): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const proc = new EventEmitter() as ReturnType<typeof probeProc>
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => {}
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from(output))
    proc.emit('exit', 0, null)
  })
  return proc
}

describe('probeAvailability TTL asymmetry', () => {
  it('caches an UNAVAILABLE result ~10 minutes but an AVAILABLE result only ~60s', async () => {
    spawnMock.spawn.mockImplementation(() => probeProc('System model unavailable: appleIntelligenceNotEnabled\n'))

    expect((await probeAvailability()).available).toBe(false)
    expect(spawnMock.spawn).toHaveBeenCalledTimes(1)

    // 9 minutes later: still inside the negative TTL — served from cache, no new subprocess.
    vi.advanceTimersByTime(9 * 60_000)
    await probeAvailability()
    expect(spawnMock.spawn).toHaveBeenCalledTimes(1)

    // Past 10 minutes: negative TTL expired — probes again.
    vi.advanceTimersByTime(2 * 60_000)
    await probeAvailability()
    expect(spawnMock.spawn).toHaveBeenCalledTimes(2)

    // Flip the machine to available (force refresh installs the positive cache entry).
    spawnMock.spawn.mockImplementation(() => probeProc('System model available\n'))
    expect((await probeAvailability(true)).available).toBe(true)
    expect(spawnMock.spawn).toHaveBeenCalledTimes(3)

    // 30s later: inside the short positive TTL — cached.
    vi.advanceTimersByTime(30_000)
    await probeAvailability()
    expect(spawnMock.spawn).toHaveBeenCalledTimes(3)

    // 61s after the positive probe: expired — a mid-session toggle-OFF would be noticed here.
    vi.advanceTimersByTime(31_000)
    await probeAvailability()
    expect(spawnMock.spawn).toHaveBeenCalledTimes(4)
  })
})
