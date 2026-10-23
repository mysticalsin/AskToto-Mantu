import { calendarToday } from '../../calendar'
import { createOutlookDraft, createOutlookEvent } from '../../outlook-write'
import type { ConnectorHandler, ConnectorHandlers, HandlerOutcome } from './connector-executor'

/**
 * The only place the Graph write functions are called (a contract test pins it). Every entry here is a catalog op and
 * every catalog op is here, so nothing is advertised without a real handler.
 */
export function createBuiltinHandlers(): ConnectorHandlers {
  const draft: ConnectorHandler = async (input: { subject: string; body: string }): Promise<HandlerOutcome> => {
    const r = await createOutlookDraft(input)
    return r.ok && r.id
      ? { ok: true, output: { id: r.id } }
      : { ok: false, error: r.error, needsConsent: r.needsConsent }
  }
  const event: ConnectorHandler = async (input: {
    subject: string
    body: string
    startIso?: string
    endIso?: string
  }): Promise<HandlerOutcome> => {
    const r = await createOutlookEvent(input)
    return r.ok && r.id
      ? { ok: true, output: { id: r.id } }
      : { ok: false, error: r.error, needsConsent: r.needsConsent }
  }
  const today: ConnectorHandler = async (input: { tz: string }): Promise<HandlerOutcome> => {
    const r = await calendarToday(input.tz)
    return r.ok
      ? { ok: true, output: { events: r.events ?? [] } }
      : { ok: false, error: r.error, needsConsent: r.needsConsent }
  }
  return {
    'outlook.calendar.today': today,
    'outlook.draft.create': draft,
    'outlook.event.create': event
  }
}
