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

/** Today's [00:00, next-00:00) as naive ISO strings in the given IANA timezone (Graph reads them with the
 *  Prefer: outlook.timezone header, so no offset math is needed here). */
function todayBounds(tz: string): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date()) // "YYYY-MM-DD" in en-CA
  const start = `${parts}T00:00:00`
  const next = new Date(`${parts}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  const end = `${next.toISOString().slice(0, 10)}T00:00:00`
  return { start, end }
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
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${zone}"` }
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
