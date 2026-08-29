/**
 * consolidate.ts — Wave 3: batch the brain's LLM extraction into a bounded number of passes/day
 * (settings.brainConsolidation, default 2, docs/qa/QUALITY-SCORECARD.md's "Brain LLM consolidations /
 * active day ≤ 2") instead of a network round trip after every single saved meeting.
 *
 * This module owns exactly two things: counting today's passes (durably, so a quit/restart doesn't
 * reset the budget) and deciding whether another pass is due right now. The actual extraction work is
 * unchanged — `runConsolidationIfDue` reuses `startBackfill` (ingest.ts), the same "queue every
 * not-yet-ingested transcript" scan the "Index meetings" button and boot resume already use, so a
 * consolidation pass and a manual rebuild can never disagree about what counts as pending work.
 */
import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import { getSettings } from '../store'
import { readJson, writeJson } from './store'
import { startBackfill, type BackfillStartResult } from './ingest'
import { auditLog, mainLog } from '../logger'

const STATE_FILE = 'consolidate-state.json'

// Same "unknown shape degrades to null, never throws into a routing decision" contract as every other
// readJson caller in this file (store.ts's readIndex/readGraph) — a corrupt or hand-edited state file
// must fail closed (treated as absent, see readState below) rather than crash the timer.
const ConsolidateStateSchema = z.object({
  /** Local calendar day the counters below apply to, 'YYYY-MM-DD'. A day change resets the budget. */
  date: z.string(),
  passes: z.number().int().nonnegative(),
  lastRunAt: z.number().nonnegative()
})
type ConsolidateState = z.infer<typeof ConsolidateStateSchema>

function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function emptyState(now: number): ConsolidateState {
  return { date: todayKey(now), passes: 0, lastRunAt: 0 }
}

/** Durable per-day pass counter under `.brain/consolidate-state.json` — same read/write path (and the
 *  same at-rest encryption, when settings.encryptTranscripts is on) every other brain JSON file uses, so
 *  this state lives next to index.json rather than inventing a second storage convention. A stale
 *  `date` (yesterday's counters, or a corrupt/absent file) is never trusted — it degrades to a fresh
 *  empty state for today rather than either crashing or silently carrying over yesterday's budget. */
function readState(s: Settings, now = Date.now()): ConsolidateState {
  const v = readJson<ConsolidateState>(s, STATE_FILE, (raw) => ConsolidateStateSchema.parse(raw))
  if (!v || v.date !== todayKey(now)) return emptyState(now)
  return v
}

/** Whether `settings.brainConsolidation` currently permits another pass: the feature is on, and today's
 *  count (readState, which itself resets on a day change) hasn't reached the daily cap. Pure and
 *  synchronous on purpose — this is the gate `runConsolidationIfDue`'s hourly timer checks on every
 *  tick, and every one of those ticks must cost nothing beyond one small JSON read. */
export function canConsolidateToday(s: Settings, now = Date.now()): boolean {
  if (!s.brainConsolidation.enabled) return false
  return readState(s, now).passes < s.brainConsolidation.maxPassesPerDay
}

/** Durably record that one consolidation pass just ran, and audit-log it (metrics.ts's
 *  brainConsolidationPasses counter reads the 'brain.consolidation' event this writes). Callers decide
 *  WHEN to call this — `runConsolidationIfDue` only calls it after `startBackfill` actually found and
 *  queued something, so an hourly tick with nothing pending never spends the daily budget on a no-op. */
export async function recordConsolidationPass(s: Settings, now = Date.now()): Promise<ConsolidateState> {
  const prev = readState(s, now)
  const next: ConsolidateState = { date: todayKey(now), passes: prev.passes + 1, lastRunAt: now }
  await writeJson(s, STATE_FILE, next)
  auditLog('brain.consolidation', { passes: next.passes, maxPerDay: s.brainConsolidation.maxPassesPerDay })
  return next
}

export interface ConsolidationRunResult {
  ran: boolean
  queued: number
  /** Present when brainConsolidation.enabled is false or today's pass budget is already spent. */
  reason?: 'disabled' | 'budget-spent'
}

/**
 * The one entry point the timer below (and any manual "consolidate now" trigger) calls: if consolidation
 * is enabled and under today's cap, queue every not-yet-ingested meeting via the existing backfill scan.
 * A pass is only durably recorded when `startBackfill` actually found work — an hourly tick landing on
 * an already-fully-indexed vault must not burn the daily budget on nothing.
 */
export async function runConsolidationIfDue(s: Settings = getSettings()): Promise<ConsolidationRunResult> {
  if (!s.brainConsolidation.enabled) return { ran: false, queued: 0, reason: 'disabled' }
  if (!canConsolidateToday(s)) return { ran: false, queued: 0, reason: 'budget-spent' }
  let result: BackfillStartResult
  try {
    result = startBackfill()
  } catch (e) {
    // Never let a scan failure (a locked index file, a missing meetings folder) throw out of the timer
    // — the next hourly tick gets another try, same as every other best-effort background pass in main.
    mainLog.warn('[brain] consolidation pass could not scan for pending meetings:', e)
    return { ran: false, queued: 0 }
  }
  if (result.queued > 0) await recordConsolidationPass(s)
  return { ran: result.queued > 0, queued: result.queued }
}

/**
 * Starts the hourly check that drives twice-daily (by default) consolidation. Deliberately simple: an
 * hourly tick against a small per-day counter, not a scheduled-for-exact-noon-and-midnight cron — the
 * budget in canConsolidateToday is what actually caps the count, so checking more often than the budget
 * allows costs nothing but a JSON read that immediately says "no".
 *
 * `registerTimer` lets index.ts fold this into its own `trackTimer` shutdown-safety list (every other
 * long-lived interval in main is tracked there so will-quit can cancel them all before teardown) without
 * this module importing anything from index.ts. Defaults to a no-op passthrough for tests. Returns a
 * disposer either way.
 */
export function scheduleConsolidation(
  intervalMs = 60 * 60 * 1000,
  registerTimer: (t: ReturnType<typeof setInterval>) => ReturnType<typeof setInterval> = (t) => t
): () => void {
  const timer = registerTimer(
    setInterval(() => {
      void runConsolidationIfDue().catch((e) => mainLog.warn('[brain] consolidation tick failed:', e))
    }, intervalMs)
  )
  return () => clearInterval(timer)
}
