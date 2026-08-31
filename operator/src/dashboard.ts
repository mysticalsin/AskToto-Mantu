import { aggregateCacheSlice, estimateCacheCost, formatUsdEstimate, type AskLogLine } from '../../src/shared/operator'
import { CRM_STATUSES, type CrmStatus } from './crm'
import type { OperatorStore, PulseRow, SeatRow } from './store'

export const ONLINE_MS = 2 * 60 * 1000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export interface SeriesPoint {
  t: number
  heartbeats: number
  asks: number
}

export interface TokenPoint {
  t: number
  read: number
  write: number
  uncached: number
}

export interface MixBar {
  label: string
  value: number
}

export interface CostRow {
  provider: string
  mode: string
  asks: number
  read: number | null
  write: number | null
  uncached: number | null
  estimate: string | null
}

export interface MapCountry {
  iso: string
  devices: number
}

export interface MapDot {
  lat: number
  lon: number
  city: string | null
  country: string
}

export interface DashboardPayload {
  email: string
  now: number
  kpis: {
    live: number
    dau: number
    wau: number
    versions: number
    cacheHit: string | null
    costToday: string | null
    cost7d: string | null
    pendingDiffs: number
    lastIndexAt: number | null
    liveSeries: number[]
    dauSeries: number[]
    costSeries: number[]
    hitSeries: number[]
  }
  scale: {
    hours24: SeriesPoint[]
    days7: SeriesPoint[]
    versions: MixBar[]
    os: MixBar[]
  }
  cost: {
    tokens: TokenPoint[]
    table: CostRow[]
  }
  change: {
    timeline: { ts: number; actor: string; action: string; detail: string }[]
    heatmap: number[]
    adoption: MixBar[]
  }
  map: {
    countries: MapCountry[]
    dots: MapDot[]
    empty: boolean
  }
  asks: { id: string; ts: number; mode: string; preview: string; cache_status: string; provider: string }[]
  proposals: {
    id: string
    skill_id: string
    from_version: string
    status: string
    rationale: string
    diff: string
    evidence: string[]
    created_by: string
    created_at: number
  }[]
  crm: {
    counts: Record<CrmStatus, number>
    rows: {
      id: string
      status: CrmStatus
      title: string
      connector: string
      ts: number
      error: string | null
      retryRequested: boolean
      device: string
    }[]
  }
}

function buckets(now: number, count: number, step: number): number[] {
  const start = now - count * step
  return Array.from({ length: count }, (_, i) => start + i * step)
}

function countIn(pulses: PulseRow[], start: number, end: number, kind: PulseRow['kind']): number {
  let n = 0
  for (const p of pulses) {
    if (p.kind === kind && p.ts >= start && p.ts < end) n++
  }
  return n
}

function mix(values: string[]): MixBar[] {
  const m = new Map<string, number>()
  for (const v of values) {
    const key = v || 'unknown'
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

function askLine(a: {
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

function costForAsks(
  asks: {
    cache_read: number | null
    cache_write: number | null
    cache_uncached: number | null
    cache_status: string | null
    cache_ttl: string | null
    output_tokens: number | null
    model: string | null
    provider: string | null
  }[]
): string | null {
  let usd = 0
  let any = false
  for (const a of asks) {
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? undefined,
        cacheWrite: a.cache_write ?? undefined,
        cacheUncached: a.cache_uncached ?? undefined,
        cacheStatus: (a.cache_status as AskLogLine['cacheStatus']) ?? undefined,
        cacheTtl: (a.cache_ttl as AskLogLine['cacheTtl']) ?? undefined,
        outputTokens: a.output_tokens ?? undefined
      },
      a.model || '',
      a.provider || undefined
    )
    if (est) {
      any = true
      usd += est.usd
    }
  }
  return any ? formatUsdEstimate(usd) : null
}

function uniqueSeats(seats: SeatRow[], since: number): number {
  const ids = new Set<string>()
  for (const s of seats) {
    if (s.last_seen >= since) ids.add(s.device_id)
  }
  return ids.size
}

export async function buildDashboard(store: OperatorStore, email: string, now: number): Promise<DashboardPayload> {
  const seats = await store.listSeats()
  const asks = await store.listAsks(2000)
  const pulses = await store.listPulses(now - 7 * DAY)
  const proposals = await store.listProposals()
  const audit = await store.listAudit(80)
  const crm = await store.listCrm(200)
  const packs = await store.listPacks()

  const live = seats.filter((s) => now - s.last_seen < ONLINE_MS).length
  const dau = uniqueSeats(seats, now - DAY)
  const wau = uniqueSeats(seats, now - 7 * DAY)
  const versions = new Set(seats.map((s) => s.app_version).filter(Boolean)).size
  const pendingDiffs = proposals.filter((p) => p.status === 'pending').length
  const lastIndexAt = seats.reduce<number | null>((acc, s) => {
    if (s.last_index_at == null) return acc
    return acc == null ? s.last_index_at : Math.max(acc, s.last_index_at)
  }, null)

  const hourStarts = buckets(now, 24, HOUR)
  const dayStarts = buckets(now, 7, DAY)
  const hours24: SeriesPoint[] = hourStarts.map((t) => ({
    t,
    heartbeats: countIn(pulses, t, t + HOUR, 'heartbeat'),
    asks: countIn(pulses, t, t + HOUR, 'ask')
  }))
  const days7: SeriesPoint[] = dayStarts.map((t) => ({
    t,
    heartbeats: countIn(pulses, t, t + DAY, 'heartbeat'),
    asks: countIn(pulses, t, t + DAY, 'ask')
  }))

  const todayAsks = asks.filter((a) => a.ts >= now - DAY)
  const weekAsks = asks.filter((a) => a.ts >= now - 7 * DAY)
  const sliceToday = aggregateCacheSlice(todayAsks.map(askLine))
  const costToday = costForAsks(todayAsks)
  const cost7d = costForAsks(weekAsks)

  const tokens: TokenPoint[] = hourStarts.map((t) => {
    let read = 0
    let write = 0
    let uncached = 0
    for (const a of asks) {
      if (a.ts < t || a.ts >= t + HOUR) continue
      if (a.cache_read != null) read += a.cache_read
      if (a.cache_write != null) write += a.cache_write
      if (a.cache_uncached != null) uncached += a.cache_uncached
    }
    return { t, read, write, uncached }
  })

  const tableMap = new Map<string, CostRow & { usd: number; anyCost: boolean }>()
  for (const a of weekAsks) {
    const provider = a.provider || 'unknown'
    const mode = a.mode || 'unknown'
    const key = `${provider}\0${mode}`
    const cur = tableMap.get(key) ?? {
      provider,
      mode,
      asks: 0,
      read: null as number | null,
      write: null as number | null,
      uncached: null as number | null,
      estimate: null as string | null,
      usd: 0,
      anyCost: false
    }
    cur.asks++
    if (a.cache_read != null) cur.read = (cur.read ?? 0) + a.cache_read
    if (a.cache_write != null) cur.write = (cur.write ?? 0) + a.cache_write
    if (a.cache_uncached != null) cur.uncached = (cur.uncached ?? 0) + a.cache_uncached
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? undefined,
        cacheWrite: a.cache_write ?? undefined,
        cacheUncached: a.cache_uncached ?? undefined,
        cacheStatus: (a.cache_status as AskLogLine['cacheStatus']) ?? undefined,
        cacheTtl: (a.cache_ttl as AskLogLine['cacheTtl']) ?? undefined,
        outputTokens: a.output_tokens ?? undefined
      },
      a.model || '',
      a.provider || undefined
    )
    if (est) {
      cur.anyCost = true
      cur.usd += est.usd
    }
    tableMap.set(key, cur)
  }
  const table: CostRow[] = [...tableMap.values()].map((r) => ({
    provider: r.provider,
    mode: r.mode,
    asks: r.asks,
    read: r.read,
    write: r.write,
    uncached: r.uncached,
    estimate: r.anyCost ? formatUsdEstimate(r.usd) : null
  }))

  const countryMap = new Map<string, Set<string>>()
  for (const s of seats) {
    if (!s.country) continue
    const set = countryMap.get(s.country) ?? new Set<string>()
    set.add(s.device_id)
    countryMap.set(s.country, set)
  }
  const countries: MapCountry[] = [...countryMap.entries()]
    .map(([iso, set]) => ({ iso, devices: set.size }))
    .sort((a, b) => b.devices - a.devices)
  const dots: MapDot[] = seats
    .filter((s) => s.lat != null && s.lon != null && s.country)
    .map((s) => ({ lat: s.lat as number, lon: s.lon as number, city: s.city, country: s.country as string }))

  const heatStart = now - 17 * 7 * DAY
  const heatmap = Array.from({ length: 17 * 7 }, () => 0)
  const bumpHeat = (ts: number): void => {
    if (ts < heatStart || ts > now) return
    const day = Math.floor((ts - heatStart) / DAY)
    if (day >= 0 && day < heatmap.length) heatmap[day]++
  }
  for (const a of audit) bumpHeat(a.ts)
  for (const p of packs) bumpHeat(p.pushed_at)
  for (const p of proposals) {
    bumpHeat(p.created_at)
    if (p.decided_at) bumpHeat(p.decided_at)
  }

  const counts = Object.fromEntries(CRM_STATUSES.map((s) => [s, 0])) as Record<CrmStatus, number>
  for (const row of crm) counts[row.status]++

  return {
    email,
    now,
    kpis: {
      live,
      dau,
      wau,
      versions,
      cacheHit: sliceToday.hitRate == null ? null : `${Math.round(sliceToday.hitRate * 100)}%`,
      costToday,
      cost7d,
      pendingDiffs,
      lastIndexAt,
      liveSeries: hours24.map((p) => p.heartbeats),
      dauSeries: days7.map((p) => p.heartbeats),
      costSeries: tokens.map((p) => p.read + p.write + p.uncached),
      hitSeries: hourStarts.map((t) => {
        const slice = aggregateCacheSlice(asks.filter((a) => a.ts >= t && a.ts < t + HOUR).map(askLine))
        return slice.hitRate == null ? 0 : Math.round(slice.hitRate * 100)
      })
    },
    scale: {
      hours24,
      days7,
      versions: mix(seats.map((s) => s.app_version)),
      os: mix(seats.map((s) => s.os))
    },
    cost: { tokens, table },
    change: {
      timeline: audit.map((a) => ({ ts: a.ts, actor: a.actor, action: a.action, detail: a.detail })),
      heatmap,
      adoption: mix(seats.map((s) => s.app_version))
    },
    map: {
      countries,
      dots,
      empty: countries.length === 0 && dots.length === 0
    },
    asks: asks.slice(0, 40).map((a) => ({
      id: a.id,
      ts: a.ts,
      mode: a.mode || '',
      preview: a.preview || 'Ask',
      cache_status: a.cache_status || 'not-reported',
      provider: a.provider || ''
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      skill_id: p.skill_id,
      from_version: p.from_version,
      status: p.status,
      rationale: p.rationale,
      diff: p.diff,
      evidence: JSON.parse(p.evidence_json || '[]') as string[],
      created_by: p.created_by,
      created_at: p.created_at
    })),
    crm: {
      counts,
      rows: crm.map((r) => ({
        id: r.id,
        status: r.status,
        title: r.title,
        connector: r.connector,
        ts: r.ts,
        error: r.last_error,
        retryRequested: r.retry_requested === 1,
        device: r.device_id.slice(0, 8)
      }))
    }
  }
}
