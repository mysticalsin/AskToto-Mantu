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
