import { readFile } from 'node:fs/promises'
import type { RevealOutcome } from './reveal-trace'
import { REVEAL_OUTCOMES } from './projection'

export interface DiagnosticsIdentity {
  version: string
  platform: string
  arch: string
}

export interface DiagnosticsSummary {
  kind: 'metis-diagnostics-summary'
  schema: 1
  generatedAt: string
  app: DiagnosticsIdentity
  window: { from: string | null; to: string | null; records: number }
  boots: { started: number; prevShutdown: Record<'clean' | 'unclean' | 'unknown', number> }
  stalls: { under2s: number; '2to5s': number; '5to30s': number; '30sPlus': number }
  crashes: { fatal: number; nonFatal: number; unclassified: number }
  reveals: Record<RevealOutcome, number>
  events: Record<string, number>
}

export function summarizeAuditTrail(
  lines: readonly string[],
  identity: DiagnosticsIdentity,
  generatedAt: Date
): DiagnosticsSummary {
  const summary = zeroSummary(identity, generatedAt)
  for (const line of lines) {
    const record = parseRecord(line)
    if (!record) continue
    summary.window.records += 1
    const ts = typeof record.ts === 'string' && ISO_TIME_RE.test(record.ts) ? record.ts : null
    if (ts) {
      if (summary.window.from === null || ts < summary.window.from) summary.window.from = ts
      if (summary.window.to === null || ts > summary.window.to) summary.window.to = ts
    }
    summary.events[record.event] = (summary.events[record.event] ?? 0) + 1
    if (record.event === 'app.started') {
      summary.boots.started += 1
      if (record.prevShutdown === 'clean' || record.prevShutdown === 'unclean' || record.prevShutdown === 'unknown') {
        summary.boots.prevShutdown[record.prevShutdown] += 1
      }
    } else if (record.event === 'app.stall') {
      countStall(summary, record.durationMs)
    } else if (record.event === 'app.crash') {
      if (record.fatal === true) summary.crashes.fatal += 1
      else if (record.fatal === false) summary.crashes.nonFatal += 1
      else summary.crashes.unclassified += 1
    } else if (record.event === 'reveal' && typeof record.outcome === 'string' && isRevealOutcome(record.outcome)) {
      summary.reveals[record.outcome] += 1
    }
  }
  return summary
}

/** Never rejects: an unreadable or missing trail yields a zero summary, which is still copied. */
export async function copyDiagnosticsSummary(opts: {
  auditTrailPath: string
  identity: DiagnosticsIdentity
  writeText: (text: string) => void
  now?: () => Date
}): Promise<void> {
  let text = ''
  try {
    text = await readFile(opts.auditTrailPath, 'utf8')
  } catch {
    text = ''
  }
  const summary = summarizeAuditTrail(text.split(/\r?\n/), opts.identity, (opts.now ?? (() => new Date()))())
  try {
    opts.writeText(JSON.stringify(summary, null, 2))
  } catch {
    // Last-resort tray action: keep the documented never-rejects contract even if clipboard writes fail.
  }
}

const EVENT_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,4}$/
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function zeroSummary(identity: DiagnosticsIdentity, generatedAt: Date): DiagnosticsSummary {
  return {
    kind: 'metis-diagnostics-summary',
    schema: 1,
    generatedAt: generatedAt.toISOString(),
    app: identity,
    window: { from: null, to: null, records: 0 },
    boots: { started: 0, prevShutdown: { clean: 0, unclean: 0, unknown: 0 } },
    stalls: { under2s: 0, '2to5s': 0, '5to30s': 0, '30sPlus': 0 },
    crashes: { fatal: 0, nonFatal: 0, unclassified: 0 },
    reveals: { created: 0, shown: 0, 'already-visible': 0, failed: 0 },
    events: {}
  }
}

function parseRecord(line: string): (Record<string, unknown> & { event: string }) | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.event !== 'string' || record.event.length > 64 || !EVENT_RE.test(record.event)) return null
    return record as Record<string, unknown> & { event: string }
  } catch {
    return null
  }
}

function countStall(summary: DiagnosticsSummary, durationMs: unknown): void {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return
  if (durationMs < 2000) summary.stalls.under2s += 1
  else if (durationMs < 5000) summary.stalls['2to5s'] += 1
  else if (durationMs < 30000) summary.stalls['5to30s'] += 1
  else summary.stalls['30sPlus'] += 1
}

function isRevealOutcome(value: string): value is RevealOutcome {
  return (REVEAL_OUTCOMES as readonly string[]).includes(value)
}
