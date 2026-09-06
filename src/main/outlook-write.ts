/**
 * outlook-write.ts — Microsoft Graph draft + event create. Never send.
 *
 * Draft: POST /me/messages (stays in Drafts; we never call sendMail or /send).
 * Event: POST /me/events with zero attendees (creating attendees would send invites).
 *
 * Write scopes (Mail.ReadWrite / Calendars.ReadWrite) are requested silently. Sign-in today
 * only consents Calendars.Read (auth.ts SIGN_IN_SCOPES). If silent acquire fails, we return
 * needsConsent and the UI says Connect / grant draft permission. We do not invent a send.
 */

import { getGraphToken } from './auth'
import { auditLog } from './logger'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const GRAPH_TIMEOUT_MS = 10_000

export const OUTLOOK_DRAFT_SCOPES = ['Mail.ReadWrite']
export const OUTLOOK_EVENT_SCOPES = ['Calendars.ReadWrite']

export interface OutlookWriteStatus {
  signedIn: boolean
  canDraft: boolean
  canEvent: boolean
}

export interface OutlookWriteResult {
  ok: boolean
  error?: string
  needsConsent?: boolean
  id?: string
}

export async function outlookWriteStatus(): Promise<OutlookWriteStatus> {
  const read = await getGraphToken(['User.Read'])
  if (!read) return { signedIn: false, canDraft: false, canEvent: false }
  const [draft, event] = await Promise.all([
    getGraphToken(OUTLOOK_DRAFT_SCOPES),
    getGraphToken(OUTLOOK_EVENT_SCOPES)
  ])
  return { signedIn: true, canDraft: !!draft, canEvent: !!event }
}

async function graphPost(
  scopes: string[],
  path: string,
  body: Record<string, unknown>,
  missing: string
): Promise<OutlookWriteResult> {
  const token = await getGraphToken(scopes)
  if (!token) return { ok: false, needsConsent: true, error: missing }
  try {
    const res = await fetch(`${GRAPH}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, needsConsent: true, error: missing }
    }
    if (!res.ok) {
      return { ok: false, error: `Outlook refused the draft (${res.status}). Nothing was sent.` }
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string }
    return { ok: true, id: typeof data.id === 'string' ? data.id : undefined }
  } catch {
    return { ok: false, error: 'Outlook did not respond in time. Nothing was sent.' }
  }
}

/** Create a mail draft. Never sends. */
export async function createOutlookDraft(input: { subject: string; body: string }): Promise<OutlookWriteResult> {
  const subject = (input.subject || '').trim().slice(0, 200)
  const body = (input.body || '').slice(0, 20_000)
  if (!subject && !body) return { ok: false, error: 'Add a subject or a body before creating a draft.' }
  const r = await graphPost(
    OUTLOOK_DRAFT_SCOPES,
    '/me/messages',
    {
      subject: subject || '(no subject)',
      body: { contentType: 'Text', content: body },
      // Creating via /me/messages without /send leaves the item in Drafts.
    },
    'Outlook draft permission is not granted. Métis will not send mail. Use Open in Mail, or grant Mail.ReadWrite in Settings → Calendar.'
  )
  if (r.ok) auditLog('outlook.draft', { ok: true, kind: 'mail' })
  return r
}

/** Create a calendar event with no attendees (no invites). */
export async function createOutlookEvent(input: {
  subject: string
  body: string
  startIso?: string
  endIso?: string
}): Promise<OutlookWriteResult> {
  const subject = (input.subject || '').trim().slice(0, 200) || 'Next steps'
  const start = input.startIso && !Number.isNaN(Date.parse(input.startIso)) ? input.startIso : new Date(Date.now() + 86_400_000).toISOString()
  const end =
    input.endIso && !Number.isNaN(Date.parse(input.endIso))
      ? input.endIso
      : new Date(Date.parse(start) + 30 * 60_000).toISOString()
  const r = await graphPost(
    OUTLOOK_EVENT_SCOPES,
    '/me/events',
    {
      subject,
      body: { contentType: 'Text', content: (input.body || '').slice(0, 20_000) },
      start: { dateTime: start.replace(/\.\d{3}Z$/, ''), timeZone: 'UTC' },
      end: { dateTime: end.replace(/\.\d{3}Z$/, ''), timeZone: 'UTC' },
      attendees: [],
      isReminderOn: false
    },
    'Outlook calendar write is not granted. Métis will not send invites. Connect Outlook in Settings → Calendar.'
  )
  if (r.ok) auditLog('outlook.draft', { ok: true, kind: 'event' })
  return r
}
