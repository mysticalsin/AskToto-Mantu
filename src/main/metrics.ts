import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { EvalMetrics } from '@shared/ipc'

/**
 * Local, on-device eval metrics — computed from the audit log (userData/logs/audit.log), never shipped
 * anywhere. The audit log records metadata only (no answer/question/transcript content), so this is
 * privacy-safe by construction. Surfaces the section-H/D quality + latency numbers from the product brief:
 * answer latency p50/p95, time-to-first-token p50/p95, answer acceptance rate (thumbs), provider failure
 * + fallback rates, and a per-provider request count.
 *
 * The aggregation is a pure function over parsed records so it can be unit-tested without a real log file.
 */

export interface AuditRecord {
  event: string
  ts?: string
  phase?: string
  ttftMs?: number
  totalMs?: number
  rating?: 'up' | 'down'
  provider?: string
  retry?: boolean
}

/** Nearest-rank percentile of an already-collected sample. Returns null for an empty sample. */
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

/** Aggregate parsed audit records into eval metrics. Pure — the unit-tested core. */
export function aggregateMetrics(records: AuditRecord[]): EvalMetrics {
  const ttft: number[] = []
  const total: number[] = []
  let up = 0
  let down = 0
  let failures = 0
  let fallbacks = 0
  const byProvider: Record<string, number> = {}

  for (const r of records) {
    if (r.event === 'provider.request') {
      // The completion record (phase 'done') carries the latency numbers; the pre-request record carries
      // the provider + retry flag. Count requests on the pre-request record so each ask counts once.
      if (r.phase === 'done') {
        if (typeof r.ttftMs === 'number') ttft.push(r.ttftMs)
        if (typeof r.totalMs === 'number') total.push(r.totalMs)
      } else {
        if (r.provider) byProvider[r.provider] = (byProvider[r.provider] || 0) + 1
        if (r.retry) fallbacks++
      }
    } else if (r.event === 'provider.failed') {
      failures++
    } else if (r.event === 'answer.feedback') {
      if (r.rating === 'up') up++
      else if (r.rating === 'down') down++
    }
  }

  return {
    answers: total.length,
    ttftP50Ms: percentile(ttft, 50),
    ttftP95Ms: percentile(ttft, 95),
    answerP50Ms: percentile(total, 50),
    answerP95Ms: percentile(total, 95),
    acceptance: { up, down, rate: up + down > 0 ? up / (up + down) : null },
    failures,
    fallbacks,
    byProvider
  }
}

/** Read + parse the audit log (last `maxLines` lines) and aggregate. Best-effort; never throws. */
export function readEvalMetrics(maxLines = 10_000): EvalMetrics {
  try {
    const path = join(app.getPath('userData'), 'logs', 'audit.log')
    if (!existsSync(path)) return aggregateMetrics([])
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    const recent = lines.slice(-maxLines)
    const records: AuditRecord[] = []
    for (const line of recent) {
      if (!line) continue
      try {
        records.push(JSON.parse(line) as AuditRecord)
      } catch {
        /* skip a malformed line */
      }
    }
    return aggregateMetrics(records)
  } catch {
    return aggregateMetrics([])
  }
}
