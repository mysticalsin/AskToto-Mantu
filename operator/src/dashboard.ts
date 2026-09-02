import { aggregateCacheSlice, estimateCacheCost, formatUsdEstimate, type AskLogLine } from '../../src/shared/operator'
import { CRM_STATUSES, type CrmSendRow, type CrmStatus } from './crm'
import { missingCloudflareOverview, type CloudflareOverview } from './cloudflare'
import { looksLikeSecret, safeChips, type SafeChip } from './redact'
import type { EventRow, OperatorStore, PulseRow, SeatRow, VaultKeyMeta } from './store'

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
    landing: CrmLanding
    funnel: CrmFunnelByConnector[]
    rows: {
      id: string
      status: CrmStatus
      title: string
      connector: string
      ts: number
      error: string | null
      retryRequested: boolean
      device: string
      attempt: number
      latencyMs: number
      remoteId: string | null
      remoteUrl: string | null
      meetingHash: string | null
      action: string | null
    }[]
  }
  events: ConsoleEvent[]
  profiles: ProfileRow[]
  keys: {
    ingestBound: boolean
    promptBound: boolean
    skillBound: boolean
    vaultBound: boolean
    vault: VaultKeyMeta[]
  }
  cloudflare: CloudflareOverview
}

export interface ConsoleEvent {
  id: string
  ts: number
  name: string
  hostname: string | null
  email: string | null
  chips: SafeChip[]
}

export interface ProfileRow {
  device: string
  hostname: string | null
  email: string | null
  os: string
  appVersion: string
  country: string | null
  city: string | null
  lastSeen: number
  live: boolean
  license: string | null
}

export type DashboardKeyFlags = {
  ingestBound: boolean
  promptBound: boolean
  skillBound: boolean
  vaultBound: boolean
}

export type CrmLanding = {
  landedToday: number
  failRatePct: number | null
  retries: number
  deadLetters: number
}

export type CrmFunnelByConnector = {
  connector: string
  attempted: number
  submitted: number
  success: number
  failed: number
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

export function emptyCrmLanding(): CrmLanding {
  return { landedToday: 0, failRatePct: null, retries: 0, deadLetters: 0 }
}

function startOfUtcDay(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

export function crmLandingKpis(rows: CrmSendRow[], now = Date.now()): CrmLanding {
  const dayStart = startOfUtcDay(now)
  let landedToday = 0
  let attempted = 0
  let failedOrDead = 0
  let retries = 0
  let deadLetters = 0
  for (const row of rows) {
    if (row.status === 'success' && row.ts >= dayStart) landedToday += 1
    if (row.status !== 'pending') attempted += 1
    if (row.status === 'failed' || row.status === 'expired') failedOrDead += 1
    if (row.status === 'expired') deadLetters += 1
    if (row.retry_requested === 1 || row.attempt > 1) retries += 1
  }
  return {
    landedToday,
    failRatePct: attempted === 0 ? null : Math.round((failedOrDead / attempted) * 1000) / 10,
    retries,
    deadLetters
  }
}

export function crmFunnelByConnector(rows: CrmSendRow[]): CrmFunnelByConnector[] {
  const by = new Map<string, CrmFunnelByConnector>()
  for (const row of rows) {
    const connector = row.connector.trim() || 'unknown'
    const cur = by.get(connector) ?? {
      connector,
      attempted: 0,
      submitted: 0,
      success: 0,
      failed: 0
    }
    if (row.status !== 'pending') cur.attempted += 1
    if (row.status === 'submitted' || row.status === 'in_review' || row.status === 'success') cur.submitted += 1
    if (row.status === 'success') cur.success += 1
    if (row.status === 'failed' || row.status === 'expired') cur.failed += 1
    by.set(connector, cur)
  }
  return [...by.values()].sort((a, b) => b.attempted - a.attempted || a.connector.localeCompare(b.connector))
}

function uniqueSeats(seats: SeatRow[], since: number): number {
  const ids = new Set<string>()
  for (const s of seats) {
    if (s.last_seen >= since) ids.add(s.device_id)
  }
  return ids.size
}

function displayProfile(seat: SeatRow | undefined): { hostname: string | null; email: string | null } {
  return {
    hostname: seat?.hostname && !looksLikeSecret(seat.hostname) ? seat.hostname : null,
    email: seat?.sso_email && !looksLikeSecret(seat.sso_email) ? seat.sso_email : null
  }
}

function eventFromStored(row: EventRow, seatsById: Map<string, SeatRow>): ConsoleEvent {
  const seat = row.device_id ? seatsById.get(row.device_id) : undefined
  const who = displayProfile(seat)
  return {
    id: row.id,
    ts: row.ts,
    name: looksLikeSecret(row.kind) ? 'event' : row.kind,
    hostname: who.hostname,
    email: who.email || (row.actor && !looksLikeSecret(row.actor) ? row.actor : null),
    chips: safeChips({
      country: row.country,
      os: seat?.os,
      detail: row.detail
    })
  }
}

function mergeEvents(stored: ConsoleEvent[], extra: ConsoleEvent[]): ConsoleEvent[] {
  const by = new Map<string, ConsoleEvent>()
  for (const e of [...stored, ...extra]) {
    if (!by.has(e.id)) by.set(e.id, e)
  }
  return [...by.values()].sort((a, b) => b.ts - a.ts).slice(0, 80)
}

function sanitizeVaultMeta(v: VaultKeyMeta): VaultKeyMeta {
  return {
    id: v.id && !looksLikeSecret(v.id) ? v.id : 'key',
    provider: looksLikeSecret(v.provider) ? 'provider' : v.provider,
    label: looksLikeSecret(v.label) ? 'key' : v.label,
    last4: /^\w{2,8}$/.test(v.last4) ? v.last4 : '----',
    status: v.status,
    createdAt: v.createdAt,
    rotatedAt: v.rotatedAt,
    revokedAt: v.revokedAt
  }
}

export async function buildDashboard(
  store: OperatorStore,
  email: string,
  now: number,
  keys: DashboardKeyFlags = { ingestBound: false, promptBound: false, skillBound: false, vaultBound: false },
  cloudflare: CloudflareOverview = missingCloudflareOverview()
): Promise<DashboardPayload> {
  const seats = await store.listSeats()
  const asks = await store.listAsks(2000)
  const pulses = await store.listPulses(now - 7 * DAY)
  const proposals = await store.listProposals()
  const audit = await store.listAudit(80)
  const crm = await store.listCrm(200)
  const packs = await store.listPacks()
  const storedEvents = await store.listEvents(80)
  const vault = await store.listVaultMeta()
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))

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
  const hours24: SeriesPoint[] = hourStarts.map((t, i) => {
    const end = i === hourStarts.length - 1 ? now + 1 : t + HOUR
    return {
      t,
      heartbeats: countIn(pulses, t, end, 'heartbeat'),
      asks: countIn(pulses, t, end, 'ask')
    }
  })
  const days7: SeriesPoint[] = dayStarts.map((t, i) => {
    const end = i === dayStarts.length - 1 ? now + 1 : t + DAY
    return {
      t,
      heartbeats: countIn(pulses, t, end, 'heartbeat'),
      asks: countIn(pulses, t, end, 'ask')
    }
  })

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
      landing: crmLandingKpis(crm, now),
      funnel: crmFunnelByConnector(crm),
      rows: crm.map((r) => ({
        id: r.id,
        status: r.status,
        title: r.title,
        connector: r.connector,
        ts: r.ts,
        error: r.last_error,
        retryRequested: r.retry_requested === 1,
        device: r.device_id.slice(0, 8),
        attempt: r.attempt,
        latencyMs: r.latency_ms,
        remoteId: r.remote_id,
        remoteUrl: r.remote_url,
        meetingHash: r.meeting_hash,
        action: r.action
      }))
    },
    events: mergeEvents(
      storedEvents.map((e) => eventFromStored(e, seatsById)),
      [
        ...asks.slice(0, 40).map((a) => {
          const who = displayProfile(seatsById.get(a.device_id))
          return {
            id: `ask-${a.id}`,
            ts: a.ts,
            name: 'ask',
            hostname: who.hostname,
            email: who.email,
            chips: safeChips({
              mode: a.mode,
              provider: a.provider,
              cache: a.cache_status,
              os: seatsById.get(a.device_id)?.os
            })
          }
        }),
        ...crm.slice(0, 40).map((r) => {
          const who = displayProfile(seatsById.get(r.device_id))
          return {
            id: `crm-${r.id}`,
            ts: r.ts,
            name: 'crm',
            hostname: who.hostname,
            email: who.email,
            chips: safeChips({
              status: r.status,
              connector: r.connector,
              action: r.action
            })
          }
        })
      ]
    ),
    profiles: seats
      .slice()
      .sort((a, b) => b.last_seen - a.last_seen)
      .map((s) => ({
        device: s.device_id.slice(0, 8),
        hostname: s.hostname && !looksLikeSecret(s.hostname) ? s.hostname : null,
        email: s.sso_email && !looksLikeSecret(s.sso_email) ? s.sso_email : null,
        os: s.os,
        appVersion: s.app_version,
        country: s.country,
        city: s.city,
        lastSeen: s.last_seen,
        live: now - s.last_seen < ONLINE_MS,
        license: s.license && !looksLikeSecret(s.license) ? s.license : null
      })),
    keys: {
      ingestBound: keys.ingestBound,
      promptBound: keys.promptBound,
      skillBound: keys.skillBound,
      vaultBound: keys.vaultBound,
      vault: vault.map(sanitizeVaultMeta)
    },
    cloudflare: {
      worker: cloudflare.worker,
      connected: cloudflare.connected,
      error: cloudflare.error,
      requests: cloudflare.requests,
      errors: cloudflare.errors,
      cpuMs: cloudflare.cpuMs,
      range: cloudflare.range,
      workers: cloudflare.workers.filter((w) => !looksLikeSecret(w)),
      d1Name: cloudflare.d1Name && !looksLikeSecret(cloudflare.d1Name) ? cloudflare.d1Name : null,
      d1Id: cloudflare.d1Id && !looksLikeSecret(cloudflare.d1Id) ? cloudflare.d1Id : null
    }
  }
}
