import {
  aggregateCacheSlice,
  estimateCacheCost,
  estimateListPrice,
  formatUsdEstimate,
  type AskLogLine
} from '../../src/shared/operator'
import { formatSavedTime, timeSavedFromMeetings } from '../../src/shared/time-saved'
import { aggregateQuestionTypes, type QuestionTypeMix } from '../../src/shared/question-type'
import { CRM_STATUSES, normalizeCrmRow, type CrmSendRow, type CrmStatus } from './crm'
import { missingCloudflareOverview, type CloudflareOverview } from './cloudflare'
import {
  approvalOf,
  isApprovedSeat,
  issuedLicenseActive,
  isRealSeat,
  LICENSES_EMPTY,
  parseLicenseId,
  seatLicenseLabel,
  type SeatApproval
} from './fleet'
import { looksLikeSecret, safeChips, type SafeChip } from './redact'
import { projectAskTelemetry, projectEventTelemetry } from './privacy'
import { geoRegionRows, realtimeGeoRows, type GeoRegionRow, type RealtimeGeoRow } from './realtime-geo'
import { readIntegrationExtra } from './connectors/data'
import type {
  AskRow,
  EventRow,
  IntegrationRow,
  IssuedLicenseRow,
  OperatorStore,
  ProposalRow,
  PulseRow,
  SeatRow,
  SessionRow,
  VaultKeyMeta
} from './store'

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

/** Overview mini-KPI feed (issue 106). Every field is a real D1 aggregate; null means not reported. */
export interface DashboardOps {
  uniqueSessions: number
  uniqueSeries: number[]
  sessionsDay: number
  sessionsDaySeries: number[]
  liveNow: number
  liveSeries: number[]
  live30: number
  timeSaved: number | null
  tokens: number | null
  tokenSeries: number[]
  apiCalls: number
  apiSeries: number[]
  listenMinutes: number | null
  recapCount: number
  recapSeries: number[]
  cliAsks: number
  operatorAsks: number
  portalCf: string
  portalDirect: string
  crmFailRate: number | null
  durationMs: number | null
  meetings: number
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
  ops: DashboardOps
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
    oauthBound: boolean
    vault: VaultKeyMeta[]
  }
  cloudflare: CloudflareOverview
  licenses: {
    empty: boolean
    error: string | null
    rows: {
      device: string
      hostname: string | null
      email: string | null
      os: string
      appVersion: string
      license: string | null
      approval: SeatApproval
      lastSeen: number
      keysAuthorized: boolean
    }[]
    issued: { jti: string; last4: string; days: number; exp: number; revoked: number; createdAt: number }[]
  }
  roi: {
    costToday: string | null
    cost7d: string | null
    liveSeats: number
    seats30m: number
    cacheHit: string | null
    asksToday: number
    licensed: number
    approved: number
    timeSaved: string
    timeSavedSub: string
    value: string
    valueSub: string
    /** Law 3 (plan 3.7b): time saved x the hourly rate Tony sets in Settings -> Value, in integer
     *  minor units (cents). Null whenever no rate is stored - never a default rate. */
    valueMinor: number | null
    currency: string
    hourlyRate: number | null
    source: 'd1.asks+d1.seats'
    portalCf: string
    portalDirect: string
  }
  gateway: {
    rows: { provider: string; asks: number; tokens: number | null; estimate: string | null; funded: boolean }[]
  }
  notices: {
    id: string
    kind: string
    title: string
    detail: string
    ts: number
    profile: string | null
    city: string | null
    os: string | null
  }[]
  geo: RealtimeGeoRow[]
  geoRegions: GeoRegionRow[]
  questions: QuestionsPayload
}

/** src/shared/question-type.ts owns the taxonomy and the aggregation math; this is just the shape. */
export interface QuestionsPayload {
  mix: QuestionTypeMix
  byMode: { mode: string; mix: QuestionTypeMix }[]
  coverage: number | null
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
  deviceId: string
  hostname: string | null
  email: string | null
  os: string
  appVersion: string
  country: string | null
  city: string | null
  region: string | null
  lastSeen: number
  live: boolean
  license: string | null
  approval: SeatApproval
}

export type DashboardKeyFlags = {
  ingestBound: boolean
  promptBound: boolean
  skillBound: boolean
  vaultBound: boolean
  oauthBound: boolean
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

function seatContextChips(seat: SeatRow | undefined, extra: Record<string, unknown> = {}): SafeChip[] {
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

function eventFromStored(row: EventRow, seatsById: Map<string, SeatRow>): ConsoleEvent {
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

function mergeEvents(stored: ConsoleEvent[], extra: ConsoleEvent[]): ConsoleEvent[] {
  const by = new Map<string, ConsoleEvent>()
  for (const e of [...stored, ...extra]) {
    if (!by.has(e.id)) by.set(e.id, e)
  }
  return [...by.values()].sort((a, b) => b.ts - a.ts).slice(0, 80)
}

function recapMeetings(events: EventRow[]): { durationMin: number }[] {
  const out: { durationMin: number }[] = []
  for (const e of events) {
    if (e.kind !== 'listen' && e.kind !== 'recap') continue
    const m = /^(\d+(?:\.\d+)?)m$/.exec((e.detail || '').trim())
    if (m) out.push({ durationMin: Number(m[1]) })
  }
  return out
}

/** CLI-shaped providers per the Overview cliAsks/operatorAsks split. Distinct from vault's
 *  FORBIDDEN_VAULT_PROVIDERS (which also blocks 'local'); this is only about ask attribution. */
const CLI_ASK_PROVIDERS = new Set(['claude-cli', 'codex-cli', 'dust'])

function uniqueDevicesPerBucket(pulses: PulseRow[], starts: number[], step: number, now: number): number[] {
  return starts.map((t, i) => {
    const end = i === starts.length - 1 ? now + 1 : t + step
    const ids = new Set<string>()
    for (const p of pulses) {
      if (p.kind === 'heartbeat' && p.ts >= t && p.ts < end) ids.add(p.device_id)
    }
    return ids.size
  })
}

function countPerBucket(events: EventRow[], kind: string, starts: number[], step: number, now: number): number[] {
  return starts.map((t, i) => {
    const end = i === starts.length - 1 ? now + 1 : t + step
    let n = 0
    for (const e of events) {
      if (e.kind === kind && e.ts >= t && e.ts < end) n++
    }
    return n
  })
}

/** Reported token total for one ask (input side from the cache breakdown, plus output). Null when the
 *  provider reported nothing, so the caller can tell "0 tokens" apart from "not reported". */
function askTokenTotal(a: {
  cache_read: number | null
  cache_write: number | null
  cache_uncached: number | null
  output_tokens: number | null
}): number | null {
  if (a.cache_read == null && a.cache_write == null && a.cache_uncached == null && a.output_tokens == null) return null
  return (a.cache_read ?? 0) + (a.cache_write ?? 0) + (a.cache_uncached ?? 0) + (a.output_tokens ?? 0)
}

function portalPathSpend(asks: AskRow[], tag: 'portal-cf' | 'portal-direct'): string {
  const rows = asks.filter((a) => a.path_tag === tag)
  if (!rows.length) return 'not reported'
  let usd = 0
  let anyCost = false
  let tokens = 0
  let anyTok = false
  for (const a of rows) {
    const inTok = a.input_tokens
    const outTok = a.output_tokens
    if (inTok != null || outTok != null) {
      anyTok = true
      tokens += (inTok ?? 0) + (outTok ?? 0)
    }
    const est = estimateListPrice(a.model || '', a.input_tokens, a.output_tokens, a.cache_read)
    if (!est) continue
    anyCost = true
    usd += est.usd
  }
  const tok = anyTok ? `${tokens} tok` : 'tokens not reported'
  if (!anyCost) return `${tok} · not reported`
  return `${tok} · ${formatUsdEstimate(usd)} · estimate, list price`
}

function tokensReported(asks: AskRow[]): number | null {
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

function minutesFromDetail(detail: string | null): number | null {
  const m = /^(\d+(?:\.\d+)?)m$/.exec((detail || '').trim())
  return m ? Number(m[1]) : null
}

function listenMinutesReported(events: EventRow[]): number | null {
  let total = 0
  let any = false
  for (const e of events) {
    if (e.kind !== 'listen') continue
    const mins = minutesFromDetail(e.detail)
    if (mins == null) continue
    any = true
    total += mins
  }
  return any ? total : null
}

function averageDurationMs(asks: AskRow[]): number | null {
  const durations = asks.map((a) => a.total_ms).filter((v): v is number => v != null)
  if (!durations.length) return null
  return Math.round(durations.reduce((n, v) => n + v, 0) / durations.length)
}

function buildOverviewOps(args: {
  now: number
  wau: number
  dau: number
  live: number
  live30: number
  hourStarts: number[]
  dayStarts: number[]
  hours24: SeriesPoint[]
  pulses: PulseRow[]
  weekAsks: AskRow[]
  storedEvents: EventRow[]
  crmFailRate: number | null
  vault: VaultKeyMeta[]
}): DashboardOps {
  const { now, wau, dau, live, live30, hourStarts, dayStarts, hours24, pulses, weekAsks, storedEvents, crmFailRate, vault } = args
  const dailyUnique = uniqueDevicesPerBucket(pulses, dayStarts, DAY, now)
  const recapEvents = storedEvents.filter((e) => e.kind === 'recap')
  const fundedProviders = new Set(vault.filter((v) => v.status === 'active').map((v) => v.provider))
  let cliAsks = 0
  let operatorAsks = 0
  for (const a of weekAsks) {
    const provider = a.provider || ''
    if (!CLI_ASK_PROVIDERS.has(provider) && fundedProviders.has(provider)) operatorAsks++
    else cliAsks++
  }
  return {
    uniqueSessions: wau,
    uniqueSeries: dailyUnique,
    sessionsDay: dau,
    sessionsDaySeries: dailyUnique,
    liveNow: live,
    liveSeries: hours24.map((p) => p.heartbeats),
    live30,
    timeSaved: recapEvents.length ? timeSavedFromMeetings(recapMeetings(storedEvents)).savedMinutes : null,
    tokens: tokensReported(weekAsks),
    tokenSeries: hourStarts.map((t, i) => {
      const end = i === hourStarts.length - 1 ? now + 1 : t + HOUR
      let total = 0
      for (const a of weekAsks) {
        if (a.ts < t || a.ts >= end) continue
        total += askTokenTotal(a) ?? 0
      }
      return total
    }),
    apiCalls: weekAsks.length,
    apiSeries: hours24.map((p) => p.asks),
    listenMinutes: listenMinutesReported(storedEvents),
    recapCount: recapEvents.length,
    recapSeries: countPerBucket(storedEvents, 'recap', dayStarts, DAY, now),
    cliAsks,
    operatorAsks,
    portalCf: portalPathSpend(weekAsks, 'portal-cf'),
    portalDirect: portalPathSpend(weekAsks, 'portal-direct'),
    crmFailRate,
    durationMs: averageDurationMs(weekAsks),
    meetings: recapEvents.length
  }
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

/** Just the fields `roi`'s Value law (3.7b law 3) needs. Owned by `./routes/settings-store.ts` (task
 *  B6); passed in explicitly rather than read here so `dashboard.ts` never touches D1 directly.
 *  `hourlyRate: null` (the default when the caller has nothing to pass) means "not set" - `roi`
 *  must never invent a rate. */
export interface DashboardValueSettings {
  hourlyRate: number | null
  currency: string
}

const NO_VALUE_SETTINGS: DashboardValueSettings = { hourlyRate: null, currency: 'USD' }

export async function buildDashboard(
  store: OperatorStore,
  email: string,
  now: number,
  keys: DashboardKeyFlags = {
    ingestBound: false,
    promptBound: false,
    skillBound: false,
    vaultBound: false,
    oauthBound: false
  },
  cloudflare: CloudflareOverview = missingCloudflareOverview(),
  valueSettings: DashboardValueSettings = NO_VALUE_SETTINGS
): Promise<DashboardPayload> {
  const [seatsRaw, asksRaw, pulses, proposals, audit, crmRaw, packs, storedEventsRaw, vault, issued, sessionsPage] = await Promise.all([
    store.listSeats(),
    store.listAsks(2000),
    store.listPulses(now - 7 * DAY),
    store.listProposals(100),
    store.listAudit(80),
    store.listCrm(200),
    store.listPacks(),
    store.listEvents(80),
    store.listVaultMeta(),
    store.listIssuedLicenses(200),
    store.listSessions({ since: now - 7 * DAY, limit: 1000 })
  ])
  const asks = asksRaw.map(projectAskTelemetry)
  const crm = crmRaw.map(normalizeCrmRow)
  const storedEvents = storedEventsRaw.map(projectEventTelemetry)
  const seats = seatsRaw.filter(isRealSeat)
  const sessions = sessionsPage.rows
  const activeJti = new Set(issued.filter((l) => issuedLicenseActive(l, now)).map((l) => l.jti))
  const licenseLabel = (s: SeatRow): string | null => {
    const label = seatLicenseLabel(s, issued, now)
    return label && !looksLikeSecret(label) ? label : null
  }
  const keysOn = (s: SeatRow): boolean => {
    if ((s.approval || '').trim().toLowerCase() === 'revoked') return false
    if (isApprovedSeat(s)) return true
    const jti = parseLicenseId(s.license_jti)
    return Boolean(jti && activeJti.has(jti))
  }
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))

  const live = seats.filter((s) => now - s.last_seen < ONLINE_MS).length
  const live30 = seats.filter((s) => now - s.last_seen < 30 * 60 * 1000).length
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
  const crmLanding = crmLandingKpis(crm, now)

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
    ops: buildOverviewOps({
      now,
      wau,
      dau,
      live,
      live30,
      hourStarts,
      dayStarts,
      hours24,
      pulses,
      weekAsks,
      storedEvents,
      crmFailRate: crmLanding.failRatePct,
      vault
    }),
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
      rationale: 'Ask metadata only; no prompt evidence stored.',
      diff: p.diff,
      evidence: [],
      created_by: p.created_by,
      created_at: p.created_at
    })),
    crm: {
      counts,
      landing: crmLanding,
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
            chips: seatContextChips(seatsById.get(a.device_id), {
              mode: a.mode,
              provider: a.provider,
              cache: a.cache_status
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
            chips: seatContextChips(seatsById.get(r.device_id), {
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
        deviceId: s.device_id,
        hostname: s.hostname && !looksLikeSecret(s.hostname) ? s.hostname : null,
        email: s.sso_email && !looksLikeSecret(s.sso_email) ? s.sso_email : null,
        os: s.os,
        appVersion: s.app_version,
        country: s.country,
        city: s.city,
        region: s.region ?? null,
        lastSeen: s.last_seen,
        live: now - s.last_seen < ONLINE_MS,
        license: licenseLabel(s),
        approval: approvalOf(s)
      })),
    licenses: (() => {
      const rows = seats
        .slice()
        .sort((a, b) => b.last_seen - a.last_seen)
        .map((s) => ({
          device: s.device_id,
          hostname: s.hostname && !looksLikeSecret(s.hostname) ? s.hostname : null,
          email: s.sso_email && !looksLikeSecret(s.sso_email) ? s.sso_email : null,
          os: s.os,
          appVersion: s.app_version,
          license: licenseLabel(s),
          approval: approvalOf(s),
          lastSeen: s.last_seen,
          keysAuthorized: keysOn(s)
        }))
      return {
        empty: rows.length === 0,
        error: rows.length === 0 ? LICENSES_EMPTY : null,
        rows,
        issued: issued.map((r) => ({
          jti: r.jti,
          last4: r.last4,
          days: r.days,
          exp: r.exp,
          revoked: r.revoked,
          createdAt: r.created_at
        }))
      }
    })(),
    roi: {
      costToday,
      cost7d,
      liveSeats: live,
      seats30m: live30,
      cacheHit: sliceToday.hitRate == null ? null : `${Math.round(sliceToday.hitRate * 100)}%`,
      asksToday: todayAsks.length,
      licensed: seats.filter((s) => {
        const lic = (licenseLabel(s) || '').toLowerCase()
        return lic.includes('licensed') || lic === 'approved' || lic === 'trial' || lic === 'grace'
      }).length,
      approved: seats.filter((s) => isApprovedSeat(s)).length,
      timeSaved: formatSavedTime(timeSavedFromMeetings(recapMeetings(storedEvents)).savedMinutes),
      timeSavedSub: (() => {
        const n = recapMeetings(storedEvents).length
        return n ? `${n} recaps · estimate` : 'no recaps ingested'
      })(),
      value: costToday ?? cost7d ?? 'not reported',
      valueSub: costToday ? 'asks today · list price' : cost7d ? 'asks 7d · list price' : 'D1 asks · not reported',
      valueMinor:
        valueSettings.hourlyRate == null
          ? null
          : Math.round(
              (timeSavedFromMeetings(recapMeetings(storedEvents)).savedMinutes / 60) * valueSettings.hourlyRate * 100
            ),
      currency: valueSettings.currency,
      hourlyRate: valueSettings.hourlyRate,
      source: 'd1.asks+d1.seats',
      portalCf: portalPathSpend(weekAsks, 'portal-cf'),
      portalDirect: portalPathSpend(weekAsks, 'portal-direct')
    },
    gateway: {
      rows: (() => {
        const funded = new Set(vault.filter((v) => v.status === 'active').map((v) => v.provider))
        const by = new Map<string, { asks: number; tokens: number; anyTok: boolean; usd: number; anyCost: boolean }>()
        for (const a of weekAsks) {
          const provider = a.provider || 'unknown'
          const cur = by.get(provider) ?? { asks: 0, tokens: 0, anyTok: false, usd: 0, anyCost: false }
          cur.asks += 1
          const tok = (a.input_tokens ?? 0) + (a.output_tokens ?? 0) + (a.cache_read ?? 0) + (a.cache_write ?? 0)
          if (a.input_tokens != null || a.output_tokens != null || a.cache_read != null) {
            cur.tokens += tok
            cur.anyTok = true
          }
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
            cur.usd += est.usd
            cur.anyCost = true
          }
          by.set(provider, cur)
        }
        return [...by.entries()]
          .map(([provider, cur]) => ({
            provider,
            asks: cur.asks,
            tokens: cur.anyTok ? cur.tokens : null,
            estimate: cur.anyCost ? formatUsdEstimate(cur.usd) : null,
            funded: funded.has(provider)
          }))
          .sort((a, b) => b.asks - a.asks)
      })()
    },
    notices: buildNotices(seats, crm, proposals),
    keys: {
      ingestBound: keys.ingestBound,
      promptBound: keys.promptBound,
      skillBound: keys.skillBound,
      vaultBound: keys.vaultBound,
      oauthBound: keys.oauthBound,
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
    },
    geo: realtimeGeoRows(seats, sessions),
    geoRegions: geoRegionRows(seats),
    questions: buildQuestionsPayload(weekAsks)
  }
}

function buildQuestionsPayload(asks: AskRow[]): QuestionsPayload {
  const mix = aggregateQuestionTypes(asks.map((a) => a.question_type))
  const byModeInput = new Map<string, (string | null)[]>()
  for (const a of asks) {
    const mode = a.mode || 'unknown'
    const arr = byModeInput.get(mode) ?? []
    arr.push(a.question_type)
    byModeInput.set(mode, arr)
  }
  const byMode = [...byModeInput.entries()]
    .map(([mode, types]) => ({ mode, mix: aggregateQuestionTypes(types) }))
    .sort((a, b) => b.mix.total - a.mix.total || a.mode.localeCompare(b.mode))
  return { mix, byMode, coverage: mix.coverage }
}

/** Bounded, dependency-free notice builder shared by the full dashboard and the live poll snapshot. */
function buildNotices(
  seats: SeatRow[],
  crm: CrmSendRow[],
  proposals: ProposalRow[]
): DashboardPayload['notices'] {
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))
  return [
    ...seats
      .filter((s) => !isApprovedSeat(s))
      .map((s) => {
        const who = displayProfile(s)
        return {
          id: `seat-${s.device_id}`,
          kind: 'seat-pending',
          title: 'Seat waiting for approval',
          detail: [who.hostname, who.email, s.os].filter(Boolean).join(' · ') || s.device_id.slice(0, 8),
          ts: s.last_seen,
          profile: who.hostname || who.email,
          city: s.city && !looksLikeSecret(s.city) ? s.city : null,
          os: s.os || null
        }
      }),
    ...crm
      .filter((r) => r.status === 'failed' || r.status === 'expired')
      .map((r) => {
        const who = displayProfile(seatsById.get(r.device_id))
        const seat = seatsById.get(r.device_id)
        return {
          id: `crm-${r.id}`,
          kind: 'crm-failed',
          title: `${r.connector} push ${r.status}`,
          detail: r.last_error && !looksLikeSecret(r.last_error) ? r.last_error : r.title,
          ts: r.ts,
          profile: who.hostname || who.email,
          city: seat?.city && !looksLikeSecret(seat.city) ? seat.city : null,
          os: seat?.os || null
        }
      }),
    ...proposals
      .filter((p) => p.status === 'pending')
      .map((p) => ({
        id: `skill-${p.id}`,
        kind: 'skill-pending',
        title: 'Skill diff pending',
        detail: `${p.skill_id} ${p.from_version}`,
        ts: p.created_at,
        profile: p.created_by && !looksLikeSecret(p.created_by) ? p.created_by : null,
        city: null,
        os: null
      }))
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 80)
}

export interface LiveSeatRow {
  deviceId: string
  hostname: string | null
  email: string | null
  city: string | null
  country: string | null
  os: string
  appVersion: string
  licenseTier: string | null
  sessionStarted: number | null
  durationMs: number | null
  eventsThisSession: number | null
  asksThisSession: number | null
  live: boolean
}

export interface LiveSnapshot {
  now: number
  /** Cheap change-detection number for the poller: identical inputs always hash to the same value. */
  generation: number
  liveSeats: number
  seats30m: number
  events: ConsoleEvent[]
  notices: number
  kpis: {
    live: number
    dau: number
    asksToday: number
    costToday: string | null
    cacheHit: string | null
  }
  geo: RealtimeGeoRow[]
  liveSeatsTable: LiveSeatRow[]
  /** Rail badge counts (task B7). Seats whose approval is `pending` (fleet.ts `approvalOf`). */
  pendingApprovals: number
  /** Notices with `ts` newer than the `since` query param the route was called with; every notice
   *  when `since` is absent (task B7). */
  unseenNotices: number
  /** Integrations whose last stored probe result was `ok: false` and whose `status` is still
   *  `active` (task B7; same derivation as `routes/integrations.ts`'s `deriveHealth`, kept local
   *  here since that function is not exported). */
  failingConnectors: number
  /** Issued, non-revoked licenses expiring within the next 7 days (task B7). `exp` is UNIX seconds
   *  (see `fleet.ts` `issuedLicenseActive`), so the comparison multiplies by 1000. */
  expiringLicenses7d: number
  /** `max(updated_at)` over `operator_settings` (task B6), so the rail/Settings client can tell a
   *  setting changed without polling `settings.json` separately. 0 when nothing has ever been set
   *  or when the caller has no D1 to read (tests, `memoryStore()`). */
  settingsVersion: number
}

/** FNV-1a over a compact JSON summary. Not cryptographic: only used so the poller can skip a re-render
 *  when nothing meaningful changed between two snapshots (plan D4). */
function hashSnapshot(value: unknown): number {
  const s = JSON.stringify(value)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface LiveSnapshotOpts {
  /** Rail search's "unseen since" cursor (task B7): notices newer than this count toward
   *  `unseenNotices`; omitted means every notice counts. */
  since?: number
  /** `operator_settings` `max(updated_at)` (task B6), read from D1 by `routes/live.ts` (this module
   *  never touches D1 directly) and threaded through so it lands in `generation`'s hash too. */
  settingsVersion?: number
}

const SEVEN_DAYS_MS = 7 * DAY

/** Same derivation as `routes/integrations.ts`'s private `deriveHealth`: `failing` only once a probe
 *  has actually run and its stored result says `ok: false`. Duplicated (not imported) because that
 *  function is not exported and `routes/integrations.ts` is out of scope for this task; kept to the
 *  same three lines so it cannot drift in any way that matters. */
function isFailingConnector(row: IntegrationRow): boolean {
  if (row.status !== 'active') return false
  const extra = readIntegrationExtra(row as unknown as Record<string, unknown>)
  if (!extra.last_test_json || extra.last_test_at == null) return false
  try {
    const parsed = JSON.parse(extra.last_test_json) as { ok?: unknown }
    return parsed?.ok !== true
  } catch {
    return true
  }
}

function isExpiringSoon(row: IssuedLicenseRow, now: number): boolean {
  if (row.revoked) return false
  const expMs = row.exp * 1000
  return expMs > now && expMs <= now + SEVEN_DAYS_MS
}

/**
 * Compact snapshot for `GET /v1/admin/live.json`: every read here is bounded (fixed limits, a fixed
 * lookback window), so polling every 5 s never scales with total fleet history. No prompt text, no
 * secrets: only the fields the Realtime/Overview live strip needs.
 */
export async function buildLiveSnapshot(store: OperatorStore, now: number, opts: LiveSnapshotOpts = {}): Promise<LiveSnapshot> {
  const [seatsRaw, sessionsPage, eventsRaw, todayAsksRaw, crmRaw, proposals, integrations, issuedLicenses] = await Promise.all([
    store.listSeats(),
    store.listSessions({ since: now - DAY, limit: 500 }),
    store.listEvents(40),
    store.listAsks(500, now - DAY),
    store.listCrm(50),
    store.listProposals(50),
    store.listIntegrationRows(),
    store.listIssuedLicenses()
  ])
  const events = eventsRaw.map(projectEventTelemetry)
  const todayAsks = todayAsksRaw.map(projectAskTelemetry)
  const crm = crmRaw.map(normalizeCrmRow)
  const seats = seatsRaw.filter(isRealSeat)
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))
  const liveSeats = seats.filter((s) => now - s.last_seen < ONLINE_MS)
  const live30 = seats.filter((s) => now - s.last_seen < 30 * 60 * 1000).length
  const dau = uniqueSeats(seats, now - DAY)
  const sliceToday = aggregateCacheSlice(todayAsks.map(askLine))
  const costToday = costForAsks(todayAsks)

  const openSessionByDevice = new Map<string, SessionRow>()
  for (const s of sessionsPage.rows) {
    if (s.ended_at != null) continue
    const cur = openSessionByDevice.get(s.device_id)
    if (!cur || s.started_at > cur.started_at) openSessionByDevice.set(s.device_id, s)
  }

  const liveSeatsTable: LiveSeatRow[] = liveSeats
    .slice()
    .sort((a, b) => b.last_seen - a.last_seen)
    .map((s) => {
      const session = openSessionByDevice.get(s.device_id) ?? null
      const who = displayProfile(s)
      return {
        deviceId: s.device_id,
        hostname: who.hostname,
        email: who.email,
        city: s.city && !looksLikeSecret(s.city) ? s.city : null,
        country: s.country,
        os: s.os,
        appVersion: s.app_version,
        licenseTier: s.license && !looksLikeSecret(s.license) ? s.license : null,
        sessionStarted: session?.started_at ?? null,
        durationMs: session ? Math.max(0, now - session.started_at) : null,
        eventsThisSession: session?.pulses ?? null,
        asksThisSession: session?.asks ?? null,
        live: true
      }
    })

  const notices = buildNotices(seats, crm, proposals)
  const eventsOut = events.map((e) => eventFromStored(e, seatsById))
  const geo = realtimeGeoRows(seats, sessionsPage.rows)

  const pendingApprovals = seats.filter((s) => approvalOf(s) === 'pending').length
  const unseenNotices = opts.since == null ? notices.length : notices.filter((n) => n.ts > opts.since!).length
  const failingConnectors = integrations.filter(isFailingConnector).length
  const expiringLicenses7d = issuedLicenses.filter((l) => isExpiringSoon(l, now)).length
  const settingsVersion = opts.settingsVersion ?? 0

  const snapshot = {
    now,
    liveSeats: liveSeats.length,
    seats30m: live30,
    events: eventsOut,
    notices: notices.length,
    kpis: {
      live: liveSeats.length,
      dau,
      asksToday: todayAsks.length,
      costToday,
      cacheHit: sliceToday.hitRate == null ? null : `${Math.round(sliceToday.hitRate * 100)}%`
    },
    geo,
    liveSeatsTable,
    pendingApprovals,
    unseenNotices,
    failingConnectors,
    expiringLicenses7d,
    settingsVersion
  }
  return { ...snapshot, generation: hashSnapshot(snapshot) }
}
