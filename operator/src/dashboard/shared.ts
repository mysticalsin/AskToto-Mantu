import { aggregateCacheSlice, type AskLogLine } from '../../../src/shared/operator'
import { timeSavedFromMeetings } from '../../../src/shared/time-saved'
import { looksLikeSecret, safeChips, type SafeChip } from '../redact'
import type { AskRow, EventRow, PulseRow, SeatRow } from '../store'
import type { ConsoleEvent, MixBar, SeriesPoint } from '../dashboard'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
export const ONLINE_MS = 2 * 60 * 1000

export const CLI_ASK_PROVIDERS = new Set(['claude-cli', 'codex-cli', 'dust'])

export function buckets(now: number, count: number, step: number): number[] {
  const start = now - count * step
  return Array.from({ length: count }, (_, i) => start + i * step)
}

export function countIn(pulses: PulseRow[], start: number, end: number, kind: PulseRow['kind']): number {
  let n = 0
  for (const p of pulses) {
    if (p.kind === kind && p.ts >= start && p.ts < end) n++
  }
  return n
}

export function mix(values: string[]): MixBar[] {
  const m = new Map<string, number>()
  for (const v of values) {
    const key = v || 'unknown'
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

export function askLine(a: {
  ts: number
  cache_read: number | null
  cache_write: number | null
  cache_uncached: number | null
  cache_status: string | null
  cache_ttl: string | null
  model: string | null
  provider: string | null
  output_tokens: number | null
  ttft_ms?: number | null
}): AskLogLine {
  return {
    ts: a.ts,
    cacheRead: a.cache_read ?? undefined,
    cacheWrite: a.cache_write ?? undefined,
    cacheUncached: a.cache_uncached ?? undefined,
    cacheStatus: (a.cache_status as AskLogLine['cacheStatus']) ?? undefined,
    cacheTtl: (a.cache_ttl as AskLogLine['cacheTtl']) ?? undefined,
    model: a.model ?? undefined,
    provider: a.provider ?? undefined,
    outputTokens: a.output_tokens ?? undefined,
    ttftMs: a.ttft_ms ?? undefined
  }
}

export function uniqueSeats(seats: SeatRow[], since: number): number {
  const ids = new Set<string>()
  for (const s of seats) {
    if (s.last_seen >= since) ids.add(s.device_id)
  }
  return ids.size
}

export function displayProfile(seat: SeatRow | undefined): { hostname: string | null; email: string | null } {
  return {
    hostname: seat?.hostname && !looksLikeSecret(seat.hostname) ? seat.hostname : null,
    email: seat?.sso_email && !looksLikeSecret(seat.sso_email) ? seat.sso_email : null
  }
}

export function seatContextChips(seat: SeatRow | undefined, extra: Record<string, unknown> = {}): SafeChip[] {
  return safeChips({
    city: seat?.city,
    region: seat?.region,
    country: seat?.country,
    os: seat?.os,
    device: seat?.device_id ? seat.device_id.slice(0, 8) : undefined,
    license: seat?.license,
    ...extra
  })
}

export function eventFromStored(row: EventRow, seatsById: Map<string, SeatRow>): ConsoleEvent {
  const seat = row.device_id ? seatsById.get(row.device_id) : undefined
  const who = displayProfile(seat)
  return {
    id: row.id,
    ts: row.ts,
    name: looksLikeSecret(row.kind) ? 'event' : row.kind,
    hostname: who.hostname,
    email: who.email || (row.actor && !looksLikeSecret(row.actor) ? row.actor : null),
    chips: seatContextChips(seat, {
      country: row.country || seat?.country,
      detail: row.detail
    })
  }
}

export function mergeEvents(stored: ConsoleEvent[], extra: ConsoleEvent[]): ConsoleEvent[] {
  const by = new Map<string, ConsoleEvent>()
  for (const e of [...stored, ...extra]) {
    if (!by.has(e.id)) by.set(e.id, e)
  }
  return [...by.values()].sort((a, b) => b.ts - a.ts).slice(0, 80)
}

export function recapMeetings(events: EventRow[]): { durationMin: number }[] {
  const out: { durationMin: number }[] = []
  for (const e of events) {
    if (e.kind !== 'listen' && e.kind !== 'recap') continue
    const m = /^(\d+(?:\.\d+)?)m$/.exec((e.detail || '').trim())
    if (m) out.push({ durationMin: Number(m[1]) })
  }
  return out
}

export function uniqueDevicesPerBucket(pulses: PulseRow[], starts: number[], step: number, now: number): number[] {
  return starts.map((t, i) => {
    const end = i === starts.length - 1 ? now + 1 : t + step
    const ids = new Set<string>()
    for (const p of pulses) {
      if (p.kind === 'heartbeat' && p.ts >= t && p.ts < end) ids.add(p.device_id)
    }
    return ids.size
  })
}

export function countPerBucket(events: EventRow[], kind: string, starts: number[], step: number, now: number): number[] {
  return starts.map((t, i) => {
    const end = i === starts.length - 1 ? now + 1 : t + step
    let n = 0
    for (const e of events) {
      if (e.kind === kind && e.ts >= t && e.ts < end) n++
    }
    return n
  })
}

export function askTokenTotal(a: {
  input_tokens?: number | null
  cache_read: number | null
  cache_write: number | null
  cache_uncached: number | null
  output_tokens: number | null
}): number | null {
  const hasInput = a.input_tokens != null
  const hasOut = a.output_tokens != null
  const hasCache = a.cache_read != null || a.cache_write != null || a.cache_uncached != null
  if (!hasInput && !hasOut && !hasCache) return null
  if (hasInput || hasOut) return (a.input_tokens ?? 0) + (a.output_tokens ?? 0)
  return (a.cache_read ?? 0) + (a.cache_write ?? 0) + (a.cache_uncached ?? 0) + (a.output_tokens ?? 0)
}

export function tokensReported(asks: AskRow[]): number | null {
  let total = 0
  let any = false
  for (const a of asks) {
    const t = askTokenTotal(a)
    if (t == null) continue
    any = true
    total += t
  }
  return any ? total : null
}

export function listenMinutesReported(events: EventRow[]): number | null {
  let total = 0
  let any = false
  for (const e of events) {
    if (e.kind !== 'listen') continue
    const m = /^(\d+(?:\.\d+)?)m$/.exec((e.detail || '').trim())
    if (!m) continue
    any = true
    total += Number(m[1])
  }
  return any ? total : null
}

export function averageDurationMs(asks: AskRow[]): number | null {
  const durations = asks.map((a) => a.total_ms).filter((v): v is number => v != null)
  if (!durations.length) return null
  return Math.round(durations.reduce((n, v) => n + v, 0) / durations.length)
}

export function startOfUtcDay(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function buildSeries(args: {
  now: number
  hourStarts: number[]
  dayStarts: number[]
  pulses: PulseRow[]
}): { hours24: SeriesPoint[]; days7: SeriesPoint[] } {
  const { now, hourStarts, dayStarts, pulses } = args
  const hours24 = hourStarts.map((t, i) => {
    const end = i === hourStarts.length - 1 ? now + 1 : t + HOUR
    return { t, heartbeats: countIn(pulses, t, end, 'heartbeat'), asks: countIn(pulses, t, end, 'ask') }
  })
  const days7 = dayStarts.map((t, i) => {
    const end = i === dayStarts.length - 1 ? now + 1 : t + DAY
    return { t, heartbeats: countIn(pulses, t, end, 'heartbeat'), asks: countIn(pulses, t, end, 'ask') }
  })
  return { hours24, days7 }
}

export function hitSeries(asks: AskRow[], hourStarts: number[]): number[] {
  return hourStarts.map((t) => {
    const slice = aggregateCacheSlice(asks.filter((a) => a.ts >= t && a.ts < t + HOUR).map(askLine))
    return slice.hitRate == null ? 0 : Math.round(slice.hitRate * 100)
  })
}

export function savedMinutes(events: EventRow[]): number | null {
  const recaps = events.filter((e) => e.kind === 'recap')
  return recaps.length ? timeSavedFromMeetings(recapMeetings(events)).savedMinutes : null
}
