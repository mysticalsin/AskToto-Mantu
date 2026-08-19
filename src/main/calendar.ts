/**
 * Today's Outlook / Microsoft 365 agenda, read-only, via Microsoft Graph.
 *
 * Uses the Graph access token obtained at Azure-AD sign-in (getGraphToken → acquireTokenSilent over the
 * encrypted MSAL cache). Read-only (Calendars.Read). The token never leaves the main process and is never
 * logged. When there's no token (SSO unconfigured, signed out, or consent not yet granted) we return
 * needsConsent so the UI can offer a one-click connect (re-runs sign-in) instead of erroring.
 */
import { getGraphToken } from './auth'
import { auditLog } from './logger'
import type { CalendarEvent, CalendarTodayResult } from '@shared/ipc'

const GRAPH = 'https://graph.microsoft.com/v1.0'

// Nothing above this call has a deadline — the IPC handler, preload and AgendaView all just await — and a
// proxy or captive portal that completes the handshake then drops the socket would otherwise ride undici's
// 300 s default, leaving the tray panel on "Loading agenda…" for five minutes. Same bound as every other
// outbound call in main (license.ts's ACTIVATE_TIMEOUT_MS); Graph answers a 25-event calendarView in ~1 s.
const GRAPH_TIMEOUT_MS = 10_000

/** Wall-clock offset of `tz` at instant `at`, in ms east of UTC. Node exposes no offset accessor, so we
 *  format the instant in the zone and diff against UTC — that keeps half-hour zones and DST honest. */
function zoneOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(at)
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(num('year'), num('month') - 1, num('day'), num('hour'), num('minute'), num('second'))
  return Math.round((wall - at.getTime()) / 60000) * 60000 // zone offsets are whole minutes
}

/** The instant of 00:00 local time on calendar date `ymd` ("YYYY-MM-DD") in `tz`. */
function zonedMidnight(tz: string, ymd: string): Date {
  const wall = Date.parse(`${ymd}T00:00:00Z`)
  // Probe the offset twice: the first probe samples the wrong instant whenever the zone shifted that day.
  const approx = wall - zoneOffsetMs(tz, new Date(wall))
  return new Date(wall - zoneOffsetMs(tz, new Date(approx)))
}

/** Today's [00:00, next-00:00) in the given IANA timezone, as absolute (offset-bearing) instants. Graph
 *  interprets calendarView's startDateTime/endDateTime by the offset carried in the value and is NOT
 *  impacted by Prefer: outlook.timezone — that header only picks the zone of the *response*. Naive bounds
 *  therefore query a UTC day, so a Tokyo user's morning standup falls outside "today". */
function todayBounds(tz: string): { start: string; end: string } {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date()) // "YYYY-MM-DD" in en-CA
  const next = new Date(`${today}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return {
    start: zonedMidnight(tz, today).toISOString(),
    end: zonedMidnight(tz, next.toISOString().slice(0, 10)).toISOString()
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEvent(ev: any): CalendarEvent {
  return {
    subject: typeof ev?.subject === 'string' && ev.subject ? ev.subject : '(no subject)',
    start: ev?.start?.dateTime || '',
    end: ev?.end?.dateTime || '',
    allDay: !!ev?.isAllDay,
    location: ev?.location?.displayName || undefined,
    online: !!ev?.onlineMeeting?.joinUrl,
    joinUrl: ev?.onlineMeeting?.joinUrl || undefined,
    attendees: Array.isArray(ev?.attendees) ? ev.attendees.length : 0
  }
}

export async function calendarToday(tz: string): Promise<CalendarTodayResult> {
  const token = await getGraphToken(['Calendars.Read'])
  if (!token) return { ok: false, needsConsent: true }

  const zone = typeof tz === 'string' && tz ? tz : 'UTC'

  try {
    const { start, end } = todayBounds(zone)
    const url =
      `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}` +
      `&$select=subject,start,end,location,isAllDay,onlineMeeting,attendees&$orderby=start/dateTime&$top=25`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${zone}"` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) return { ok: false, needsConsent: true }
    if (!res.ok) return { ok: false, error: 'Calendar unavailable — try again.' }
    const data = (await res.json()) as { value?: unknown[] }
    const events = Array.isArray(data.value) ? data.value.map(toEvent) : []
    auditLog('calendar.read', { count: events.length }) // metadata only — never the event bodies
    return { ok: true, events }
  } catch {
    return { ok: false, error: 'Calendar unavailable — try again.' }
  }
}
