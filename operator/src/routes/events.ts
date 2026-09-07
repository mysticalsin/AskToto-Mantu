/**
 * `GET /v1/admin/events.json` (plan section 9c "Events"): validated, paginated, kind-filterable
 * event rows shaped for the console table, with per-kind counts for the resolved range. Filtering by
 * `os`/`version`/`country`/`q`/`device`/`kinds` happens inside `OperatorStore#listEvents`'s bounded
 * query; this module only validates query params, resolves range presets, and joins the seat fields
 * the UI needs (hostname, email, os, appVersion), one `getSeat` per distinct device in the page.
 *
 * `GET /v1/admin/events-stats.json` (plan 6.4 Stats tab, P1.3 brief): the same range/filters as the
 * table above -- "no second set of controls" -- aggregated into the breakdowns the Stats tab shows
 * (event kinds, ask question types, providers, models, OS, client version, and a small bucketed
 * series). Deliberately its own route rather than reusing `/v1/admin/questions.json` (B5, owned by
 * dev-settings): that route is fixed to a `range=24h|7d|30d` week-ish window for Settings and is
 * never filtered by kind/os/country/version/q, so it cannot honestly answer "what does the Events
 * table's current filter set add up to." Reuses the exact same `aggregateQuestionTypes()` math
 * Settings uses (src/shared/question-type.ts) so the two pages never disagree about what a
 * question type mix means, without depending on insights.ts's own route module.
 */
import { aggregateQuestionTypes } from '../../../src/shared/question-type'
import { json } from '../http'
import { looksLikeSecret } from '../redact'
import type { AskRow, EventRow, EventsQueryOpts, SeatRow } from '../store'
import { defineRoute } from './registry'
import type { AdminCtx } from './admin-ctx'
import { profileOf, safeCity, seatCache } from './seat-view'

export const KNOWN_EVENT_KINDS = [
  'heartbeat',
  'ask',
  'recap',
  'listen',
  'rating',
  'crm',
  'vault',
  'license',
  'seat',
  'use',
  'platform'
] as const

const RANGE_PRESET_MS: Record<string, number> = {
  '30m': 30 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

const DEFAULT_RANGE_MS = RANGE_PRESET_MS['24h']
const DEFAULT_LIMIT = 50
const MIN_LIMIT = 1
const MAX_LIMIT = 200

export function parseLimit(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || raw == null || raw === '') return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(n)))
}

export function parseEpoch(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export function parseKinds(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const known = new Set<string>(KNOWN_EVENT_KINDS)
  const kinds = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => known.has(k))
  return kinds.length ? kinds : undefined
}

export interface ResolvedRange {
  since: number
  until: number
}

/** `range=30m|24h|7d|30d` resolves server-side to `{ since: now - window, until: now }` and takes
 *  precedence over explicit `since`/`until`. With no `range` and no explicit bounds, defaults to the
 *  last 24 h (the console's default filter). */
export function resolveRange(params: URLSearchParams, now: number): ResolvedRange {
  const range = params.get('range')
  if (range && RANGE_PRESET_MS[range] != null) {
    return { since: now - RANGE_PRESET_MS[range], until: now }
  }
  const since = parseEpoch(params.get('since'))
  const until = parseEpoch(params.get('until'))
  if (since == null && until == null) return { since: now - DEFAULT_RANGE_MS, until: now }
  return { since: since ?? now - DEFAULT_RANGE_MS, until: until ?? now }
}

export function parseEventsQuery(url: URL, now: number): EventsQueryOpts & ResolvedRange {
  const params = url.searchParams
  const { since, until } = resolveRange(params, now)
  return {
    since,
    until,
    kinds: parseKinds(params.get('kinds')),
    deviceId: params.get('device')?.trim() || undefined,
    country: params.get('country')?.trim() || undefined,
    os: params.get('os')?.trim() || undefined,
    version: params.get('version')?.trim() || undefined,
    q: params.get('q')?.trim() || undefined,
    cursor: params.get('cursor')?.trim() || undefined,
    limit: parseLimit(params.get('limit'))
  }
}

export interface EventListRow {
  id: string
  ts: number
  kind: string
  actor: string | null
  deviceId: string | null
  hostname: string | null
  email: string | null
  country: string | null
  city: string | null
  os: string | null
  appVersion: string | null
  detail: string | null
  /** Name cell (plan 6.4): the ask's question type, joined from `asks` by (ts, device_id) --
   *  there is no shared id between an `events` row and its `asks` row (see the ask-trace doc
   *  comment in operator/src/render/pages/events.ts). null for every non-ask row, and for an ask
   *  row whose match fell outside ASK_JOIN_WINDOW (the same "most recent N asks" limitation the
   *  drawer's own ask-trace lookup already accepts). Never the question text. */
  questionType: string | null
}

/** How many of the most recent asks (by `since`) this route joins against for `questionType` --
 *  bounded the same way the client's own ask-trace cache is (operator/client/pages/events.ts's
 *  ASK_CACHE_TTL_MS comment: "appears once the ask is within the most recent 100"), so a very old
 *  ask row on a wide range can read a blank question type rather than this route doing an
 *  unbounded scan of every ask ever recorded. */
const ASK_JOIN_WINDOW = 500

/** Same (ts, device_id-prefix) join `operator/src/render/pages/events.ts`'s `findAskTrace()`
 *  uses -- duplicated rather than imported because routes/ never depends on render/ (see that
 *  file's own doc comment: "this render module never depends on the routes layer" -- true in
 *  both directions in this codebase). */
function questionTypeFor(e: Pick<EventRow, 'ts' | 'device_id'>, asks: Pick<AskRow, 'ts' | 'device_id' | 'question_type'>[]): string | null {
  if (!e.device_id) return null
  const deviceId = e.device_id
  const hit = asks.find((a) => a.ts === e.ts && (a.device_id === deviceId || a.device_id.startsWith(deviceId) || deviceId.startsWith(a.device_id)))
  return hit?.question_type ?? null
}

export function registerEventsRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/events.json',
    auth: 'admin',
    handler: async (_request, ctx) => {
      const query = parseEventsQuery(ctx.url, ctx.now)
      const [page, counts, asksForJoin] = await Promise.all([
        ctx.store.listEvents(query.limit ?? DEFAULT_LIMIT, query),
        ctx.store.countEventsByKind(query.since, query.until),
        ctx.store.listAsks(ASK_JOIN_WINDOW, query.since)
      ])
      const getSeat = seatCache(ctx.store)
      const rows: EventListRow[] = await Promise.all(
        page.rows.map(async (e) => {
          const seat = e.device_id ? await getSeat(e.device_id) : null
          const who = profileOf(seat)
          return {
            id: e.id,
            ts: e.ts,
            kind: e.kind,
            actor: who.email || (e.actor && !looksLikeSecret(e.actor) ? e.actor : null),
            deviceId: e.device_id,
            hostname: who.hostname,
            email: who.email,
            country: e.country || seat?.country || null,
            city: safeCity(seat),
            os: seat?.os || null,
            appVersion: seat?.app_version || null,
            detail: e.detail,
            questionType: e.kind === 'ask' ? questionTypeFor(e, asksForJoin) : null
          }
        })
      )
      return json({ ok: true, rows, nextCursor: page.nextCursor, counts, range: { since: query.since, until: query.until } })
    }
  })

  registerEventsStatsRoute()
}

// ---------------------------------------------------------------------------------------------
// GET /v1/admin/events-stats.json (plan 6.4 Stats tab) -- see file header doc comment.
// ---------------------------------------------------------------------------------------------

/** Cap on how many matching `events` rows one stats request aggregates over. Generous for this
 *  product's real scale (an internal fleet console, not a high-traffic analytics product) while
 *  keeping a worst case (a wide range with no filters on a fleet that has been running for
 *  months) bounded. `truncated` in the response says plainly when this cap was hit, so a number
 *  is never presented as complete when it is a sample (plan: "nothing is extrapolated"). */
const STATS_EVENTS_CAP = 2000
const STATS_ASKS_CAP = 3000

export interface EventsStatsCountRow {
  key: string
  count: number
}

export interface EventsStatsSeriesPoint {
  start: number
  count: number
}

export interface EventsStatsPayload {
  ok: true
  since: number
  until: number
  totalEvents: number
  /** True when the events sample hit STATS_EVENTS_CAP -- byKind/series reflect only the most
   *  recent STATS_EVENTS_CAP matching rows, not the full window, when this is true. */
  truncated: boolean
  byKind: EventsStatsCountRow[]
  /** False when the active kind filter excludes 'ask' outright -- the ask-derived breakdowns
   *  below are then always empty rather than silently ignoring that filter. */
  askKindIncluded: boolean
  askCount: number
  questionTypes: EventsStatsCountRow[]
  questionTypeCoverage: number | null
  providers: EventsStatsCountRow[]
  models: EventsStatsCountRow[]
  os: EventsStatsCountRow[]
  clientVersions: EventsStatsCountRow[]
  series: EventsStatsSeriesPoint[]
  seriesBucketMs: number
}

function countBy<T>(rows: T[], keyFn: (row: T) => string | null): EventsStatsCountRow[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = keyFn(row)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** Same normalization the Platform column uses (operator/src/render/icons.ts's platformMarkSvg
 *  callers) -- duplicated locally rather than imported for the same routes/render layering
 *  reason as questionTypeFor() above. */
function osLabelOf(os: string | null | undefined): string {
  const raw = String(os || '').trim().toLowerCase()
  if (raw === 'darwin' || raw === 'macos' || raw === 'mac') return 'macOS'
  if (raw === 'win' || raw === 'win32' || raw === 'windows') return 'Windows'
  if (raw === 'linux') return 'Linux'
  return os ? os : 'Unknown'
}

/** A small bucketed series "so a spike is visible before it is explained" (plan 6.4): hourly
 *  buckets (capped at 48) for a range spanning a day or less, daily buckets (capped at 31)
 *  otherwise -- genuinely per-day for the 7d/30d presets, still a meaningful shape for 30m/24h
 *  rather than one degenerate bar. */
function seriesBucketPlan(since: number, until: number): { bucketMs: number; count: number } {
  const DAY_MS = 24 * 60 * 60 * 1000
  const span = Math.max(1, until - since)
  if (span <= DAY_MS) {
    const bucketMs = Math.max(5 * 60 * 1000, Math.ceil(span / 24))
    return { bucketMs, count: Math.min(48, Math.max(1, Math.ceil(span / bucketMs))) }
  }
  return { bucketMs: DAY_MS, count: Math.min(31, Math.max(1, Math.ceil(span / DAY_MS))) }
}

function askMatchesStatsFilters(
  ask: AskRow,
  seat: SeatRow | null,
  query: { until: number; os?: string; version?: string; country?: string; q?: string }
): boolean {
  if (ask.ts > query.until) return false
  if (query.os && (seat?.os || '').toLowerCase() !== query.os.toLowerCase()) return false
  if (query.version && (seat?.app_version || '') !== query.version) return false
  if (query.country && (seat?.country || '').toUpperCase() !== query.country.toUpperCase()) return false
  if (query.q) {
    const q = query.q.toLowerCase()
    const haystack = [ask.mode, ask.provider, ask.model, ask.question_type, seat?.hostname, seat?.sso_email, seat?.os, seat?.app_version]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

export async function buildEventsStatsPayload(ctx: AdminCtx): Promise<EventsStatsPayload> {
  const query = parseEventsQuery(ctx.url, ctx.now)
  const getSeat = seatCache(ctx.store)

  const page = await ctx.store.listEvents(STATS_EVENTS_CAP, { ...query, limit: STATS_EVENTS_CAP, cursor: undefined })
  const rows = page.rows
  const truncated = rows.length >= STATS_EVENTS_CAP

  const byKind = countBy(rows, (e) => e.kind)

  const askKindIncluded = !query.kinds || query.kinds.includes('ask')
  let askCount = 0
  let questionTypes: EventsStatsCountRow[] = []
  let questionTypeCoverage: number | null = null
  let providers: EventsStatsCountRow[] = []
  let models: EventsStatsCountRow[] = []
  if (askKindIncluded) {
    const asksRaw = await ctx.store.listAsks(STATS_ASKS_CAP, query.since)
    const matched: AskRow[] = []
    for (const a of asksRaw) {
      const seat = a.device_id ? await getSeat(a.device_id) : null
      if (askMatchesStatsFilters(a, seat, query)) matched.push(a)
    }
    askCount = matched.length
    const mix = aggregateQuestionTypes(matched.map((a) => a.question_type))
    questionTypes = mix.bars.map((b) => ({ key: b.label, count: b.count }))
    questionTypeCoverage = mix.coverage
    providers = countBy(matched, (a) => a.provider)
    models = countBy(matched, (a) => (a.provider && a.model ? `${a.provider} / ${a.model}` : null))
  }

  const osLabels: string[] = []
  const versions: string[] = []
  const seatsSeen = new Set<string>()
  for (const e of rows) {
    if (!e.device_id || seatsSeen.has(e.device_id)) continue
    seatsSeen.add(e.device_id)
    const seat = await getSeat(e.device_id)
    if (seat?.os) osLabels.push(osLabelOf(seat.os))
    if (seat?.app_version) versions.push(seat.app_version)
  }
  const os = countBy(
    osLabels.map((label) => ({ label })),
    (r) => r.label
  )
  const clientVersions = countBy(
    versions.map((version) => ({ version })),
    (r) => r.version
  )

  const { bucketMs, count } = seriesBucketPlan(query.since, query.until)
  const seriesCounts = new Array<number>(count).fill(0)
  for (const e of rows) {
    // Math.min clamps a row landing exactly on `until` (an inclusive bound everywhere else this
    // route matches events -- see filterAndPageEvents/d1.ts's `e.ts <= until`) into the last
    // bucket instead of one-past-the-end, so the series always sums to `rows.length`.
    const idx = Math.min(count - 1, Math.max(0, Math.floor((e.ts - query.since) / bucketMs)))
    seriesCounts[idx] += 1
  }
  const series: EventsStatsSeriesPoint[] = seriesCounts.map((c, i) => ({ start: query.since + i * bucketMs, count: c }))

  return {
    ok: true,
    since: query.since,
    until: query.until,
    totalEvents: rows.length,
    truncated,
    byKind,
    askKindIncluded,
    askCount,
    questionTypes,
    questionTypeCoverage,
    providers,
    models,
    os,
    clientVersions,
    series,
    seriesBucketMs: bucketMs
  }
}

function registerEventsStatsRoute(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: '/v1/admin/events-stats.json',
    auth: 'admin',
    handler: async (_request, ctx) => json(await buildEventsStatsPayload(ctx))
  })
}
