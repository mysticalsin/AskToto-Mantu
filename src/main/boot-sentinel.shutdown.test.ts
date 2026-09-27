import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginRunWatch, markAlive, markShutdownClean } from './boot-sentinel'

/**
 * M2-0006 — the clean-shutdown marker. `run-state.json` holds only `{bootId, clean}`, written
 * synchronously at boot and at the end of `will-quit`; the liveness heartbeat lives in a separate
 * `run-alive.json` ({bootId, at}) that `markAlive` rewrites asynchronously. These tests drive the real
 * file-backed functions end to end — write, read back, overwrite — the same way
 * boot-sentinel.crash-dumps.test.ts does for the MQA-175 sentinel above them in the same file.
 */
describe('M2-0006 — beginRunWatch / markAlive / markShutdownClean', () => {
  let userData: string
  let seq: number

  /** Deterministic ISO clock and boot-id generator so assertions never race the real clock or need to
   *  parse a UUID — each call just advances by one second from a fixed start. */
  function fakeNow(): string {
    seq += 1
    return new Date(1_700_000_000_000 + seq * 1000).toISOString()
  }
  function fakeBootId(prefix: string): () => string {
    let n = 0
    return () => `${prefix}-${++n}`
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-runwatch-'))
    seq = 0
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('a fresh profile has no prior run: prevShutdown is unknown, and a fresh bootId is written', () => {
    const { bootId, prior } = beginRunWatch(userData, fakeNow, fakeBootId('a'))
    expect(bootId).toBe('a-1')
    expect(prior).toEqual({ prevBootId: undefined, prevShutdown: 'unknown', prevLastAliveAt: undefined })
    const stateOnDisk = JSON.parse(readFileSync(join(userData, 'run-state.json'), 'utf8'))
    expect(stateOnDisk).toEqual({ bootId: 'a-1', clean: false })
    const aliveOnDisk = JSON.parse(readFileSync(join(userData, 'run-alive.json'), 'utf8'))
    expect(aliveOnDisk).toEqual({ bootId: 'a-1', at: new Date(1_700_000_001_000).toISOString() })
  })

  it('a run that reaches markShutdownClean is reported as clean on the next boot, with its bootId and last-alive timestamp', () => {
    const run1 = beginRunWatch(userData, fakeNow, fakeBootId('a'))
    const detail = markShutdownClean(userData, run1.bootId, 123.4)
    expect(detail).toEqual({ bootId: 'a-1', uptimeS: 123.4, reason: 'will-quit' })
    const aliveAtOnDisk = JSON.parse(readFileSync(join(userData, 'run-alive.json'), 'utf8')).at

    const run2 = beginRunWatch(userData, fakeNow, fakeBootId('b'))
    expect(run2.bootId).toBe('b-1')
    expect(run2.prior).toEqual({ prevBootId: 'a-1', prevShutdown: 'clean', prevLastAliveAt: aliveAtOnDisk })
  })

  it('a run that never calls markShutdownClean is reported as unclean on the next boot (force-quit / crash / hard kill)', () => {
    const run1 = beginRunWatch(userData, fakeNow, fakeBootId('a'))
    // Simulates the process dying mid-run: no markShutdownClean call before the next launch.
    const run2 = beginRunWatch(userData, fakeNow, fakeBootId('b'))
    expect(run2.prior.prevBootId).toBe(run1.bootId)
    expect(run2.prior.prevShutdown).toBe('unclean')
  })

  it('markShutdownClean never touches run-alive.json — the two files are independent, so a late async heartbeat write can never undo the clean marker', () => {
    const run1 = beginRunWatch(userData, fakeNow, fakeBootId('a'))
    const aliveBefore = readFileSync(join(userData, 'run-alive.json'), 'utf8')
    markShutdownClean(userData, run1.bootId, 1)
    expect(readFileSync(join(userData, 'run-alive.json'), 'utf8')).toBe(aliveBefore)
    expect(JSON.parse(readFileSync(join(userData, 'run-state.json'), 'utf8')).clean).toBe(true)
  })

  it('markAlive rewrites run-alive.json for the current run without touching run-state.json', async () => {
    const run1 = beginRunWatch(userData, fakeNow, fakeBootId('a'))
    const stateBefore = readFileSync(join(userData, 'run-state.json'), 'utf8')
    await markAlive(userData, run1.bootId, fakeNow)
    expect(readFileSync(join(userData, 'run-state.json'), 'utf8')).toBe(stateBefore)
    const aliveOnDisk = JSON.parse(readFileSync(join(userData, 'run-alive.json'), 'utf8'))
    expect(aliveOnDisk.bootId).toBe(run1.bootId)

    // The process dies right after that heartbeat — the next boot must see the HEARTBEAT's timestamp,
    // not the original beginRunWatch timestamp, and must still call it unclean.
    const run2 = beginRunWatch(userData, fakeNow, fakeBootId('b'))
    expect(run2.prior).toEqual({ prevBootId: 'a-1', prevShutdown: 'unclean', prevLastAliveAt: aliveOnDisk.at })
  })

  it('a run-alive.json left by an older run (bootId does not match run-state.json) is never attributed to the reported prior run', () => {
    beginRunWatch(userData, fakeNow, fakeBootId('a'))
    // A stale heartbeat from two launches ago that never got overwritten — must not be misread as this
    // prior run's last-alive evidence.
    writeFileSync(join(userData, 'run-alive.json'), JSON.stringify({ bootId: 'some-other-run', at: fakeNow() }), 'utf8')
    const { prior } = beginRunWatch(userData, fakeNow, fakeBootId('b'))
    expect(prior.prevBootId).toBe('a-1')
    expect(prior.prevLastAliveAt).toBeUndefined()
  })

  it('a corrupt run-state.json reads as unknown, never as a guessed clean or unclean, and boot still proceeds', () => {
    writeFileSync(join(userData, 'run-state.json'), '{not json', 'utf8')
    const { bootId, prior } = beginRunWatch(userData, fakeNow, fakeBootId('a'))
    expect(bootId).toBe('a-1')
    expect(prior.prevShutdown).toBe('unknown')
  })

  it('a hand-edited run-state.json missing a real bootId reads as unknown, not as evidence of anything', () => {
    writeFileSync(join(userData, 'run-state.json'), JSON.stringify({ bootId: '', clean: true }), 'utf8')
    const { prior } = beginRunWatch(userData, fakeNow, fakeBootId('a'))
    expect(prior).toEqual({ prevBootId: undefined, prevShutdown: 'unknown', prevLastAliveAt: undefined })
  })

  it('an unwritable userData never throws — beginRunWatch/markAlive/markShutdownClean degrade to best-effort', async () => {
    const unwritable = join(userData, 'does', 'not', 'exist-yet-and-parent-is-a-file')
    writeFileSync(join(userData, 'does'), 'blocks mkdir -p', 'utf8')
    expect(() => beginRunWatch(unwritable, fakeNow, fakeBootId('a'))).not.toThrow()
    await expect(markAlive(unwritable, 'a-1', fakeNow)).resolves.toBeUndefined()
    expect(() => markShutdownClean(unwritable, 'a-1', 1)).not.toThrow()
  })

  it('real randomUUID/Date defaults produce a usable bootId and prior record with no injected args', () => {
    const { bootId, prior } = beginRunWatch(userData)
    expect(bootId).toMatch(/^[0-9a-f-]{36}$/)
    expect(prior.prevShutdown).toBe('unknown')
  })
})
