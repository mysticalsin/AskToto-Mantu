import { timeSavedFromMeetings } from '../../../src/shared/time-saved'
import { CRM_STATUSES, type CrmSendRow, type CrmStatus } from '../crm'
import type { AskRow, EventRow, PulseRow, VaultKeyMeta } from '../store'
import type { CrmFunnelByConnector, CrmLanding, DashboardOps, SeriesPoint } from '../dashboard'
import {
  askTokenTotal,
  averageDurationMs,
  CLI_ASK_PROVIDERS,
  countPerBucket,
  DAY,
  HOUR,
  listenMinutesReported,
  recapMeetings,
  savedMinutes,
  startOfUtcDay,
  tokensReported,
  uniqueDevicesPerBucket
} from './shared'
import { portalPathSpend } from './cost'

export function emptyCrmLanding(): CrmLanding {
  return { landedToday: 0, failRatePct: null, retries: 0, deadLetters: 0 }
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
    const cur = by.get(connector) ?? { connector, attempted: 0, submitted: 0, success: 0, failed: 0 }
    if (row.status !== 'pending') cur.attempted += 1
    if (row.status === 'submitted' || row.status === 'in_review' || row.status === 'success') cur.submitted += 1
    if (row.status === 'success') cur.success += 1
    if (row.status === 'failed' || row.status === 'expired') cur.failed += 1
    by.set(connector, cur)
  }
  return [...by.values()].sort((a, b) => b.attempted - a.attempted || a.connector.localeCompare(b.connector))
}

export function buildOverviewOps(args: {
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
  const fundedProviders = new Set(vault.filter((v) => v.status === 'active').map((v) => v.provider))
  let cliAsks = 0
  let operatorAsks = 0
  let asksWithTokens = 0
  let asksMissingTokens = 0
  for (const a of weekAsks) {
    const provider = a.provider || ''
    if (!CLI_ASK_PROVIDERS.has(provider) && fundedProviders.has(provider)) operatorAsks++
    else cliAsks++
    if (askTokenTotal(a) == null) asksMissingTokens++
    else asksWithTokens++
  }
  return {
    uniqueSessions: wau,
    uniqueSeries: dailyUnique,
    sessionsDay: dau,
    sessionsDaySeries: dailyUnique,
    liveNow: live,
    liveSeries: hours24.map((p) => p.heartbeats),
    live30,
    timeSaved: savedMinutes(storedEvents),
    tokens: tokensReported(weekAsks),
    tokenSeries: tokenSeriesByHour(weekAsks, hourStarts, now),
    apiCalls: weekAsks.length,
    apiSeries: hours24.map((p) => p.asks),
    listenMinutes: listenMinutesReported(storedEvents),
    recapCount: storedEvents.filter((e) => e.kind === 'recap').length,
    recapSeries: countPerBucket(storedEvents, 'recap', dayStarts, DAY, now),
    cliAsks,
    operatorAsks,
    portalCf: portalPathSpend(weekAsks, 'portal-cf'),
    portalDirect: portalPathSpend(weekAsks, 'portal-direct'),
    crmFailRate,
    durationMs: averageDurationMs(weekAsks),
    meetings: storedEvents.filter((e) => e.kind === 'recap').length,
    asksWithTokens,
    asksMissingTokens
  }
}

export function buildCrmSlice(rows: CrmSendRow[], now: number) {
  const counts = Object.fromEntries(CRM_STATUSES.map((s) => [s, 0])) as Record<CrmStatus, number>
  for (const row of rows) counts[row.status]++
  return {
    counts,
    landing: crmLandingKpis(rows, now),
    funnel: crmFunnelByConnector(rows),
    rows: rows.map((r) => ({
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
  }
}

export function formattedSavedTime(events: EventRow[], formatter: (minutes: number) => string): string {
  const meetings = recapMeetings(events)
  return meetings.length ? formatter(timeSavedFromMeetings(meetings).savedMinutes) : 'not reported'
}

function tokenSeriesByHour(weekAsks: AskRow[], hourStarts: number[], now: number): number[] {
  return hourStarts.map((t, i) => {
    const end = i === hourStarts.length - 1 ? now + 1 : t + HOUR
    let total = 0
    for (const a of weekAsks) {
      if (a.ts < t || a.ts >= end) continue
      total += askTokenTotal(a) ?? 0
    }
    return total
  })
}
