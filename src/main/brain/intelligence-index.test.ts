import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import {
  INTELLIGENCE_INDEX_HOURS,
  INTELLIGENCE_INDEX_TZ,
  NO_PROVIDER_INDEX_COPY,
  catchUpIntelligenceIndexIfNeeded,
  classifyIntelligenceClick,
  mostRecentlyElapsedSlot,
  nextSlotAt,
  resetIntelligenceIndexLockForTests,
  runIntelligenceIndex,
  setIntelligenceIndexWork,
  shouldCatchUp,
  writeIntelligenceIndexState,
  zonedDateTimeToUtc,
  zonedParts
} from './intelligence-index'

afterEach(() => {
  resetIntelligenceIndexLockForTests()
  setIntelligenceIndexWork(null)
})

function torontoMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return zonedDateTimeToUtc(year, month, day, hour, minute, INTELLIGENCE_INDEX_TZ)
}

describe('America/Toronto named slots', () => {
  it('pins 06:00, 12:00, 18:00', () => {
    expect([...INTELLIGENCE_INDEX_HOURS]).toEqual([6, 12, 18])
    expect(INTELLIGENCE_INDEX_TZ).toBe('America/Toronto')
  })

  it('computes the next slot after each named hour, including the wrap to tomorrow 06:00', () => {
    // 2026-08-31 is EDT (UTC-4).
    expect(nextSlotAt(torontoMs(2026, 8, 31, 5, 0))).toBe(torontoMs(2026, 8, 31, 6, 0))
    expect(nextSlotAt(torontoMs(2026, 8, 31, 6, 0))).toBe(torontoMs(2026, 8, 31, 12, 0))
    expect(nextSlotAt(torontoMs(2026, 8, 31, 12, 0))).toBe(torontoMs(2026, 8, 31, 18, 0))
    expect(nextSlotAt(torontoMs(2026, 8, 31, 18, 0))).toBe(torontoMs(2026, 9, 1, 6, 0))
    expect(nextSlotAt(torontoMs(2026, 8, 31, 19, 15))).toBe(torontoMs(2026, 9, 1, 6, 0))
  })

  it('uses the most recently elapsed slot, wrapping to yesterday 18:00 before 06:00', () => {
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 8, 31, 5, 0))).toBe(torontoMs(2026, 8, 30, 18, 0))
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 8, 31, 6, 0))).toBe(torontoMs(2026, 8, 31, 6, 0))
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 8, 31, 12, 0))).toBe(torontoMs(2026, 8, 31, 12, 0))
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 8, 31, 18, 0))).toBe(torontoMs(2026, 8, 31, 18, 0))
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 8, 31, 21, 0))).toBe(torontoMs(2026, 8, 31, 18, 0))
  })

  it('stays correct across the November EST change (UTC-5)', () => {
    // 2026-01-15 is EST.
    const parts = zonedParts(torontoMs(2026, 1, 15, 12, 0))
    expect(parts.hour).toBe(12)
    expect(nextSlotAt(torontoMs(2026, 1, 15, 12, 0))).toBe(torontoMs(2026, 1, 15, 18, 0))
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 1, 15, 5, 59))).toBe(torontoMs(2026, 1, 14, 18, 0))
  })

  it('catches up when lastSuccessAt is before the elapsed slot', () => {
    const now = torontoMs(2026, 8, 31, 13, 0)
    expect(shouldCatchUp(torontoMs(2026, 8, 31, 6, 0), now)).toBe(true)
    expect(shouldCatchUp(torontoMs(2026, 8, 31, 12, 0), now)).toBe(false)
    expect(shouldCatchUp(0, now)).toBe(true)
    expect(shouldCatchUp(null, now)).toBe(true)
  })
})

describe('classifyIntelligenceClick', () => {
  it('queues work when meetings exist and the brain is empty', () => {
    expect(
      classifyIntelligenceClick({ savedMeetings: 3, unextracted: 3, queued: 2, preparing: false })
    ).toBe('working')
    expect(
      classifyIntelligenceClick({ savedMeetings: 3, unextracted: 3, queued: 0, preparing: true })
    ).toBe('working')
    expect(
      classifyIntelligenceClick({ savedMeetings: 3, unextracted: 3, queued: 0, upToDate: true })
    ).toBe('illegal-empty')
    expect(
      classifyIntelligenceClick({ savedMeetings: 3, unextracted: 3, queued: 0 })
    ).toBe('illegal-empty')
  })

  it('surfaces the no-provider copy and allows a true upToDate when everything is extracted', () => {
    expect(
      classifyIntelligenceClick({
        savedMeetings: 2,
        unextracted: 2,
        queued: 0,
        deferred: 'no-provider',
        error: NO_PROVIDER_INDEX_COPY
      })
    ).toBe('error')
    expect(
      classifyIntelligenceClick({ savedMeetings: 2, unextracted: 2, queued: 0, deferred: 'no-provider' })
    ).toBe('no-provider')
    expect(NO_PROVIDER_INDEX_COPY).toMatch(/Connect an AI provider/)
    expect(NO_PROVIDER_INDEX_COPY).not.toMatch(/—/)
    expect(
      classifyIntelligenceClick({ savedMeetings: 4, unextracted: 0, queued: 0, upToDate: true })
    ).toBe('upToDate')
  })
})

describe('runIntelligenceIndex coalesce and catch-up', () => {
  it('coalesces a second pass while one is running', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'intel-idx-'))
    const s = { ...DEFAULT_SETTINGS, meetingsFolder: folder, encryptTranscripts: false }
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      setIntelligenceIndexWork(async () => {
        resolve()
        await new Promise<void>((r) => {
          release = r
        })
        return { ran: true, queued: 1 }
      })
    })
    const first = runIntelligenceIndex('click', s)
    await started
    const second = await runIntelligenceIndex('schedule', s)
    expect(second.coalesced).toBe(true)
    expect(second.ran).toBe(false)
    release()
    const done = await first
    expect(done.ran).toBe(true)
    expect(done.queued).toBe(1)
  })

  it('catch-up runs once when last success is before the elapsed slot', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'intel-idx-'))
    const s = { ...DEFAULT_SETTINGS, meetingsFolder: folder, encryptTranscripts: false }
    await writeIntelligenceIndexState({ lastSuccessAt: torontoMs(2026, 8, 31, 6, 0) }, s)
    setIntelligenceIndexWork(async () => ({ ran: true, queued: 3 }))
    const r = await catchUpIntelligenceIndexIfNeeded(torontoMs(2026, 8, 31, 13, 0), s)
    expect(r.ran).toBe(true)
    expect('queued' in r && r.queued).toBe(3)
  })

  it('catch-up no-ops when last success is at or after the elapsed slot', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'intel-idx-'))
    const s = { ...DEFAULT_SETTINGS, meetingsFolder: folder, encryptTranscripts: false }
    await writeIntelligenceIndexState({ lastSuccessAt: torontoMs(2026, 8, 31, 12, 0) }, s)
    let calls = 0
    setIntelligenceIndexWork(async () => {
      calls += 1
      return { ran: true, queued: 1 }
    })
    const r = await catchUpIntelligenceIndexIfNeeded(torontoMs(2026, 8, 31, 13, 0), s)
    expect(r).toEqual({ ran: false, queued: 0, reason: 'current' })
    expect(calls).toBe(0)
  })
})
