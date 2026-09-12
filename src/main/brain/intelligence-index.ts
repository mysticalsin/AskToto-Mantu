/**
 * Solid Intelligence index: the same work as Update Intelligence, three named slots per day.
 * Timezone is America/Toronto. 06:00, 12:00, 18:00. Catch up on launch if a slot was missed.
 * Never a 60-minute poll. Never auto-send to CRM / Outlook / MCP.
 */
import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import { intelligenceNoProviderMessage, LOCAL_ONLY_INTELLIGENCE_UNAVAILABLE } from '@shared/intelligence-pass'
import { getSettings } from '../store'
import { readJson, writeJson } from './store'
import { requestBackfillRun, type BackfillStartResult, type BackfillCompletion } from './ingest'
import { auditLog, mainLog } from '../logger'

export const INTELLIGENCE_INDEX_TZ = 'America/Toronto'
export const INTELLIGENCE_INDEX_HOURS = [6, 12, 18] as const
export const INTELLIGENCE_INDEX_STATE_FILE = 'intelligence-index.json'

const StateSchema = z.object({
  lastSuccessAt: z.number().nonnegative(),
  lastError: z.string().optional()
})
export type IntelligenceIndexState = z.infer<typeof StateSchema>

export type IntelligenceIndexReason = 'click' | 'schedule' | 'catch-up' | 'import-idle'

export const NO_PROVIDER_INDEX_COPY =
  'Connect an AI provider in Settings → AI, or enable Métis Local there to index meetings on this device.'

export const SIGN_IN_INDEX_COPY = 'Sign in with your Mantu account first.'

/** Click contract: unextracted meetings or an empty Today/coaching/relationships dashboard
 *  with saved meetings must queue work or preparing, never a silent upToDate. */
export function classifyIntelligenceClick(input: {
  savedMeetings: number
  unextracted?: number
  /** True when people + accounts + deals (Today / coaching / relationships inputs) are all empty. */
  emptyDashboard?: boolean
  queued: number
  preparing?: boolean
  deferred?: string
  upToDate?: boolean
  error?: string
}): 'working' | 'no-provider' | 'upToDate' | 'error' | 'illegal-empty' {
  if (input.error) return 'error'
  if (input.deferred === 'no-provider') return 'no-provider'
  if (input.queued > 0 || input.preparing) return 'working'
  const unextracted = input.unextracted ?? 0
  const emptyBrain = unextracted > 0 || (input.savedMeetings > 0 && input.emptyDashboard === true)
  if (emptyBrain && (input.upToDate || input.queued === 0)) return 'illegal-empty'
  return 'upToDate'
}

export interface IntelligenceIndexResult extends BackfillStartResult {
  ran: boolean
  coalesced?: boolean
  recapped?: number
  lastIndexedAt?: number
  upToDate?: boolean
  error?: string
}

/** Internal only: completion is deliberately separate from the serializable IPC result. */
export interface IntelligenceIndexCompletion {
  ok: boolean
  recapped?: number
  /** Safe, user-facing retry guidance, not provider payloads or filesystem errors. */
  error?: string
}

export interface IntelligenceIndexRun {
  result: IntelligenceIndexResult
  completion: Promise<IntelligenceIndexCompletion>
}

export const INCOMPLETE_INDEX_COPY = 'Intelligence could not finish updating. Retry Update Intelligence; your saved meetings are unchanged.'
export const SUMMARY_INDEX_RETRY_COPY = 'Some meeting summaries could not finish. Retry Update Intelligence or retry the summary from its meeting.'

export function backfillCompletionError(outcome: BackfillCompletion, s?: Settings): string | undefined {
  if (outcome.ok) return undefined
  return outcome.error === 'no-provider'
    ? s ? intelligenceNoProviderMessage(s, NO_PROVIDER_INDEX_COPY) : NO_PROVIDER_INDEX_COPY
    : INCOMPLETE_INDEX_COPY
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** Wall-clock parts of `ms` in `timeZone`. hour 24 from Intl is normalized to 0. */
export function zonedParts(ms: number, timeZone = INTELLIGENCE_INDEX_TZ): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const bag: Record<string, string> = {}
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') bag[part.type] = part.value
  }
  let hour = Number(bag.hour)
  if (hour === 24) hour = 0
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second)
  }
}

/** UTC offset of `timeZone` at instant `ms` (ms = zoned_as_UTC - actual_UTC). */
export function timeZoneOffsetMs(ms: number, timeZone = INTELLIGENCE_INDEX_TZ): number {
  const z = zonedParts(ms, timeZone)
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second)
  return asUtc - ms
}

/**
 * UTC millis for a civil clock time in `timeZone`. DST-safe: apply the offset at a nearby instant
 * and correct once if the zone offset flipped.
 */
export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  timeZone = INTELLIGENCE_INDEX_TZ
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const first = guess - timeZoneOffsetMs(guess, timeZone)
  return guess - timeZoneOffsetMs(first, timeZone)
}

function addCalendarDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + delta))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function slotUtcOnDay(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone = INTELLIGENCE_INDEX_TZ
): number {
  return zonedDateTimeToUtc(year, month, day, hour, 0, timeZone)
}

/** Most recently elapsed 06:00 / 12:00 / 18:00 in America/Toronto at or before `now`. */
export function mostRecentlyElapsedSlot(now: number, timeZone = INTELLIGENCE_INDEX_TZ): number {
  const z = zonedParts(now, timeZone)
  for (let i = INTELLIGENCE_INDEX_HOURS.length - 1; i >= 0; i--) {
    const hour = INTELLIGENCE_INDEX_HOURS[i]
    const at = slotUtcOnDay(z.year, z.month, z.day, hour, timeZone)
    if (at <= now) return at
  }
  const prev = addCalendarDays(z.year, z.month, z.day, -1)
  return slotUtcOnDay(prev.year, prev.month, prev.day, INTELLIGENCE_INDEX_HOURS[INTELLIGENCE_INDEX_HOURS.length - 1], timeZone)
}

/** Next 06:00 / 12:00 / 18:00 in America/Toronto strictly after `now`. */
export function nextSlotAt(now: number, timeZone = INTELLIGENCE_INDEX_TZ): number {
  const z = zonedParts(now, timeZone)
  for (const hour of INTELLIGENCE_INDEX_HOURS) {
    const at = slotUtcOnDay(z.year, z.month, z.day, hour, timeZone)
    if (at > now) return at
  }
  const next = addCalendarDays(z.year, z.month, z.day, 1)
  return slotUtcOnDay(next.year, next.month, next.day, INTELLIGENCE_INDEX_HOURS[0], timeZone)
}

/** Catch up when the app was closed across a named slot. */
export function shouldCatchUp(lastSuccessAt: number | null | undefined, now: number, timeZone = INTELLIGENCE_INDEX_TZ): boolean {
  const last = lastSuccessAt && lastSuccessAt > 0 ? lastSuccessAt : 0
  return last < mostRecentlyElapsedSlot(now, timeZone)
}

export function readIntelligenceIndexState(s: Settings = getSettings()): IntelligenceIndexState {
  const v = readJson<IntelligenceIndexState>(s, INTELLIGENCE_INDEX_STATE_FILE, (raw) => StateSchema.parse(raw))
  return v ?? { lastSuccessAt: 0 }
}

export async function writeIntelligenceIndexState(
  next: IntelligenceIndexState,
  s: Settings = getSettings()
): Promise<void> {
  await writeJson(s, INTELLIGENCE_INDEX_STATE_FILE, next)
}

export function lastIndexedAt(s: Settings = getSettings()): number | undefined {
  const at = readIntelligenceIndexState(s).lastSuccessAt
  return at > 0 ? at : undefined
}

let activeRun: object | null = null
let volatileError: { folder: string; message: string } | null = null
let indexWork: ((reason: IntelligenceIndexReason) => IntelligenceIndexRun | Promise<IntelligenceIndexRun>) | null = null

/** Test-only: clear the in-flight lock between suites. */
export function resetIntelligenceIndexLockForTests(): void {
  activeRun = null
  volatileError = null
}

export function intelligenceIndexStatus(s: Settings = getSettings()): { running: boolean; lastError?: string } {
  const savedError = readIntelligenceIndexState(s).lastError
  const safeSavedError = !savedError || [NO_PROVIDER_INDEX_COPY, LOCAL_ONLY_INTELLIGENCE_UNAVAILABLE, INCOMPLETE_INDEX_COPY, SUMMARY_INDEX_RETRY_COPY].includes(savedError)
    ? savedError
    : INCOMPLETE_INDEX_COPY
  const error = volatileError?.folder === s.meetingsFolder
    ? volatileError.message
    : safeSavedError
  return { running: activeRun !== null, ...(!activeRun && error ? { lastError: error } : {}) }
}

/**
 * The solid pass (recap missing summaries + extract unextracted meetings) is injected so this
 * module stays unit-testable without booting Electron or the LLM stack.
 */
export function setIntelligenceIndexWork(
  fn: ((reason: IntelligenceIndexReason) => IntelligenceIndexRun | Promise<IntelligenceIndexRun>) | null
): void {
  indexWork = fn
}

export async function runIntelligenceIndex(
  reason: IntelligenceIndexReason,
  s: Settings = getSettings()
): Promise<IntelligenceIndexResult> {
  if (activeRun) {
    mainLog.info(`[intelligence-index] coalesced (${reason}); a pass is already running`)
    return { ran: false, queued: 0, coalesced: true, lastIndexedAt: lastIndexedAt(s) }
  }
  const token = {}
  activeRun = token
  volatileError = null
  const recordFailure = async (message: string): Promise<void> => {
    volatileError = { folder: s.meetingsFolder, message }
    try {
      await writeIntelligenceIndexState({
        lastSuccessAt: readIntelligenceIndexState(s).lastSuccessAt,
        lastError: message
      }, s)
    } catch (error) {
      mainLog.error('[intelligence-index] could not persist failure state:', error)
    }
  }
  try {
    const run: IntelligenceIndexRun = indexWork ? await indexWork(reason) : (() => {
      const backfill = requestBackfillRun({ force: true })
      return {
        result: { ...backfill.result, ran: !backfill.result.deferred },
        completion: backfill.completion.then((outcome) => ({ ok: outcome.ok, error: backfillCompletionError(outcome, s) }))
      }
    })()
    const result = {
      ...run.result,
      ...(run.result.deferred === 'no-provider' ? { error: intelligenceNoProviderMessage(s, NO_PROVIDER_INDEX_COPY) } : {}),
      lastIndexedAt: lastIndexedAt(s)
    }
    // Attach the terminal handler before returning to IPC. The lock stays owned until every stage
    // has finished AND its success/failure state has been saved, even if the caller closes its window.
    void (async () => {
      try {
        const outcome = await run.completion
        if (activeRun !== token) return
        const error = result.error || (!outcome.ok ? outcome.error || INCOMPLETE_INDEX_COPY : undefined)
        if (error) {
          await recordFailure(error)
          return
        }
        await writeIntelligenceIndexState({ lastSuccessAt: Date.now() }, s)
        auditLog('brain.intelligence_index', { reason, queued: result.queued, recapped: outcome.recapped ?? 0 })
        mainLog.info(`[intelligence-index] ${reason} completed; recapped ${outcome.recapped ?? 0}`)
      } catch (error) {
        mainLog.error(`[intelligence-index] ${reason} completion failed:`, error)
        if (activeRun === token) await recordFailure(INCOMPLETE_INDEX_COPY)
      } finally {
        if (activeRun === token) activeRun = null
      }
    })()
    return result
  } catch (error) {
    mainLog.error(`[intelligence-index] ${reason} dispatch failed:`, error)
    await recordFailure(INCOMPLETE_INDEX_COPY)
    if (activeRun === token) activeRun = null
    return { ran: false, queued: 0, error: INCOMPLETE_INDEX_COPY, lastIndexedAt: lastIndexedAt(s) }
  }
}

export function scheduleIntelligenceIndex(
  registerTimer: (t: ReturnType<typeof setTimeout>) => ReturnType<typeof setTimeout> = (t) => t,
  now = Date.now()
): () => void {
  let cancelled = false
  let handle: ReturnType<typeof setTimeout> | null = null

  const arm = (from: number): void => {
    if (cancelled) return
    const next = nextSlotAt(from)
    const wait = Math.max(250, next - from)
    handle = registerTimer(
      setTimeout(() => {
        if (cancelled) return
        void runIntelligenceIndex('schedule')
          .catch((e) => mainLog.error('[intelligence-index] scheduled pass failed:', e))
          .finally(() => arm(Date.now()))
      }, wait)
    )
  }

  arm(now)
  return () => {
    cancelled = true
    if (handle) clearTimeout(handle)
  }
}

export async function catchUpIntelligenceIndexIfNeeded(
  now = Date.now(),
  s: Settings = getSettings()
): Promise<IntelligenceIndexResult | { ran: false; queued: 0; reason: 'current' }> {
  const last = readIntelligenceIndexState(s).lastSuccessAt
  if (!shouldCatchUp(last, now)) return { ran: false, queued: 0, reason: 'current' }
  mainLog.info(
    `[intelligence-index] catch-up: last success ${last || 0} is before slot ${mostRecentlyElapsedSlot(now)}`
  )
  return runIntelligenceIndex('catch-up', s)
}
