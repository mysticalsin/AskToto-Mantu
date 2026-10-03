import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RevealOutcome } from './reveal-trace'
import { REVEAL_OUTCOMES, SIDECAR_REAP_REASONS } from './projection'

export interface DiagnosticsIdentity {
  version: string
  platform: string
  arch: string
}

type SidecarReapReason = (typeof SIDECAR_REAP_REASONS)[number]

interface Counts {
  records: number
  boots: { started: number; prevShutdown: Record<'clean' | 'unclean' | 'unknown', number> }
  stalls: { under2s: number; '2to5s': number; '5to30s': number; '30sPlus': number }
  crashes: { fatal: number; nonFatal: number; unclassified: number }
  reveals: Record<RevealOutcome, number>
  events: Record<string, number>
}

type HistoryOutcome = 'ok' | 'failed' | 'discarded'
type HistoryMetric = 'queueMs' | 'mainMs' | 'ipcMs' | 'renderMs' | 'totalMs'
type HistorySummaryStatus = 'empty' | 'present'

export interface HistoryTimingStats {
  count: number
  p50: number | null
  p95: number | null
  max: number | null
}

export interface HistoryTimingSummary {
  queueMs: HistoryTimingStats
  mainMs: HistoryTimingStats
  ipcMs: HistoryTimingStats
  renderMs: HistoryTimingStats
  totalMs: HistoryTimingStats
}

export interface HistoryRequestAggregate {
  status: HistorySummaryStatus
  requests: number
  served: number
  outcomes: Record<HistoryOutcome, number>
  timings: HistoryTimingSummary
}

export interface HistoryRequestSummary extends HistoryRequestAggregate {
  notDownloaded: HistoryRequestAggregate
  unsettledServed: { count: number; share: number | null }
}

/** One UTC day of in-scope activity; the soak counts are the same measures as `SoakCounts`. */
export interface DayBucket {
  records: number
  boots: number
  uncleanShutdowns: number
  stallsOver5s: number
  orphanReaps: number
  revealNoOps: number
  brainIndexQuarantined: number
  history: HistoryRequestSummary
}

/** The five M2-0198 soak measures, counted over the version scope. */
export interface SoakCounts {
  /** app.stall records whose durationMs is strictly greater than 5000. */
  stallsOver5s: number
  /** app.started records whose prevShutdown is 'unclean'. */
  uncleanShutdowns: number
  /** sidecar.reaped by reason, and how many of them belong to a boot whose prevShutdown was unclean. */
  orphanReaps: Record<SidecarReapReason, number> & { afterUncleanExit: number }
  /** reveal records whose outcome is a no-op under REVEAL_IS_NO_OP. */
  revealNoOps: number
  brainIndexQuarantined: number
}

export interface DiagnosticsSummary {
  kind: 'metis-diagnostics-summary'
  schema: 2
  generatedAt: string
  app: DiagnosticsIdentity
  /** Everything read, across every audit generation; the counts beside it keep their schema 1 meaning. */
  window: { from: string | null; to: string | null; records: number; generations: number; truncated: boolean }
  boots: Counts['boots']
  stalls: Counts['stalls']
  crashes: Counts['crashes']
  reveals: Counts['reveals']
  events: Counts['events']
  /** Records from the first app.started of the running version onward; a version change starts a new scope. */
  scope: Counts & {
    version: string
    from: string | null
    to: string | null
    /** Inclusive UTC days between the first and last in-scope day; days with no record are absent from `days`. */
    daySpan: number
    idleDays: number
    days: Record<string, DayBucket>
    soak: SoakCounts
    history: HistoryRequestSummary
  }
}

/**
 * Pre-registered reveal no-op definition for the M2-0198 soak: a reveal is a no-op when the user asked for
 * the overlay and its visibility did not change — it was already visible, or it stayed hidden or
 * unavailable ('failed'). Typed over every RevealOutcome, so a new outcome must be classified here.
 */
export const REVEAL_IS_NO_OP: Readonly<Record<RevealOutcome, boolean>> = {
  created: false,
  shown: false,
  'already-visible': true,
  failed: true
}

/** Read bounds for the tray action: per generation (its newest bytes) and for the whole trail (newest first). */
export interface AuditReadBudget {
  generationBytes: number
  trailBytes: number
}

const DEFAULT_BUDGET: AuditReadBudget = { generationBytes: 8 * 1024 * 1024, trailBytes: 32 * 1024 * 1024 }
/** The logger keeps AUDIT_ARCHIVE_GENERATIONS (20) rotated generations beside the live file. */
const MAX_GENERATIONS = 21
const ARCHIVE_RE = /^audit-(\d+)\.log$/
const YIELD_EVERY_LINES = 2000

export function summarizeAuditTrail(
  lines: readonly string[],
  identity: DiagnosticsIdentity,
  generatedAt: Date
): DiagnosticsSummary {
  const summarizer = createSummarizer(identity, generatedAt)
  for (const line of lines) summarizer.add(line)
  return summarizer.finish(1, false)
}

/**
 * Summarize the live audit trail and its rotated `audit-<stamp>.log` generations, oldest first. Reads are
 * async, sequential and bounded by `budget`; a generation clipped to its newest bytes drops its partial
 * first line, and a torn last line (a write in flight) is skipped like any malformed line.
 */
export async function summarizeAuditGenerations(
  auditTrailPath: string,
  identity: DiagnosticsIdentity,
  generatedAt: Date,
  budget: AuditReadBudget = DEFAULT_BUDGET
): Promise<DiagnosticsSummary> {
  const dir = dirname(auditTrailPath)
  const archives = (await readdir(dir).catch(() => [] as string[]))
    .map((name) => ({ name, stamp: ARCHIVE_RE.exec(name)?.[1] }))
    .filter((f): f is { name: string; stamp: string } => f.stamp !== undefined)
    .sort((a, b) => Number(a.stamp) - Number(b.stamp) || (a.name < b.name ? -1 : 1))
    .map((f) => join(dir, f.name))
  const files = [...archives, join(dir, basename(auditTrailPath))].slice(-MAX_GENERATIONS)

  const summarizer = createSummarizer(identity, generatedAt)
  let remaining = budget.trailBytes
  let truncated = files.length < archives.length + 1
  const tails: Array<{ path: string; bytes: number }> = []
  for (const path of [...files].reverse()) {
    const size = await stat(path).then((s) => s.size, () => null)
    if (size === null) continue
    if (remaining <= 0) {
      truncated = true
      break
    }
    // The cap, not the stat size, bounds the read: the live file may grow before it is read.
    const bytes = Math.min(budget.generationBytes, remaining)
    tails.unshift({ path, bytes })
    remaining -= Math.min(size, bytes)
  }

  let generations = 0
  for (const { path, bytes } of tails) {
    const tail = await readTail(path, bytes)
    if (!tail) continue
    generations += 1
    if (tail.clipped) truncated = true
    const lines = tail.text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      summarizer.add(lines[i])
      if ((i + 1) % YIELD_EVERY_LINES === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return summarizer.finish(generations, truncated)
}

/** Never rejects: an unreadable or missing trail yields a zero summary, which is still copied. */
export async function copyDiagnosticsSummary(opts: {
  auditTrailPath: string
  identity: DiagnosticsIdentity
  writeText: (text: string) => void
  now?: () => Date
  budget?: AuditReadBudget
}): Promise<void> {
  const generatedAt = (opts.now ?? (() => new Date()))()
  let summary: DiagnosticsSummary
  try {
    summary = await summarizeAuditGenerations(opts.auditTrailPath, opts.identity, generatedAt, opts.budget)
  } catch {
    summary = summarizeAuditTrail([], opts.identity, generatedAt)
  }
  try {
    opts.writeText(JSON.stringify(summary, null, 2))
  } catch {
    // Last-resort tray action: keep the documented never-rejects contract even if clipboard writes fail.
  }
}

const EVENT_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,4}$/
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const DAY_MS = 24 * 60 * 60 * 1000

/** Reads at most `maxBytes` from the end of `path`; null when the file cannot be read. */
async function readTail(path: string, maxBytes: number): Promise<{ text: string; clipped: boolean } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, size - length + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const text = buffer.subarray(0, offset).toString('utf8')
    if (size <= length) return { text, clipped: false }
    const newline = text.indexOf('\n')
    return { text: newline < 0 ? '' : text.slice(newline + 1), clipped: true }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

type AuditRecord = Record<string, unknown> & { event: string }

interface Scope {
  counts: Counts
  from: string | null
  to: string | null
  days: Map<string, DayBucket>
  soak: SoakCounts
  history: HistoryCollector
}

interface HistoryCollector {
  requests: Map<string, HistoryRequest>
  days: Map<string, Set<string>>
}

interface HistoryRequest {
  day: string | null
  received: boolean
  served: boolean
  settled: boolean
  outcome: HistoryOutcome | null
  notDownloaded: boolean
  queueMs: number | null
  mainMs: number | null
  ipcMs: number | null
  renderMs: number | null
}

/**
 * Single pass, constant memory beyond the counts. Invariant: the boot reaper runs before its boot's
 * app.started is audited, so sidecar.reaped records are held as pending and attributed to the boot the
 * next app.started opens (including whether that boot's prevShutdown was unclean).
 */
function createSummarizer(identity: DiagnosticsIdentity, generatedAt: Date) {
  const whole = zeroCounts()
  const window = { from: null as string | null, to: null as string | null }
  let scope: Scope | null = null
  let pendingReaps: Array<{ reason: SidecarReapReason; day: string | null }> = []

  function addPendingReaps(target: Scope, uncleanBoot: boolean): void {
    for (const reap of pendingReaps) {
      target.soak.orphanReaps[reap.reason] += 1
      if (uncleanBoot) target.soak.orphanReaps.afterUncleanExit += 1
      if (reap.day) dayBucket(target, reap.day).orphanReaps += 1
    }
    pendingReaps = []
  }

  return {
    add(line: string): void {
      const record = parseRecord(line)
      if (!record) return
      const ts = typeof record.ts === 'string' && ISO_TIME_RE.test(record.ts) ? record.ts : null
      extendWindow(window, ts)
      countRecord(whole, record)

      if (record.event === 'app.started') {
        if (record.version !== identity.version) scope = null
        else if (!scope) scope = zeroScope()
        if (scope) addPendingReaps(scope, record.prevShutdown === 'unclean')
        else pendingReaps = []
      } else if (record.event === 'sidecar.reaped' && isReapReason(record.reason)) {
        // The reaper writes a handful per boot; the cap keeps a malformed trail from growing this list.
        if (pendingReaps.length < 10_000) pendingReaps.push({ reason: record.reason, day: ts ? ts.slice(0, 10) : null })
      }
      if (!scope) return

      countRecord(scope.counts, record)
      extendWindow(scope, ts)
      const day = ts ? dayBucket(scope, ts.slice(0, 10)) : null
      if (day) day.records += 1
      const soak = scope.soak
      if (record.event === 'app.started') {
        if (day) day.boots += 1
        if (record.prevShutdown === 'unclean') {
          soak.uncleanShutdowns += 1
          if (day) day.uncleanShutdowns += 1
        }
      } else if (record.event === 'app.stall') {
        if (typeof record.durationMs === 'number' && record.durationMs > 5000) {
          soak.stallsOver5s += 1
          if (day) day.stallsOver5s += 1
        }
      } else if (record.event === 'reveal') {
        if (typeof record.outcome === 'string' && isRevealOutcome(record.outcome) && REVEAL_IS_NO_OP[record.outcome]) {
          soak.revealNoOps += 1
          if (day) day.revealNoOps += 1
        }
      } else if (record.event === 'brain.index.quarantined') {
        soak.brainIndexQuarantined += 1
        if (day) day.brainIndexQuarantined += 1
      }
      if (record.event === 'history.request') recordHistoryRequest(scope.history, record, ts)
    },

    finish(generations: number, truncated: boolean): DiagnosticsSummary {
      // Reaps after the last app.started have no boot yet: counted by reason, never as after-unclean.
      if (scope) addPendingReaps(scope, false)
      const s: Scope = scope ?? zeroScope()
      const dayKeys = [...s.days.keys()].sort()
      const daySpan = dayKeys.length
        ? Math.round((Date.parse(dayKeys[dayKeys.length - 1]) - Date.parse(dayKeys[0])) / DAY_MS) + 1
        : 0
      const days = Object.create(null) as Record<string, DayBucket>
      for (const key of dayKeys) {
        const bucket = s.days.get(key) as DayBucket
        bucket.history = summarizeHistory(s.history, key)
        days[key] = bucket
      }
      return {
        kind: 'metis-diagnostics-summary',
        schema: 2,
        generatedAt: generatedAt.toISOString(),
        app: identity,
        window: { from: window.from, to: window.to, records: whole.records, generations, truncated },
        boots: whole.boots,
        stalls: whole.stalls,
        crashes: whole.crashes,
        reveals: whole.reveals,
        events: whole.events,
        scope: {
          version: identity.version,
          from: s.from,
          to: s.to,
          ...s.counts,
          daySpan,
          idleDays: daySpan - dayKeys.length,
          days,
          soak: s.soak,
          history: summarizeHistory(s.history)
        }
      }
    }
  }
}

function zeroCounts(): Counts {
  return {
    records: 0,
    boots: { started: 0, prevShutdown: { clean: 0, unclean: 0, unknown: 0 } },
    stalls: { under2s: 0, '2to5s': 0, '5to30s': 0, '30sPlus': 0 },
    crashes: { fatal: 0, nonFatal: 0, unclassified: 0 },
    reveals: { created: 0, shown: 0, 'already-visible': 0, failed: 0 },
    events: Object.create(null) as Record<string, number>
  }
}

function zeroScope(): Scope {
  return {
    counts: zeroCounts(),
    from: null,
    to: null,
    days: new Map(),
    history: { requests: new Map(), days: new Map() },
    soak: {
      stallsOver5s: 0,
      uncleanShutdowns: 0,
      orphanReaps: { registry: 0, 'legacy-orphan': 0, afterUncleanExit: 0 },
      revealNoOps: 0,
      brainIndexQuarantined: 0
    }
  }
}

function dayBucket(scope: Scope, day: string): DayBucket {
  let bucket = scope.days.get(day)
  if (!bucket) {
    bucket = {
      records: 0,
      boots: 0,
      uncleanShutdowns: 0,
      stallsOver5s: 0,
      orphanReaps: 0,
      revealNoOps: 0,
      brainIndexQuarantined: 0,
      history: zeroHistorySummary()
    }
    scope.days.set(day, bucket)
  }
  return bucket
}

function recordHistoryRequest(history: HistoryCollector, record: AuditRecord, ts: string | null): void {
  if (typeof record.requestId !== 'string') return
  const day = ts ? ts.slice(0, 10) : null
  let request = history.requests.get(record.requestId)
  if (!request) {
    request = {
      day,
      received: false,
      served: false,
      settled: false,
      outcome: null,
      notDownloaded: false,
      queueMs: null,
      mainMs: null,
      ipcMs: null,
      renderMs: null
    }
    history.requests.set(record.requestId, request)
    if (day) addHistoryDayRequest(history, day, record.requestId)
  } else if (!request.day && day) {
    request.day = day
    addHistoryDayRequest(history, day, record.requestId)
  }

  if (record.stage === 'received') {
    request.received = true
    request.queueMs = msValue(record.queueMs)
  } else if (record.stage === 'served') {
    request.served = true
    if (isHistoryOutcome(record.outcome)) request.outcome = record.outcome
    request.mainMs = msValue(record.mainMs)
    if (typeof record.notDownloadedCount === 'number' && Number.isInteger(record.notDownloadedCount) && record.notDownloadedCount > 0) {
      request.notDownloaded = true
    }
  } else if (record.stage === 'settled') {
    request.settled = true
    request.ipcMs = msValue(record.ipcMs)
    request.renderMs = msValue(record.renderMs)
  }
}

function addHistoryDayRequest(history: HistoryCollector, day: string, requestId: string): void {
  let ids = history.days.get(day)
  if (!ids) {
    ids = new Set()
    history.days.set(day, ids)
  }
  ids.add(requestId)
}

function summarizeHistory(history: HistoryCollector, day?: string): HistoryRequestSummary {
  const ids = day ? history.days.get(day) : undefined
  const requests = [...history.requests.entries()]
    .filter(([id, request]) => !day || ids?.has(id) || request.day === day)
    .map(([, request]) => request)
  const aggregate = aggregateHistory(requests)
  const notDownloaded = aggregateHistory(requests.filter((request) => request.notDownloaded))
  const served = requests.filter((request) => request.served)
  const unsettledCount = served.filter((request) => !request.settled).length
  return {
    ...aggregate,
    notDownloaded,
    unsettledServed: {
      count: unsettledCount,
      share: served.length > 0 ? roundRatio(unsettledCount / served.length) : null
    }
  }
}

function aggregateHistory(requests: readonly HistoryRequest[]): HistoryRequestAggregate {
  const timings: Record<HistoryMetric, number[]> = {
    queueMs: [],
    mainMs: [],
    ipcMs: [],
    renderMs: [],
    totalMs: []
  }
  const outcomes: Record<HistoryOutcome, number> = { ok: 0, failed: 0, discarded: 0 }
  let served = 0
  for (const request of requests) {
    if (request.queueMs !== null) timings.queueMs.push(request.queueMs)
    if (request.mainMs !== null) timings.mainMs.push(request.mainMs)
    if (request.ipcMs !== null) timings.ipcMs.push(request.ipcMs)
    if (request.renderMs !== null) timings.renderMs.push(request.renderMs)
    if (request.queueMs !== null && request.mainMs !== null && request.ipcMs !== null && request.renderMs !== null) {
      timings.totalMs.push(request.queueMs + request.mainMs + request.ipcMs + request.renderMs)
    }
    if (request.served) served += 1
    if (request.outcome) outcomes[request.outcome] += 1
  }
  return {
    status: requests.length > 0 ? 'present' : 'empty',
    requests: requests.length,
    served,
    outcomes,
    timings: {
      queueMs: timingStats(timings.queueMs),
      mainMs: timingStats(timings.mainMs),
      ipcMs: timingStats(timings.ipcMs),
      renderMs: timingStats(timings.renderMs),
      totalMs: timingStats(timings.totalMs)
    }
  }
}

function zeroHistorySummary(): HistoryRequestSummary {
  return {
    ...aggregateHistory([]),
    notDownloaded: aggregateHistory([]),
    unsettledServed: { count: 0, share: null }
  }
}

function timingStats(values: readonly number[]): HistoryTimingStats {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]
  }
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000
}

function msValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function extendWindow(window: { from: string | null; to: string | null }, ts: string | null): void {
  if (!ts) return
  if (window.from === null || ts < window.from) window.from = ts
  if (window.to === null || ts > window.to) window.to = ts
}

function countRecord(counts: Counts, record: AuditRecord): void {
  counts.records += 1
  counts.events[record.event] = (counts.events[record.event] ?? 0) + 1
  if (record.event === 'app.started') {
    counts.boots.started += 1
    if (record.prevShutdown === 'clean' || record.prevShutdown === 'unclean' || record.prevShutdown === 'unknown') {
      counts.boots.prevShutdown[record.prevShutdown] += 1
    }
  } else if (record.event === 'app.stall') {
    countStall(counts, record.durationMs)
  } else if (record.event === 'app.crash') {
    if (record.fatal === true) counts.crashes.fatal += 1
    else if (record.fatal === false) counts.crashes.nonFatal += 1
    else counts.crashes.unclassified += 1
  } else if (record.event === 'reveal' && typeof record.outcome === 'string' && isRevealOutcome(record.outcome)) {
    counts.reveals[record.outcome] += 1
  }
}

function parseRecord(line: string): AuditRecord | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.event !== 'string' || record.event.length > 64 || !EVENT_RE.test(record.event)) return null
    return record as AuditRecord
  } catch {
    return null
  }
}

function countStall(counts: Counts, durationMs: unknown): void {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return
  if (durationMs < 2000) counts.stalls.under2s += 1
  else if (durationMs < 5000) counts.stalls['2to5s'] += 1
  else if (durationMs < 30000) counts.stalls['5to30s'] += 1
  else counts.stalls['30sPlus'] += 1
}

function isRevealOutcome(value: string): value is RevealOutcome {
  return (REVEAL_OUTCOMES as readonly string[]).includes(value)
}

function isReapReason(value: unknown): value is SidecarReapReason {
  return typeof value === 'string' && (SIDECAR_REAP_REASONS as readonly string[]).includes(value)
}

function isHistoryOutcome(value: unknown): value is HistoryOutcome {
  return value === 'ok' || value === 'failed' || value === 'discarded'
}
