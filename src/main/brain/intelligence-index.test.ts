import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import * as brainStore from './store'
import {
  INTELLIGENCE_INDEX_HOURS,
  INTELLIGENCE_INDEX_TZ,
  NO_PROVIDER_INDEX_COPY,
  SIGN_IN_INDEX_COPY,
  catchUpIntelligenceIndexIfNeeded,
  classifyIntelligenceClick,
  mostRecentlyElapsedSlot,
  nextSlotAt,
  scheduleIntelligenceIndex,
  resetIntelligenceIndexLockForTests,
  readIntelligenceIndexState,
  intelligenceIndexStatus,
  runIntelligenceIndex,
  setIntelligenceIndexWork,
  shouldCatchUp,
  writeIntelligenceIndexState,
  zonedDateTimeToUtc,
  zonedParts,
  type IntelligenceIndexResult,
  type IntelligenceIndexCompletion
} from './intelligence-index'

function completedRun(result: IntelligenceIndexResult) {
  return { result, completion: Promise.resolve({ ok: !result.error && !result.deferred }) }
}

function completionGate() {
  let resolve!: (result: IntelligenceIndexCompletion) => void
  let reject!: (error: Error) => void
  const promise = new Promise<IntelligenceIndexCompletion>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
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

  it('stays correct across the 2026 DST spring-forward and fall-back', () => {
    // 2026-03-08 02:00 America/Toronto springs forward to 03:00. 06:00 that morning is EDT.
    expect(zonedParts(torontoMs(2026, 3, 8, 6, 0)).hour).toBe(6)
    expect(nextSlotAt(torontoMs(2026, 3, 8, 5, 0))).toBe(torontoMs(2026, 3, 8, 6, 0))
    expect(nextSlotAt(torontoMs(2026, 3, 8, 6, 0))).toBe(torontoMs(2026, 3, 8, 12, 0))
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 3, 8, 5, 30))).toBe(torontoMs(2026, 3, 7, 18, 0))
    // 2026-11-01 02:00 falls back to 01:00. 18:00 that day is EST.
    expect(zonedParts(torontoMs(2026, 11, 1, 18, 0)).hour).toBe(18)
    expect(nextSlotAt(torontoMs(2026, 11, 1, 18, 0))).toBe(torontoMs(2026, 11, 2, 6, 0))
    expect(mostRecentlyElapsedSlot(torontoMs(2026, 11, 1, 12, 0))).toBe(torontoMs(2026, 11, 1, 12, 0))
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
    expect(SIGN_IN_INDEX_COPY).toBe('Sign in with your Mantu account first.')
  })

  it('treats an empty Today/coaching/relationships dashboard with saved meetings as illegal-empty', () => {
    expect(
      classifyIntelligenceClick({
        savedMeetings: 5,
        unextracted: 0,
        emptyDashboard: true,
        queued: 0,
        upToDate: true
      })
    ).toBe('illegal-empty')
    expect(
      classifyIntelligenceClick({
        savedMeetings: 5,
        unextracted: 0,
        emptyDashboard: true,
        queued: 0
      })
    ).toBe('illegal-empty')
    expect(
      classifyIntelligenceClick({
        savedMeetings: 5,
        unextracted: 0,
        emptyDashboard: true,
        queued: 0,
        preparing: true
      })
    ).toBe('working')
  })
})

describe('click with meetings and an empty brain queues work', () => {
  it('injected click work returns queued or preparing, never upToDate', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'intel-idx-'))
    const s = { ...DEFAULT_SETTINGS, meetingsFolder: folder, encryptTranscripts: false }
    setIntelligenceIndexWork(async () => {
      const verdict = classifyIntelligenceClick({
        savedMeetings: 3,
        unextracted: 3,
        emptyDashboard: true,
        queued: 0,
        upToDate: true
      })
      expect(verdict).toBe('illegal-empty')
      return completedRun({ ran: true, queued: 3, preparing: true, upToDate: false })
    })
    const r = await runIntelligenceIndex('click', s)
    expect(r.upToDate).not.toBe(true)
    expect(r.queued > 0 || r.preparing).toBe(true)
  })

  it('click with no provider surfaces the no-provider copy', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'intel-idx-'))
    const s = { ...DEFAULT_SETTINGS, meetingsFolder: folder, encryptTranscripts: false }
    setIntelligenceIndexWork(async () => completedRun({
      ran: false,
      queued: 0,
      deferred: 'no-provider',
      error: NO_PROVIDER_INDEX_COPY
    }))
    const r = await runIntelligenceIndex('click', s)
    expect(r.error).toBe(NO_PROVIDER_INDEX_COPY)
    expect(r.deferred).toBe('no-provider')
  })

  it('a local-only policy failure explains Local readiness instead of suggesting an API key', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'intel-idx-'))
    const s = { ...DEFAULT_SETTINGS, meetingsFolder: folder, encryptTranscripts: false, routingMode: 'local' as const }
    setIntelligenceIndexWork(async () => completedRun({ ran: false, queued: 0, deferred: 'no-provider' }))
    const result = await runIntelligenceIndex('click', s)
    expect(result.error).toMatch(/local.only.*not ready/i)
    await vi.waitFor(() => expect(intelligenceIndexStatus(s).running).toBe(false))
    resetIntelligenceIndexLockForTests()
    expect(intelligenceIndexStatus(s).lastError).toBe(result.error)
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
        return completedRun({ ran: true, queued: 1 })
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
    setIntelligenceIndexWork(async () => completedRun({ ran: true, queued: 3 }))
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
      return completedRun({ ran: true, queued: 1 })
    })
    const r = await catchUpIntelligenceIndexIfNeeded(torontoMs(2026, 8, 31, 13, 0), s)
    expect(r).toEqual({ ran: false, queued: 0, reason: 'current' })
    expect(calls).toBe(0)
  })
})

describe('Intelligence completion, not dispatch, owns success', () => {
  async function settings() {
    const s = { ...DEFAULT_SETTINGS, meetingsFolder: mkdtempSync(join(tmpdir(), 'intel-completion-')), encryptTranscripts: false }
    await writeIntelligenceIndexState({ lastSuccessAt: 123 }, s)
    return s
  }

  it('returns preparation promptly, coalesces until completion, and never sends the promise over IPC', async () => {
    const s = await settings()
    const gate = completionGate()
    const work = vi.fn(async () => ({ result: { ran: true, queued: 0, preparing: true }, completion: gate.promise }))
    setIntelligenceIndexWork(work)
    const first = await runIntelligenceIndex('click', s)
    expect(first).toEqual({ ran: true, queued: 0, preparing: true, lastIndexedAt: 123 })
    expect(structuredClone(first)).toEqual(first)
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBe(123)
    expect(intelligenceIndexStatus(s).running).toBe(true)
    expect((await runIntelligenceIndex('import-idle', s)).coalesced).toBe(true)
    expect(work).toHaveBeenCalledTimes(1)
    gate.resolve({ ok: true, recapped: 2 })
    await vi.waitFor(() => expect(intelligenceIndexStatus(s).running).toBe(false))
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBeGreaterThan(123)
    expect(readIntelligenceIndexState(s).lastError).toBeUndefined()
  })

  it.each(['extraction', 'merge', 'publication', 'recap'])('keeps the prior success on a %s failure', async (stage) => {
    const s = await settings()
    const gate = completionGate()
    setIntelligenceIndexWork(async () => ({ result: { ran: true, queued: 1 }, completion: gate.promise }))
    await runIntelligenceIndex('click', s)
    gate.resolve({ ok: false, error: `${stage} could not finish. Retry Update Intelligence.` })
    await vi.waitFor(() => expect(intelligenceIndexStatus(s).running).toBe(false))
    expect(readIntelligenceIndexState(s)).toEqual({ lastSuccessAt: 123, lastError: `${stage} could not finish. Retry Update Intelligence.` })
  })

  it('does not promote a deferred dispatch even if its local subset completes', async () => {
    const s = await settings()
    setIntelligenceIndexWork(async () => ({
      result: { ran: false, queued: 1, deferred: 'no-provider' },
      completion: Promise.resolve({ ok: true })
    }))
    const result = await runIntelligenceIndex('click', s)
    expect(result.error).toBe(NO_PROVIDER_INDEX_COPY)
    await vi.waitFor(() => expect(intelligenceIndexStatus(s).running).toBe(false))
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBe(123)
    expect(intelligenceIndexStatus(s).lastError).toBe(NO_PROVIDER_INDEX_COPY)
  })

  it('consumes rejected completion and exposes safe retry copy instead of internal details', async () => {
    const s = await settings()
    const gate = completionGate()
    setIntelligenceIndexWork(async () => ({ result: { ran: true, queued: 1 }, completion: gate.promise }))
    await runIntelligenceIndex('click', s)
    gate.reject(new Error('/private/test-profile/api-key-secret could not be read'))
    await vi.waitFor(() => expect(intelligenceIndexStatus(s).running).toBe(false))
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBe(123)
    expect(intelligenceIndexStatus(s).lastError).toMatch(/could not finish.*Retry/i)
    expect(intelligenceIndexStatus(s).lastError).not.toMatch(/private|secret/)
  })

  it('does not render raw diagnostic errors persisted by older app versions', async () => {
    const s = await settings()
    await writeIntelligenceIndexState({ lastSuccessAt: 123, lastError: '/private/legacy-profile api-key=synthetic-secret' }, s)
    expect(intelligenceIndexStatus(s).lastError).toMatch(/could not finish.*Retry/i)
    expect(intelligenceIndexStatus(s).lastError).not.toMatch(/legacy-profile|synthetic-secret/)
  })

  it('does not let an obsolete completion change a replacement run or its timestamp', async () => {
    const s = await settings()
    const old = completionGate()
    const replacement = completionGate()
    setIntelligenceIndexWork(async () => ({ result: { ran: true, queued: 1 }, completion: old.promise }))
    await runIntelligenceIndex('click', s)
    resetIntelligenceIndexLockForTests()
    setIntelligenceIndexWork(async () => ({ result: { ran: true, queued: 2 }, completion: replacement.promise }))
    await runIntelligenceIndex('click', s)
    old.resolve({ ok: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(intelligenceIndexStatus(s).running).toBe(true)
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBe(123)
    replacement.resolve({ ok: false, error: 'Retry the incomplete pass.' })
    await vi.waitFor(() => expect(intelligenceIndexStatus(s).running).toBe(false))
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBe(123)
  })

  it('keeps the single-flight lock until the successful timestamp is durably written', async () => {
    const s = await settings()
    const outcome = completionGate()
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const originalWrite = brainStore.writeJson
    let writing = false
    vi.spyOn(brainStore, 'writeJson').mockImplementation(async (...args) => {
      writing = true
      await writeGate
      return originalWrite(...args)
    })
    const work = vi.fn(async () => ({ result: { ran: true, queued: 1 }, completion: outcome.promise }))
    setIntelligenceIndexWork(work)
    await runIntelligenceIndex('click', s)
    outcome.resolve({ ok: true })
    await vi.waitFor(() => expect(writing).toBe(true))
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBe(123)
    expect((await runIntelligenceIndex('schedule', s)).coalesced).toBe(true)
    expect(work).toHaveBeenCalledTimes(1)
    releaseWrite()
    await vi.waitFor(() => expect(intelligenceIndexStatus(s).running).toBe(false))
    expect(readIntelligenceIndexState(s).lastSuccessAt).toBeGreaterThan(123)
  })
})

describe('scheduleIntelligenceIndex', () => {
  it('arms a timeout to the next 06/12/18 America/Toronto slot, not a 60-minute poll', () => {
    const now = torontoMs(2026, 8, 31, 13, 0)
    const expected = Math.max(250, nextSlotAt(now) - now)
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const handles: ReturnType<typeof setTimeout>[] = []
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(Number(ms) || 0)
      const handle = realSetTimeout(() => {}, 60_000)
      handles.push(handle)
      return handle
    }) as typeof setTimeout
    try {
      const cancel = scheduleIntelligenceIndex((t) => t, now)
      cancel()
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      for (const h of handles) realClearTimeout(h)
    }
    expect(delays[0]).toBe(expected)
    expect(delays[0]).toBeGreaterThan(60 * 60 * 1000)
    expect(delays[0]).toBeLessThan(6 * 60 * 60 * 1000)
  })
})
