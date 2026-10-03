import { formatSavedTime, timeSavedFromMeetings } from '../../../src/shared/time-saved'
import { estimateCacheCost, formatUsdEstimate, type AskLogLine } from '../../../src/shared/operator'
import { type CloudflareOverview } from '../cloudflare'
import { approvalOf, isApprovedSeat, LICENSES_EMPTY } from '../fleet'
import { looksLikeSecret } from '../redact'
import type { AskRow, EventRow, IssuedLicenseRow, SeatRow, VaultKeyMeta } from '../store'
import type { DashboardKeyFlags, DashboardPayload, DashboardValueSettings } from '../dashboard'
import { recapMeetings } from './shared'
import { portalPathSpend } from './cost'

export function buildLicensesSlice(args: {
  seats: SeatRow[]
  issued: IssuedLicenseRow[]
  licenseLabel: (seat: SeatRow) => string | null
  keysOn: (seat: SeatRow) => boolean
}): DashboardPayload['licenses'] {
  const { seats, issued, licenseLabel, keysOn } = args
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
}

export function buildRoiSlice(args: {
  costToday: string | null
  cost7d: string | null
  live: number
  live30: number
  cacheHit: string | null
  todayAsks: AskRow[]
  seats: SeatRow[]
  storedEvents: EventRow[]
  valueSettings: DashboardValueSettings
  weekAsks: AskRow[]
  licenseLabel: (seat: SeatRow) => string | null
}): DashboardPayload['roi'] {
  const { costToday, cost7d, live, live30, cacheHit, todayAsks, seats, storedEvents, valueSettings, weekAsks, licenseLabel } = args
  const meetings = recapMeetings(storedEvents)
  return {
    costToday,
    cost7d,
    liveSeats: live,
    seats30m: live30,
    cacheHit,
    asksToday: todayAsks.length,
    licensed: seats.filter((s) => {
      const lic = (licenseLabel(s) || '').toLowerCase()
      return lic.includes('licensed') || lic === 'approved' || lic === 'trial' || lic === 'grace'
    }).length,
    approved: seats.filter((s) => isApprovedSeat(s)).length,
    timeSaved: meetings.length ? formatSavedTime(timeSavedFromMeetings(meetings).savedMinutes) : 'not reported',
    timeSavedSub: meetings.length ? `${meetings.length} recaps · estimate` : 'no recaps ingested',
    value: costToday ?? cost7d ?? 'not reported',
    valueSub: costToday ? 'asks today · list price' : cost7d ? 'asks 7d · list price' : 'D1 asks · not reported',
    valueMinor:
      valueSettings.hourlyRate == null
        ? null
        : Math.round((timeSavedFromMeetings(meetings).savedMinutes / 60) * valueSettings.hourlyRate * 100),
    currency: valueSettings.currency,
    hourlyRate: valueSettings.hourlyRate,
    source: 'd1.asks+d1.seats',
    portalCf: portalPathSpend(weekAsks, 'portal-cf'),
    portalDirect: portalPathSpend(weekAsks, 'portal-direct')
  }
}

export function buildGatewaySlice(weekAsks: AskRow[], vault: VaultKeyMeta[]): DashboardPayload['gateway'] {
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
  return {
    rows: [...by.entries()]
      .map(([provider, cur]) => ({
        provider,
        asks: cur.asks,
        tokens: cur.anyTok ? cur.tokens : null,
        estimate: cur.anyCost ? formatUsdEstimate(cur.usd) : null,
        funded: funded.has(provider)
      }))
      .sort((a, b) => b.asks - a.asks)
  }
}

export function sanitizeVaultMeta(v: VaultKeyMeta): VaultKeyMeta {
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

export function buildKeysSlice(keys: DashboardKeyFlags, vault: VaultKeyMeta[]): DashboardPayload['keys'] {
  return {
    ingestBound: keys.ingestBound,
    promptBound: keys.promptBound,
    skillBound: keys.skillBound,
    vaultBound: keys.vaultBound,
    oauthBound: keys.oauthBound,
    vault: vault.map(sanitizeVaultMeta)
  }
}

export function buildCloudflareSlice(cloudflare: CloudflareOverview): DashboardPayload['cloudflare'] {
  return {
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
