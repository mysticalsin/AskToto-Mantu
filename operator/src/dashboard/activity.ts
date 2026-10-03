import { formatSavedTime, timeSavedFromMeetings } from '../../../src/shared/time-saved'
import { approvalOf, isApprovedSeat } from '../fleet'
import { looksLikeSecret } from '../redact'
import type { AskRow, AuditRow, EventRow, PackMeta, ProposalRow, SeatRow } from '../store'
import type { DashboardPayload, MapCountry, MapDot, ProfileRow } from '../dashboard'
import { DAY, displayProfile, eventFromStored, mergeEvents, recapMeetings, seatContextChips } from './shared'

export function buildMapSlice(seats: SeatRow[]): DashboardPayload['map'] {
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
  return { countries, dots, empty: countries.length === 0 && dots.length === 0 }
}

export function buildHeatmap(args: {
  now: number
  audit: AuditRow[]
  packs: PackMeta[]
  proposals: ProposalRow[]
}): number[] {
  const { now, audit, packs, proposals } = args
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
  return heatmap
}

export function buildAsksSlice(asks: AskRow[]): DashboardPayload['asks'] {
  return asks.slice(0, 40).map((a) => ({
    id: a.id,
    ts: a.ts,
    mode: a.mode || '',
    preview: a.preview || 'Ask',
    cache_status: a.cache_status || 'not-reported',
    provider: a.provider || ''
  }))
}

export function buildProposalsSlice(proposals: ProposalRow[]): DashboardPayload['proposals'] {
  return proposals.map((p) => ({
    id: p.id,
    skill_id: p.skill_id,
    from_version: p.from_version,
    status: p.status,
    rationale: 'Ask metadata only; no prompt evidence stored.',
    diff: p.diff,
    evidence: [],
    created_by: p.created_by,
    created_at: p.created_at
  }))
}

export function buildEventsSlice(args: {
  storedEvents: EventRow[]
  asks: AskRow[]
  crm: { id: string; ts: number; device_id: string; status: string; connector: string; action: string | null }[]
  seatsById: Map<string, SeatRow>
}): DashboardPayload['events'] {
  const { storedEvents, asks, crm, seatsById } = args
  return mergeEvents(
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
  )
}

export function buildProfilesSlice(args: {
  seats: SeatRow[]
  now: number
  licenseLabel: (seat: SeatRow) => string | null
  onlineMs: number
}): ProfileRow[] {
  const { seats, now, licenseLabel, onlineMs } = args
  return seats
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
      live: now - s.last_seen < onlineMs,
      license: licenseLabel(s),
      approval: approvalOf(s)
    }))
}

export function buildNotices(
  seats: SeatRow[],
  crm: { id: string; status: string; title: string; connector: string; last_error: string | null; ts: number; device_id: string }[],
  proposals: ProposalRow[]
): DashboardPayload['notices'] {
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))
  return [
    ...seats.filter((s) => !isApprovedSeat(s)).map((s) => seatNotice(s)),
    ...crm.filter((r) => r.status === 'failed' || r.status === 'expired').map((r) => crmNotice(r, seatsById)),
    ...proposals.filter((p) => p.status === 'pending').map((p) => proposalNotice(p))
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 80)
}

export function formatTimeSaved(events: EventRow[]): { value: string; sub: string } {
  const meetings = recapMeetings(events)
  return {
    value: meetings.length ? formatSavedTime(timeSavedFromMeetings(meetings).savedMinutes) : 'not reported',
    sub: meetings.length ? `${meetings.length} recaps · estimate` : 'no recaps ingested'
  }
}

function seatNotice(s: SeatRow): DashboardPayload['notices'][number] {
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
}

function crmNotice(
  r: { id: string; status: string; title: string; connector: string; last_error: string | null; ts: number; device_id: string },
  seatsById: Map<string, SeatRow>
): DashboardPayload['notices'][number] {
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
}

function proposalNotice(p: ProposalRow): DashboardPayload['notices'][number] {
  return {
    id: `skill-${p.id}`,
    kind: 'skill-pending',
    title: 'Skill diff pending',
    detail: `${p.skill_id} ${p.from_version}`,
    ts: p.created_at,
    profile: p.created_by && !looksLikeSecret(p.created_by) ? p.created_by : null,
    city: null,
    os: null
  }
}
