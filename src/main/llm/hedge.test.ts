import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { HedgeRace } from './hedge'

describe('HedgeRace', () => {
  it('is undecided until a leg declares a winner', () => {
    const race = new HedgeRace()
    expect(race.isDecided()).toBe(false)
    expect(race.isLoser('primary')).toBe(false)
    expect(race.isLoser('hedge')).toBe(false)
  })

  it('the first leg to declare a winner wins; the other becomes the loser', () => {
    const race = new HedgeRace()
    race.declareWinner('primary')
    expect(race.isDecided()).toBe(true)
    expect(race.isLoser('primary')).toBe(false)
    expect(race.isLoser('hedge')).toBe(true)
  })

  it('declareWinner is idempotent — a later call from the loser cannot flip the outcome', () => {
    const race = new HedgeRace()
    race.declareWinner('hedge')
    race.declareWinner('primary') // too late, hedge already won
    expect(race.isLoser('hedge')).toBe(false)
    expect(race.isLoser('primary')).toBe(true)
  })

  it('declareWinner aborts the OTHER leg once its handle is already registered', () => {
    const race = new HedgeRace()
    const primaryHandle = { abort: vi.fn() }
    const hedgeHandle = { abort: vi.fn() }
    race.setHandle('primary', primaryHandle)
    race.setHandle('hedge', hedgeHandle)
    race.declareWinner('hedge')
    expect(primaryHandle.abort).toHaveBeenCalledTimes(1)
    expect(hedgeHandle.abort).not.toHaveBeenCalled()
  })

  it('a handle registered AFTER the winner is already decided is aborted immediately', () => {
    const race = new HedgeRace()
    race.declareWinner('primary')
    const lateHedgeHandle = { abort: vi.fn() }
    race.setHandle('hedge', lateHedgeHandle)
    expect(lateHedgeHandle.abort).toHaveBeenCalledTimes(1)
  })

  it('the winner registering its handle after winning is never aborted', () => {
    const race = new HedgeRace()
    race.declareWinner('primary')
    const primaryHandle = { abort: vi.fn() }
    race.setHandle('primary', primaryHandle)
    expect(primaryHandle.abort).not.toHaveBeenCalled()
  })

  describe('markDead — a leg with no more retries gives up, but only surfaces once BOTH legs are out', () => {
    it('a lone primary (hedge never eligible) surfaces immediately on its own death', () => {
      const race = new HedgeRace()
      race.markHedgeUnavailable()
      expect(race.markDead('primary')).toBe('surface')
    })

    it('primary dying first suppresses — the hedge might still answer', () => {
      const race = new HedgeRace()
      expect(race.markDead('primary')).toBe('suppress')
    })

    it('once BOTH legs are dead, the second one to die surfaces', () => {
      const race = new HedgeRace()
      expect(race.markDead('primary')).toBe('suppress')
      expect(race.markDead('hedge')).toBe('surface')
    })

    it('hedge dying while primary is still alive suppresses too', () => {
      const race = new HedgeRace()
      expect(race.markDead('hedge')).toBe('suppress')
    })

    it('a leg marked dead twice does not resurrect the other as "still viable"', () => {
      const race = new HedgeRace()
      expect(race.markDead('primary')).toBe('suppress')
      expect(race.markDead('primary')).toBe('suppress') // hedge still genuinely unresolved
      expect(race.markDead('hedge')).toBe('surface')
    })
  })

  // MQA-132: found by physically driving the app — a misconfigured primary died at ~0.4s but the answer
  // still took 3.7s, because the backup sat idle until HEDGE_DELAY_MS. 'suppress' promises another leg
  // will answer, so that leg has to actually be running.
  describe('MQA-132: early hedge start — a dead primary must not leave the backup waiting on the timer', () => {
    it('pulls the backup forward the moment the primary dies', () => {
      const race = new HedgeRace()
      const start = vi.fn()
      race.setHedgeStarter(start)
      expect(race.markDead('primary')).toBe('suppress')
      expect(start).toHaveBeenCalledTimes(1)
    })

    it('never starts the backup twice when the timer also fires', () => {
      const race = new HedgeRace()
      const start = vi.fn(() => race.markHedgeStarted())
      race.setHedgeStarter(start)
      race.markDead('primary')
      race.markDead('primary') // a second exhaustion report must not re-launch it
      expect(start).toHaveBeenCalledTimes(1)
    })

    it('does not start the backup once it is already running', () => {
      const race = new HedgeRace()
      const start = vi.fn()
      race.setHedgeStarter(start)
      race.markHedgeStarted() // the HEDGE_DELAY_MS timer already launched it
      race.markDead('primary')
      expect(start).not.toHaveBeenCalled()
    })

    it('does not start the backup after the race is already won', () => {
      const race = new HedgeRace()
      const start = vi.fn()
      race.setHedgeStarter(start)
      race.declareWinner('primary')
      race.markDead('primary')
      expect(start).not.toHaveBeenCalled()
    })

    it('does not start a backup that was already found unavailable, and surfaces instead', () => {
      const race = new HedgeRace()
      const start = vi.fn()
      race.setHedgeStarter(start)
      race.markHedgeUnavailable()
      expect(race.markDead('primary')).toBe('surface')
      expect(start).not.toHaveBeenCalled()
    })

    it('a dying HEDGE leg never tries to start another hedge', () => {
      const race = new HedgeRace()
      const start = vi.fn()
      race.setHedgeStarter(start)
      race.markDead('hedge')
      expect(start).not.toHaveBeenCalled()
    })

    it('is inert when no starter was ever registered (non-hedged asks)', () => {
      const race = new HedgeRace()
      expect(() => race.markDead('primary')).not.toThrow()
      expect(race.markDead('hedge')).toBe('surface')
    })

    // The worst possible outcome: no answer AND no error. If the primary dies and the early start then
    // discovers there is no eligible backup, viability must be judged AFTER that discovery — otherwise
    // markDead reads the stale "hedge might still answer", says 'suppress', and the ask spins forever.
    it('surfaces (never suppresses) when the early start finds no backup at all', () => {
      const race = new HedgeRace()
      // A realistic starter: pickFailover found nothing, so it reports the hedge unavailable.
      race.setHedgeStarter(() => race.markHedgeUnavailable())
      expect(race.markDead('primary')).toBe('surface')
    })

    it('still suppresses when the early start actually launched a backup', () => {
      const race = new HedgeRace()
      race.setHedgeStarter(() => race.markHedgeStarted())
      expect(race.markDead('primary')).toBe('suppress')
      // ...and once that backup also dies, the failure finally surfaces.
      expect(race.markDead('hedge')).toBe('surface')
    })

    it('surfaces when the primary dies after the timer already ruled the backup out', () => {
      const race = new HedgeRace()
      race.setHedgeStarter(() => race.markHedgeUnavailable())
      race.markHedgeUnavailable() // the HEDGE_DELAY_MS timer fired first and found no backup
      expect(race.markDead('primary')).toBe('surface')
    })
  })

  // MQA-151: once a winner exists it is the ONLY leg that can still be heard — the loser is aborted and
  // startHedgeLeg refuses to launch a backup. markDead ignored `winner` entirely, so the still-true
  // hedgeMayStart read as "the backup might answer": a winner that died mid-stream (idle watchdog at +45s,
  // a socket reset after its first token) was told to stay quiet, and index.ts's onError then sent neither
  // streamError nor streamDone and never released the combined streams entry — a spinner that never stops.
  describe('MQA-151: a decided race — the winner dying mid-stream surfaces, a loser still suppresses', () => {
    it('MQA-151 — the winning leg dying after its first token surfaces instead of hanging forever', () => {
      const race = new HedgeRace()
      race.setHedgeStarter(vi.fn()) // a backup is still nominally startable — the stale "might answer"
      race.declareWinner('primary')
      expect(race.markDead('primary')).toBe('surface')
    })

    it('MQA-151 — a leg that already LOST still suppresses, so it cannot overwrite the winner', () => {
      const race = new HedgeRace()
      race.declareWinner('primary')
      expect(race.markDead('hedge')).toBe('suppress')
    })

    it('MQA-151 — holds with the hedge as winner too', () => {
      const race = new HedgeRace()
      race.declareWinner('hedge')
      expect(race.markDead('hedge')).toBe('surface')
      expect(race.markDead('primary')).toBe('suppress')
    })
  })

  describe('abortAll — user cancel mid-race', () => {
    it('aborts whichever handles are currently registered', () => {
      const race = new HedgeRace()
      const primaryHandle = { abort: vi.fn() }
      race.setHandle('primary', primaryHandle)
      race.abortAll()
      expect(primaryHandle.abort).toHaveBeenCalledTimes(1)
    })

    it('is a no-op (never throws) when no handle exists yet', () => {
      const race = new HedgeRace()
      expect(() => race.abortAll()).not.toThrow()
    })

    it('runs every registered cleanup (a pending same-provider retry timer)', () => {
      const race = new HedgeRace()
      const cleanup1 = vi.fn()
      const cleanup2 = vi.fn()
      race.addCleanup(cleanup1)
      race.addCleanup(cleanup2)
      race.abortAll()
      expect(cleanup1).toHaveBeenCalledTimes(1)
      expect(cleanup2).toHaveBeenCalledTimes(1)
    })

    it('cleanups run exactly once even if abortAll is called twice', () => {
      const race = new HedgeRace()
      const cleanup = vi.fn()
      race.addCleanup(cleanup)
      race.abortAll()
      race.abortAll()
      expect(cleanup).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * MQA-134 — the wiring half of the race contract, pinned against the real source. index.ts boots Electron
 * at import time and attempt()/onDone are closures inside the askStart handler, so there is no
 * index.test.ts (same rationale as ask-freshness.contract.test.ts).
 *
 * The defect: a cloud/CLI leg that finished with ZERO tokens and had no failover target fell through to
 * the success path — under a race that deleted the COMBINED abort registration while the other leg was
 * still streaming (so a later Cancel found no entry and the live stream ran on, billing), and ended the
 * ask with a blank streamDone.
 */
describe('MQA-134: a zero-token leg with nowhere left to fail over must not end the whole race', () => {
  const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  it('gates that terminal path through markDead instead of falling into streamDone', () => {
    const at = indexSrc.indexOf("if (!gotToken && provider !== 'local' && failover(")
    expect(at, 'the zero-token failover attempt was not found').toBeGreaterThan(-1)
    // Immediately after the failover attempt, before the local branch and before any success handling.
    const body = indexSrc.slice(at, at + 1400)
    expect(body).toMatch(/if \(!gotToken && provider !== 'local'\) \{/)
    expect(body).toMatch(/race\.gate\.markDead\(race\.leg\) !== 'surface'\) return/)
    // When it IS terminal the user gets a real error, never a blank "done".
    expect(body).toMatch(/IPC\.streamError/)
  })

  it('only surrenders the shared streams entry once the race is genuinely over', () => {
    const at = indexSrc.indexOf("if (!gotToken && provider !== 'local') {")
    const body = indexSrc.slice(at, at + 700)
    // The markDead bail-out precedes the delete, so a suppressed leg never touches the combined handle.
    expect(body.indexOf("markDead")).toBeLessThan(body.indexOf('streams.delete(req.id)'))
  })
})

/**
 * MQA-143/144 — two more race-wiring invariants pinned against the real source, same rationale as
 * MQA-134 above (attempt()/onDelta/onError are closures inside the askStart handler).
 */
describe('MQA-143/144: the race reports the right provider and releases its handle', () => {
  const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  // MQA-143: both legs announce themselves when they start. If the backup started second and the PRIMARY
  // then won, the UI's last streamMeta named the loser — the answer was attributed to a provider that
  // produced none of it.
  it('MQA-143: a losing leg never announces itself, and the winner re-asserts on its first token', () => {
    const send = indexSrc.indexOf('win?.webContents.send(IPC.streamMeta')
    expect(send).toBeGreaterThan(-1)
    // The start-time announcement is gated on not having already lost.
    expect(indexSrc.slice(send - 220, send)).toMatch(/!race \|\| !race\.gate\.isLoser\(race\.leg\)/)
    // ...and declaring the win re-sends it, so the last word is always the winner's.
    const win = indexSrc.indexOf('race.gate.declareWinner(race.leg)')
    expect(indexSrc.slice(win, win + 400)).toMatch(/send\(IPC\.streamMeta/)
  })

  // MQA-144: the combined abort registration is installed once, before either leg starts. Every terminal
  // path has to release it or the HedgeRace and both handles stay reachable for the life of the process.
  it('MQA-144: every terminal path under a race deletes the combined streams entry', () => {
    // Success, the raced error, and both zero-token dead ends.
    const deletes = [...indexSrc.matchAll(/if \(race\) streams\.delete\(req\.id\)/g)]
    expect(deletes.length).toBeGreaterThanOrEqual(4)
    const err = indexSrc.indexOf('win?.webContents.send(IPC.streamError, { id: req.id, message: friendly })')
    expect(err).toBeGreaterThan(-1)
    // Looking further back: the keep-substantial-answer branch (plus the Act 5 trial hook it also fires,
    // MQA-281) sits between the race delete and streamError — widened from 700 once noteQualifyingUse's
    // call landed in that branch, same invariant either way.
    expect(indexSrc.slice(err - 900, err)).toMatch(/if \(race\) streams\.delete\(req\.id\)/)
  })
})

/**
 * MQA-161 — the dispatcher half of "exactly two legs, on two DIFFERENT providers". Pinned against the real
 * source for the same reason as MQA-134/143/144 above: startHedgeLeg()/attempt() are closures inside
 * index.ts's askStart handler, which boots Electron at import time.
 *
 * The defect: the backup was picked with pickFailover([primary]) against the id the primary leg STARTED
 * on. A leg that fails over keeps its leg identity, so by t = HEDGE_DELAY_MS the primary may already be
 * streaming from provider X while pickFailover still counted X untried — and, pickFailover being pure with
 * identical inputs, it returned exactly X. Two byte-identical requests (full system prompt + transcript,
 * and on a vision ask the whole base64 screenshot) billed to one provider, both sharing one failure mode.
 */
describe('MQA-161: the hedge backup is picked against every provider the primary leg actually reached', () => {
  const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  it('MQA-161 — attempt() records the live provider chain of the primary leg', () => {
    const at = indexSrc.indexOf('const primaryChain: ProviderId[] = []')
    expect(at, 'no primaryChain — the hedge can still race the provider the primary moved to').toBeGreaterThan(-1)
    const attemptAt = indexSrc.indexOf('const attempt = (provider: ProviderId')
    expect(attemptAt).toBeGreaterThan(-1)
    // Recorded on ENTRY, before any eligibility work, so a provider the primary bounced off still counts.
    expect(indexSrc.slice(attemptAt, attemptAt + 400)).toMatch(
      /race\?\.leg === 'primary' &&[\s\S]*primaryChain\.push\(provider\)/
    )
  })

  it('MQA-161 — startHedgeLeg excludes the whole chain, not just the original primary id', () => {
    const at = indexSrc.indexOf('function startHedgeLeg(): void {')
    expect(at).toBeGreaterThan(-1)
    const body = indexSrc.slice(at, indexSrc.indexOf('race.setHedgeStarter(startHedgeLeg)', at))
    expect(body).not.toMatch(/pickFailover\(\[primary\]\)/)
    expect(body).toMatch(/const tried = primaryChain\.slice\(\)/)
    expect(body).toMatch(/pickFailover\(tried\)/)
    // ...and the hedge leg carries the same exclusion into its OWN failover cascade, or it walks straight
    // back onto the provider the primary is streaming from.
    expect(body).toMatch(/attempt\(backup, tried, 0, \{ gate: race, leg: 'hedge' \}\)/)
  })

  it('MQA-161 — no eligible backup outside the chain still reports the hedge unavailable', () => {
    const at = indexSrc.indexOf('function startHedgeLeg(): void {')
    const body = indexSrc.slice(at, indexSrc.indexOf('race.setHedgeStarter(startHedgeLeg)', at))
    // markHedgeUnavailable is what lets markDead('primary') surface instead of promising a leg that will
    // never run — the permanent-spinner failure hedge.ts's own comment warns about.
    expect(body).toMatch(/if \(!backup\) \{[\s\S]{0,40}race\.markHedgeUnavailable\(\)/)
  })
})
