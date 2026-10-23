import { calendarTodayForConnector } from '../../calendar'
import { createOutlookDraftForConnector, createOutlookEventForConnector } from '../../outlook-write'
import type { ConnectorHandler, ConnectorHandlers, HandlerOutcome } from './connector-executor'

/**
 * The only place the Graph write functions are called (a contract test pins it). Every entry here is a catalog op and
 * every catalog op is here, so nothing is advertised without a real handler.
 */
export function createBuiltinHandlers(): ConnectorHandlers {
  const draft: ConnectorHandler = async (input: { subject: string; body: string }): Promise<HandlerOutcome> => {
    const r = await createOutlookDraftForConnector(input)
    return r.ok && r.id
      ? { ok: true, output: { id: r.id } }
      : {
          ok: false,
          ...(r.error ? { error: r.error } : {}),
          ...(r.needsConsent ? { needsConsent: true } : {}),
          ...(r.healthSignal ? { healthSignal: r.healthSignal } : {})
        }
  }
  const event: ConnectorHandler = async (input: {
    subject: string
    body: string
    startIso?: string
    endIso?: string
  }): Promise<HandlerOutcome> => {
    const r = await createOutlookEventForConnector(input)
    return r.ok && r.id
      ? { ok: true, output: { id: r.id } }
      : {
          ok: false,
          ...(r.error ? { error: r.error } : {}),
          ...(r.needsConsent ? { needsConsent: true } : {}),
          ...(r.healthSignal ? { healthSignal: r.healthSignal } : {})
        }
  }
  const today: ConnectorHandler = async (input: { tz: string }): Promise<HandlerOutcome> => {
    const r = await calendarTodayForConnector(input.tz)
    return r.ok
      ? { ok: true, output: { events: r.events ?? [] } }
      : {
          ok: false,
          ...(r.error ? { error: r.error } : {}),
          ...(r.needsConsent ? { needsConsent: true } : {}),
          ...(r.healthSignal ? { healthSignal: r.healthSignal } : {})
        }
  }
  return {
    'outlook.calendar.today': today,
    'outlook.draft.create': draft,
    'outlook.event.create': event
  }
}
