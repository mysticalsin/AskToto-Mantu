/**
 * Today's Google Calendar agenda, read-only, via the Google Calendar REST API.
 *
 * Mirrors calendar.ts (Microsoft Graph) in shape: same CalendarTodayResult / CalendarEvent types,
 * same needsConsent convention (no token → prompt a connect CTA), same todayBounds logic. The
 * Google token is never logged; only event metadata (count) is audited.
 */
import { getGoogleAccessToken } from './google-auth'
import { auditLog } from './logger'
import type { CalendarEvent, CalendarTodayResult } from '@shared/ipc'

/** Today's [00:00, 00:00+1d) in the given IANA tz as RFC3339 strings Google Calendar accepts. */
function todayBounds(tz: string): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date()) // "YYYY-MM-DD"
  const start = `${parts}T00:00:00Z`
  const next = new Date(`${parts}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  const end = next.toISOString()
  return { start, end }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEvent(item: any): CalendarEvent {
  const startDt: string = item?.start?.dateTime || item?.start?.date || ''
  const endDt: string = item?.end?.dateTime || item?.end?.date || ''
  const allDay = !item?.start?.dateTime && !!item?.start?.date
  return {
    subject: typeof item?.summary === 'string' && item.summary ? item.summary : '(no title)',
    start: startDt,
    end: endDt,
    allDay,
    location: item?.location || undefined,
    online: !!(item?.hangoutLink || item?.conferenceData),
    joinUrl: item?.hangoutLink || undefined,
    attendees: Array.isArray(item?.attendees) ? item.attendees.length : 0
  }
}

export async function googleCalendarToday(tz: string): Promise<CalendarTodayResult> {
  const token = await getGoogleAccessToken()
  // No token → user hasn't connected Google Calendar yet. Render a connect CTA.
  if (!token) return { ok: true, needsConsent: true, events: [] }

  const zone = typeof tz === 'string' && tz ? tz : 'UTC'
  const { start, end } = todayBounds(zone)

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
    `?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=20`

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 401 || res.status === 403) return { ok: true, needsConsent: true, events: [] }
    if (!res.ok) return { ok: false, error: 'Google Calendar unavailable — try again.' }
    const data = (await res.json()) as { items?: unknown[] }
    const events = Array.isArray(data.items) ? data.items.map(toEvent) : []
    auditLog('google.calendar.read', { count: events.length })
    return { ok: true, events }
  } catch {
    return { ok: false, error: 'Google Calendar unavailable — try again.' }
  }
}
