import { getGraphToken } from './auth'
import { mainLog } from './logger'
import { parseTeamsVtt, type VttEntry } from '@shared/transcript-align'

/**
 * Speaker Intelligence (Phase A) — best-effort fetch of a Microsoft Teams meeting's own transcript via
 * Microsoft Graph, so a saved meeting can be enriched post-hoc with WHO said each line (not just which
 * audio channel it came from — see shared/transcript-align.ts's applySpeakerNames, which does the actual
 * alignment). This is layered entirely on top of Métis's own live transcript and is never required for a
 * meeting to save correctly: every failure path here degrades to a quiet `null`.
 *
 * Two tenant prerequisites, neither of which this code can satisfy on its own:
 *   1. The Entra app registration must be granted the DELEGATED Graph permission
 *      `OnlineMeetingTranscript.Read.All`, with admin consent, IN ADDITION to the scopes already
 *      requested at sign-in (see auth.ts's SIGN_IN_SCOPES). getGraphToken's silent acquisition simply
 *      returns null until that permission exists — this feature stays dormant (never errors) on a
 *      tenant that hasn't enabled it yet.
 *   2. Teams transcription must have actually been started (and finished processing) for the specific
 *      meeting — Graph reports zero transcripts for a meeting nobody transcribed, which is treated
 *      exactly the same as "not available".
 */

const GRAPH = 'https://graph.microsoft.com/v1.0'
const TRANSCRIPT_SCOPES = ['OnlineMeetingTranscript.Read.All']

// Listen may start a little before, or run past, the calendar invite's own start/end (started manually,
// joined late, ran over) — pad the calendarView lookup window so the meeting's own calendar event is
// still found.
const CALENDAR_LOOKUP_PAD_MS = 15 * 60_000

// One deadline for the WHOLE chain below, not one per hop. The four Graph calls run sequentially, so
// per-hop bounds would still let a socket that goes dead mid-request (dropping proxy, wifi roam, resume
// from sleep) hold a user-invoked "backfill speakers" in Review for 4x as long — and unbounded, 4x
// undici's 300 s default is ~20 minutes of a spinner. 15 s is the house bound for an outbound token/Graph
// exchange (mcp/clickupOAuth.ts's FETCH_TIMEOUT_MS); overrunning it degrades to the same quiet null as
// every other failure here.
const CHAIN_TIMEOUT_MS = 15_000

interface GraphCalendarEventLite {
  onlineMeeting?: { joinUrl?: string }
}

/** Escape a single-quoted OData string literal value (double any embedded `'`). Defense-in-depth: a Teams
 *  join URL is always Graph-generated and URL-encoded already, so this should never fire in practice. */
function odataQuote(value: string): string {
  return value.replace(/'/g, "''")
}

/** Find the join link of a calendar event overlapping [startedAt, endedAt] (+ padding) that has an online
 *  meeting attached. Mirrors calendarToday's own calendarView + fetch pattern (see main/calendar.ts). */
async function findJoinUrlFromCalendar(
  token: string,
  startedAt: number,
  endedAt: number,
  signal: AbortSignal
): Promise<string | null> {
  const start = new Date(startedAt - CALENDAR_LOOKUP_PAD_MS).toISOString()
  const end = new Date(endedAt + CALENDAR_LOOKUP_PAD_MS).toISOString()
  const url =
    `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}` +
    `&$select=subject,start,end,onlineMeeting&$orderby=start/dateTime&$top=25`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal })
  if (!res.ok) return null
  const data = (await res.json()) as { value?: GraphCalendarEventLite[] }
  const withJoin = (data.value || []).find(
    (ev) => typeof ev?.onlineMeeting?.joinUrl === 'string' && ev.onlineMeeting.joinUrl
  )
  return withJoin?.onlineMeeting?.joinUrl ?? null
}

/** Resolve a joinWebUrl to its onlineMeeting id. */
async function resolveOnlineMeetingId(token: string, joinUrl: string, signal: AbortSignal): Promise<string | null> {
  const filter = `JoinWebUrl eq '${odataQuote(joinUrl)}'`
  const url = `${GRAPH}/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal })
  if (!res.ok) return null
  const data = (await res.json()) as { value?: Array<{ id?: string }> }
  const id = data.value?.[0]?.id
  return typeof id === 'string' && id ? id : null
}

/** List a meeting's transcripts and return the newest one's id (by createdDateTime), or null when none
 *  exist yet (transcription was never started/finished for this meeting). */
async function newestTranscriptId(token: string, meetingId: string, signal: AbortSignal): Promise<string | null> {
  const url = `${GRAPH}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal })
  if (!res.ok) return null
  const data = (await res.json()) as { value?: Array<{ id?: string; createdDateTime?: string }> }
  const list = (data.value || []).filter(
    (t): t is { id: string; createdDateTime?: string } => typeof t?.id === 'string' && !!t.id
  )
  if (!list.length) return null
  list.sort((a, b) => {
    const ta = a.createdDateTime ? Date.parse(a.createdDateTime) : 0
    const tb = b.createdDateTime ? Date.parse(b.createdDateTime) : 0
    return tb - ta
  })
  return list[0].id
}

/** Fetch one transcript's content as raw VTT text. */
async function fetchTranscriptVtt(
  token: string,
  meetingId: string,
  transcriptId: string,
  signal: AbortSignal
): Promise<string | null> {
  const url =
    `${GRAPH}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}` +
    `/content?$format=text/vtt`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/vtt' }, signal })
  if (!res.ok) return null
  return res.text()
}

/**
 * Fetch + parse the Teams transcript for one Métis-recorded meeting, if one exists. `joinUrl` is used
 * directly when the caller already has it; otherwise it's resolved from the signed-in user's calendar for
 * the given window. Returns null — logging exactly once via mainLog, never throwing — on every failure
 * path: no Graph token (signed out, SSO unconfigured, or the transcript permission hasn't been consented
 * yet), no matching calendar event, no onlineMeeting resolvable from the join link, no transcript yet, or
 * the content fetch itself failing. This function must never be allowed to break a meeting save — callers
 * treat null exactly like "nothing to add" and carry on.
 */
export async function fetchTeamsTranscriptForMeeting(opts: {
  startedAt: number
  endedAt: number
  joinUrl?: string
}): Promise<{ entries: VttEntry[] } | null> {
  let token: string | null
  try {
    token = await getGraphToken(TRANSCRIPT_SCOPES)
  } catch {
    token = null
  }
  if (!token) {
    mainLog.warn(
      '[graph-transcript] no Graph token — signed out, SSO unconfigured, or OnlineMeetingTranscript.Read.All not yet granted'
    )
    return null
  }

  try {
    const signal = AbortSignal.timeout(CHAIN_TIMEOUT_MS)
    const joinUrl = opts.joinUrl || (await findJoinUrlFromCalendar(token, opts.startedAt, opts.endedAt, signal))
    if (!joinUrl) {
      mainLog.warn('[graph-transcript] no calendar event with an online-meeting join link found for this window')
      return null
    }
    const meetingId = await resolveOnlineMeetingId(token, joinUrl, signal)
    if (!meetingId) {
      mainLog.warn('[graph-transcript] could not resolve an onlineMeeting id for the join link')
      return null
    }
    const transcriptId = await newestTranscriptId(token, meetingId, signal)
    if (!transcriptId) {
      mainLog.warn('[graph-transcript] no transcripts available yet for this meeting')
      return null
    }
    const vtt = await fetchTranscriptVtt(token, meetingId, transcriptId, signal)
    if (!vtt) {
      mainLog.warn('[graph-transcript] transcript content fetch failed')
      return null
    }
    // parseTeamsVtt's cues are relative to the transcript's own start — shift them onto the same absolute
    // epoch-seconds base as TranscriptLine.t so applySpeakerNames can compare them directly.
    const baseSec = opts.startedAt / 1000
    const entries = parseTeamsVtt(vtt).map((e) => ({ ...e, tSec: e.tSec + baseSec }))
    return { entries }
  } catch (e) {
    mainLog.warn('[graph-transcript] unexpected failure', e instanceof Error ? e.message : String(e))
    return null
  }
}
