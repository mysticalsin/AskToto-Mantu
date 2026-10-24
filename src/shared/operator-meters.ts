/**
 * Server-defined usage meters (G79, R101). The Operator Worker owns every number; the desktop only parses
 * and evaluates them. Every parser fails CLOSED: a row without a safe limit is dropped (a quota is never
 * invented), and an unknown `used` is never read as 0 or as exhausted.
 */
export const METER_UNITS = ['tokens', 'requests', 'minutes'] as const
export type MeterUnit = (typeof METER_UNITS)[number]
export type MeterWindow = 'day' | 'month' | 'none'

export interface OperatorMeter {
  id: string
  label: string
  unit: MeterUnit
  limit: number
  used: number | null
  resetAt: number | null
  window: MeterWindow
}

export type MeterState = 'available' | 'exhausted' | 'unknown'
export interface MeterEvaluation {
  state: MeterState
  remaining: number | null
}

const MAX_METERS = 16

function safeCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null
}

function parseMeter(raw: unknown): OperatorMeter | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.label !== 'string' || !o.label.trim()) return null
  const unit = METER_UNITS.find((u) => u === o.unit)
  if (!unit) return null
  const limit = safeCount(o.limit)
  if (limit === null) return null
  const resetAt = typeof o.resetAt === 'number' && Number.isFinite(o.resetAt) && o.resetAt > 0 ? o.resetAt : null
  const window: MeterWindow = o.window === 'day' || o.window === 'month' ? o.window : 'none'
  return { id: o.id, label: o.label, unit, limit, used: safeCount(o.used), resetAt, window }
}

export function parseOperatorMeters(raw: unknown): OperatorMeter[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: OperatorMeter[] = []
  for (const item of raw) {
    const meter = parseMeter(item)
    if (!meter || seen.has(meter.id)) continue
    seen.add(meter.id)
    out.push(meter)
    if (out.length >= MAX_METERS) break
  }
  return out
}

/** One meter on its own. A stale window (resetAt passed) or an unreported `used` is `unknown`, never `exhausted`. */
export function evaluateMeter(meter: OperatorMeter, now: number): MeterEvaluation {
  if (meter.used === null) return { state: 'unknown', remaining: null }
  if (meter.resetAt !== null && now >= meter.resetAt) return { state: 'unknown', remaining: null }
  if (meter.used >= meter.limit) return { state: 'exhausted', remaining: 0 }
  return { state: 'available', remaining: meter.limit - meter.used }
}
