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

import { getGraphToken, getGraphTokenOutcome } from './auth'
import { auditLog } from './logger'
import type { ConnectorAccountHealthSignal } from '@shared/connector-accounts'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const GRAPH_TIMEOUT_MS = 10_000

export const OUTLOOK_DRAFT_SCOPES = ['Mail.ReadWrite']
export const OUTLOOK_EVENT_SCOPES = ['Calendars.ReadWrite']

export const OUTLOOK_DRAFT_CONSENT_COPY =
  'Outlook draft permission is not granted. Métis will not send mail. Use Open in Mail, or grant Mail.ReadWrite in Settings → Calendar.'
export const OUTLOOK_EVENT_CONSENT_COPY =
  'Outlook calendar write is not granted. Métis will not send invites. Connect Outlook in Settings → Calendar.'

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

export type OutlookConnectorWriteResult = OutlookWriteResult & { healthSignal?: ConnectorAccountHealthSignal }

export async function outlookWriteStatus(): Promise<OutlookWriteStatus> {
  const read = await getGraphToken(['User.Read'])
  if (!read) return { signedIn: false, canDraft: false, canEvent: false }
  const [draft, event] = await Promise.all([getGraphToken(OUTLOOK_DRAFT_SCOPES), getGraphToken(OUTLOOK_EVENT_SCOPES)])
  return { signedIn: true, canDraft: !!draft, canEvent: !!event }
}

async function graphPost(
  scopes: string[],
  path: string,
  body: Record<string, unknown>,
  missing: string
): Promise<OutlookConnectorWriteResult> {
  let outcome: Awaited<ReturnType<typeof getGraphTokenOutcome>>
  try {
    outcome = await getGraphTokenOutcome(scopes)
  } catch {
    return {
      ok: false,
      error: 'Métis could not access Outlook right now. Try again. Nothing was sent.',
      healthSignal: 'transient_failure'
    }
  }
  if (!outcome.ok) {
    if (outcome.reason === 'transient') {
      return {
        ok: false,
        error: 'Métis could not access Outlook right now. Try again. Nothing was sent.',
        healthSignal: 'transient_failure'
      }
    }
    return { ok: false, needsConsent: true, error: missing, healthSignal: 'consent_required' }
  }
  const token = outcome.token
  const uncertain =
    path === '/me/messages'
      ? 'Outlook could not confirm whether the draft was created. Check Drafts before trying again. Nothing was sent.'
      : 'Outlook could not confirm whether the calendar event was created. Check your calendar before trying again. No invitations were sent.'
  try {
    const res = await fetch(`${GRAPH}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, needsConsent: true, error: missing, healthSignal: 'consent_required' }
    }
    if (res.status >= 500) return { ok: false, error: uncertain, healthSignal: 'transient_failure' }
    if (!res.ok) {
      return { ok: false, error: `Outlook refused the draft (${res.status}). Nothing was sent.` }
    }
    const data = (await res.json()) as unknown
    const id =
      data && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string'
        ? (data as { id: string }).id.trim()
        : ''
    if (!id) return { ok: false, error: uncertain, healthSignal: 'transient_failure' }
    return { ok: true, id, healthSignal: 'operation_succeeded' }
  } catch {
    return { ok: false, error: uncertain, healthSignal: 'transient_failure' }
  }
}

function legacyResult(result: OutlookConnectorWriteResult): OutlookWriteResult {
  const { healthSignal: _healthSignal, ...legacy } = result
  return legacy
}

/** Create a mail draft. Never sends. */
export async function createOutlookDraft(input: { subject: string; body: string }): Promise<OutlookWriteResult> {
  return legacyResult(await createOutlookDraftForConnector(input))
}

export async function createOutlookDraftForConnector(input: {
  subject: string
  body: string
}): Promise<OutlookConnectorWriteResult> {
  const subject = (input.subject || '').trim().slice(0, 200)
  const body = (input.body || '').slice(0, 20_000)
  if (!subject && !body) return { ok: false, error: 'Add a subject or a body before creating a draft.' }
  const r = await graphPost(
    OUTLOOK_DRAFT_SCOPES,
    '/me/messages',
    {
      subject: subject || '(no subject)',
      body: { contentType: 'Text', content: body }
      // Creating via /me/messages without /send leaves the item in Drafts.
    },
    OUTLOOK_DRAFT_CONSENT_COPY
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
  return legacyResult(await createOutlookEventForConnector(input))
}

export async function createOutlookEventForConnector(input: {
  subject: string
  body: string
  startIso?: string
  endIso?: string
}): Promise<OutlookConnectorWriteResult> {
  const subject = (input.subject || '').trim().slice(0, 200) || 'Next steps'
  const start =
    input.startIso && !Number.isNaN(Date.parse(input.startIso))
      ? input.startIso
      : new Date(Date.now() + 86_400_000).toISOString()
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
    OUTLOOK_EVENT_CONSENT_COPY
  )
  if (r.ok) auditLog('outlook.draft', { ok: true, kind: 'event' })
  return r
}
