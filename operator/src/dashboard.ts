import { aggregateCacheSlice } from '../../src/shared/operator'
import type { QuestionTypeMix } from '../../src/shared/question-type'
import { normalizeCrmRow, type CrmStatus } from './crm'
import { missingCloudflareOverview, type CloudflareOverview } from './cloudflare'
import {
  approvalOf,
  isApprovedSeat,
  issuedLicenseActive,
  isRealSeat,
  parseLicenseId,
  seatLicenseLabel,
  type SeatApproval
} from './fleet'
import { looksLikeSecret, type SafeChip } from './redact'
import { projectAskTelemetry, projectEventTelemetry } from './privacy'
import { geoRegionRows, realtimeGeoRows, type GeoRegionRow, type RealtimeGeoRow } from './realtime-geo'
import { readIntegrationExtra } from './connectors/data'
import {
  buildAsksSlice,
  buildEventsSlice,
  buildHeatmap,
  buildMapSlice,
  buildNotices,
  buildProfilesSlice,
  buildProposalsSlice
} from './dashboard/activity'
import { buildCostTable, buildTokenPoints, costForAsks } from './dashboard/cost'
import {
  buildCloudflareSlice,
  buildGatewaySlice,
  buildKeysSlice,
  buildLicensesSlice,
  buildRoiSlice
} from './dashboard/fleet'
import {
  askLine,
  buckets,
  buildSeries,
  DAY,
  displayProfile,
  eventFromStored,
  hitSeries,
  HOUR,
  mix,
  ONLINE_MS,
  uniqueSeats
} from './dashboard/shared'
import {
  buildCrmSlice,
  buildOverviewOps,
  crmFunnelByConnector,
  crmLandingKpis,
  emptyCrmLanding
} from './dashboard/overview'
import { buildQuestionsPayload } from './dashboard/questions'
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

export { ONLINE_MS, crmFunnelByConnector, crmLandingKpis, emptyCrmLanding }

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
  /** Asks in the 7d window with at least one reported token field (COST_METERING completeness). */
  asksWithTokens: number
  /** Asks in the 7d window with no token fields — unknown, never treated as 0 tokens. */
  asksMissingTokens: number
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
    /** Law 3 (plan 3.7b): time saved x the hourly rate the owner sets in Settings -> Value, in integer
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
  modelPolicy: DashboardModelPolicy
}

/** M2-0412: the fleet model policy slice for the Models page. `isOwner` gates the edit form
 *  (every admin can read; only the configured owner can change it) — computed by the caller
 *  (route handler) via `isOwnerEmail`, same convention as `keys`/`cloudflare`/`valueSettings`
 *  above: `buildDashboard` never reaches into `ctx.env` itself. */
export interface DashboardModelPolicy {
  policy: import('../../src/shared/model-policy').ModelPolicyDocument | null
  isOwner: boolean
  history: { ts: number; actor: string; action: string; detail: string }[]
}
type DashboardModelPolicyInput = Pick<DashboardModelPolicy, 'policy' | 'isOwner'>
const NO_MODEL_POLICY: DashboardModelPolicyInput = { policy: null, isOwner: false }

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

/** Just the fields `roi`'s Value law (3.7b law 3) needs. Owned by `./routes/settings-store.ts` (task
 *  B6); passed in explicitly rather than read here so `dashboard.ts` never touches D1 directly.
 *  `hourlyRate: null` (the default when the caller has nothing to pass) means "not set" - `roi`
 *  must never invent a rate. */
export interface DashboardValueSettings {
  hourlyRate: number | null
  currency: string
}

const NO_VALUE_SETTINGS: DashboardValueSettings = { hourlyRate: null, currency: 'USD' }
const NO_KEY_FLAGS: DashboardKeyFlags = {
  ingestBound: false,
  promptBound: false,
  skillBound: false,
  vaultBound: false,
  oauthBound: false
}

async function readDashboardRows(store: OperatorStore, now: number) {
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
  return {
    seats: seatsRaw.filter(isRealSeat),
    asks: asksRaw.map(projectAskTelemetry),
    pulses,
    proposals,
    audit,
    crm: crmRaw.map(normalizeCrmRow),
    packs,
    storedEvents: storedEventsRaw.map(projectEventTelemetry),
    vault,
    issued,
    sessions: sessionsPage.rows
  }
}

type DashboardRows = Awaited<ReturnType<typeof readDashboardRows>>

function latestSeatIndexAt(seats: SeatRow[]): number | null {
  return seats.reduce<number | null>((acc, s) => {
    if (s.last_index_at == null) return acc
    return acc == null ? s.last_index_at : Math.max(acc, s.last_index_at)
  }, null)
}

function buildSeatAccess(issued: IssuedLicenseRow[], now: number) {
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
  return { licenseLabel, keysOn }
}

function buildDashboardMetrics(rows: DashboardRows, now: number) {
  const live = rows.seats.filter((s) => now - s.last_seen < ONLINE_MS).length
  const live30 = rows.seats.filter((s) => now - s.last_seen < 30 * 60 * 1000).length
  const hourStarts = buckets(now, 24, HOUR)
  const dayStarts = buckets(now, 7, DAY)
  const series = buildSeries({ now, hourStarts, dayStarts, pulses: rows.pulses })
  const todayAsks = rows.asks.filter((a) => a.ts >= now - DAY)
  const weekAsks = rows.asks.filter((a) => a.ts >= now - 7 * DAY)
  const hitRate = aggregateCacheSlice(todayAsks.map(askLine)).hitRate
  const tokens = buildTokenPoints(rows.asks, hourStarts)
  return {
    live,
    live30,
    dau: uniqueSeats(rows.seats, now - DAY),
    wau: uniqueSeats(rows.seats, now - 7 * DAY),
    versions: new Set(rows.seats.map((s) => s.app_version).filter(Boolean)).size,
    pendingDiffs: rows.proposals.filter((p) => p.status === 'pending').length,
    lastIndexAt: latestSeatIndexAt(rows.seats),
    hourStarts,
    dayStarts,
    hours24: series.hours24,
    days7: series.days7,
    todayAsks,
    weekAsks,
    cacheHit: hitRate == null ? null : `${Math.round(hitRate * 100)}%`,
    costToday: costForAsks(todayAsks),
    cost7d: costForAsks(weekAsks),
    tokens,
    table: buildCostTable(weekAsks)
  }
}

type DashboardMetrics = ReturnType<typeof buildDashboardMetrics>

function buildDashboardKpis(metrics: DashboardMetrics, asks: AskRow[]): DashboardPayload['kpis'] {
  return {
    live: metrics.live,
    dau: metrics.dau,
    wau: metrics.wau,
    versions: metrics.versions,
    cacheHit: metrics.cacheHit,
    costToday: metrics.costToday,
    cost7d: metrics.cost7d,
    pendingDiffs: metrics.pendingDiffs,
    lastIndexAt: metrics.lastIndexAt,
    liveSeries: metrics.hours24.map((p) => p.heartbeats),
    dauSeries: metrics.days7.map((p) => p.heartbeats),
    costSeries: metrics.tokens.map((p) => p.read + p.write + p.uncached),
    hitSeries: hitSeries(asks, metrics.hourStarts)
  }
}

function buildDashboardOpsSlice(now: number, metrics: DashboardMetrics, rows: DashboardRows, crmSlice: DashboardPayload['crm']): DashboardPayload['ops'] {
  return buildOverviewOps({
    now,
    wau: metrics.wau,
    dau: metrics.dau,
    live: metrics.live,
    live30: metrics.live30,
    hourStarts: metrics.hourStarts,
    dayStarts: metrics.dayStarts,
    hours24: metrics.hours24,
    pulses: rows.pulses,
    weekAsks: metrics.weekAsks,
    storedEvents: rows.storedEvents,
    crmFailRate: crmSlice.landing.failRatePct,
    vault: rows.vault
  })
}

function buildDashboardScale(metrics: DashboardMetrics, seats: SeatRow[]): DashboardPayload['scale'] {
  return {
    hours24: metrics.hours24,
    days7: metrics.days7,
    versions: mix(seats.map((s) => s.app_version)),
    os: mix(seats.map((s) => s.os))
  }
}

function buildDashboardChange(rows: DashboardRows, heatmap: number[]): DashboardPayload['change'] {
  return {
    timeline: rows.audit.map((a) => ({ ts: a.ts, actor: a.actor, action: a.action, detail: a.detail })),
    heatmap,
    adoption: mix(rows.seats.map((s) => s.app_version))
  }
}

function buildDashboardRoi(
  metrics: DashboardMetrics,
  rows: DashboardRows,
  valueSettings: DashboardValueSettings,
  licenseLabel: (seat: SeatRow) => string | null
): DashboardPayload['roi'] {
  return buildRoiSlice({
    costToday: metrics.costToday,
    cost7d: metrics.cost7d,
    live: metrics.live,
    live30: metrics.live30,
    cacheHit: metrics.cacheHit,
    todayAsks: metrics.todayAsks,
    seats: rows.seats,
    storedEvents: rows.storedEvents,
    valueSettings,
    weekAsks: metrics.weekAsks,
    licenseLabel
  })
}

function buildDashboardModelPolicy(modelPolicy: DashboardModelPolicyInput, rows: DashboardRows): DashboardPayload['modelPolicy'] {
  return {
    ...modelPolicy,
    history: rows.audit
      .filter((a) => a.action.startsWith('model-policy.'))
      .map((a) => ({ ts: a.ts, actor: a.actor, action: a.action, detail: a.detail }))
  }
}

export async function buildDashboard(
  store: OperatorStore,
  email: string,
  now: number,
  keys: DashboardKeyFlags = NO_KEY_FLAGS,
  cloudflare: CloudflareOverview = missingCloudflareOverview(),
  valueSettings: DashboardValueSettings = NO_VALUE_SETTINGS,
  modelPolicy: DashboardModelPolicyInput = NO_MODEL_POLICY
): Promise<DashboardPayload> {
  const rows = await readDashboardRows(store, now)
  const metrics = buildDashboardMetrics(rows, now)
  const seatsById = new Map(rows.seats.map((s) => [s.device_id, s]))
  const { licenseLabel, keysOn } = buildSeatAccess(rows.issued, now)
  const map = buildMapSlice(rows.seats)
  const heatmap = buildHeatmap({ now, audit: rows.audit, packs: rows.packs, proposals: rows.proposals })
  const crmSlice = buildCrmSlice(rows.crm, now)

  return {
    email,
    now,
    kpis: buildDashboardKpis(metrics, rows.asks),
    ops: buildDashboardOpsSlice(now, metrics, rows, crmSlice),
    scale: buildDashboardScale(metrics, rows.seats),
    cost: { tokens: metrics.tokens, table: metrics.table },
    change: buildDashboardChange(rows, heatmap),
    map,
    asks: buildAsksSlice(rows.asks),
    proposals: buildProposalsSlice(rows.proposals),
    crm: crmSlice,
    events: buildEventsSlice({ storedEvents: rows.storedEvents, asks: rows.asks, crm: rows.crm, seatsById }),
    profiles: buildProfilesSlice({ seats: rows.seats, now, licenseLabel, onlineMs: ONLINE_MS }),
    licenses: buildLicensesSlice({ seats: rows.seats, issued: rows.issued, licenseLabel, keysOn }),
    roi: buildDashboardRoi(metrics, rows, valueSettings, licenseLabel),
    gateway: buildGatewaySlice(metrics.weekAsks, rows.vault),
    notices: buildNotices(rows.seats, rows.crm, rows.proposals),
    keys: buildKeysSlice(keys, rows.vault),
    cloudflare: buildCloudflareSlice(cloudflare),
    geo: realtimeGeoRows(rows.seats, rows.sessions),
    geoRegions: geoRegionRows(rows.seats),
    questions: buildQuestionsPayload(metrics.weekAsks),
    modelPolicy: buildDashboardModelPolicy(modelPolicy, rows)
  }
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
  const rows = await readLiveSnapshotRows(store, now)
  const { seats, sessions, events, todayAsks, crm, proposals, integrations, issuedLicenses } = rows
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))
  const liveSeats = seats.filter((s) => now - s.last_seen < ONLINE_MS)
  const live30 = seats.filter((s) => now - s.last_seen < 30 * 60 * 1000).length
  const dau = uniqueSeats(seats, now - DAY)
  const sliceToday = aggregateCacheSlice(todayAsks.map(askLine))
  const costToday = costForAsks(todayAsks)
  const notices = buildNotices(seats, crm, proposals)
  const eventsOut = events.map((e) => eventFromStored(e, seatsById))
  const geo = realtimeGeoRows(seats, sessions)

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
    liveSeatsTable: liveSeatRows(seats, sessions, now),
    pendingApprovals,
    unseenNotices,
    failingConnectors,
    expiringLicenses7d,
    settingsVersion
  }
  return { ...snapshot, generation: hashSnapshot(snapshot) }
}

interface LiveSnapshotRows {
  seats: SeatRow[]
  sessions: SessionRow[]
  events: EventRow[]
  todayAsks: AskRow[]
  crm: ReturnType<typeof normalizeCrmRow>[]
  proposals: ProposalRow[]
  integrations: IntegrationRow[]
  issuedLicenses: IssuedLicenseRow[]
}

async function readLiveSnapshotRows(store: OperatorStore, now: number): Promise<LiveSnapshotRows> {
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
  return {
    seats: seatsRaw.filter(isRealSeat),
    sessions: sessionsPage.rows,
    events: eventsRaw.map(projectEventTelemetry),
    todayAsks: todayAsksRaw.map(projectAskTelemetry),
    crm: crmRaw.map(normalizeCrmRow),
    proposals,
    integrations,
    issuedLicenses
  }
}

function openSessionsByDevice(sessions: SessionRow[]): Map<string, SessionRow> {
  const openSessionByDevice = new Map<string, SessionRow>()
  for (const s of sessions) {
    if (s.ended_at != null) continue
    const cur = openSessionByDevice.get(s.device_id)
    if (!cur || s.started_at > cur.started_at) openSessionByDevice.set(s.device_id, s)
  }
  return openSessionByDevice
}

function liveSeatRows(seats: SeatRow[], sessions: SessionRow[], now: number): LiveSeatRow[] {
  const openSessionByDevice = openSessionsByDevice(sessions)
  return seats
    .filter((s) => now - s.last_seen < ONLINE_MS)
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
}
