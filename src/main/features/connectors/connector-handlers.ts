import { calendarTodayForConnector } from '../../calendar'
import { createOutlookDraftForConnector, createOutlookEventForConnector } from '../../outlook-write'
import { createEventKitHost, type EventKitHost } from '../../infra/process/eventkit-helper-host'
import { macHelperPath, macHelperPresent } from '../../mac-helper'
import { createAppleEventCreateHandler } from './apple-calendar-handler'
import type { ConnectorHandler, ConnectorHandlers, HandlerOutcome } from './connector-executor'

export interface BuiltinHandlerDeps {
  /** Test seam; production talks to the bundled mac helper and is unavailable off macOS. */
  eventKit?: EventKitHost
}

const productionEventKit = (): EventKitHost =>
  createEventKitHost({
    platform: process.platform,
    helperPath: () => (macHelperPresent() ? macHelperPath() : null)
  })

/**
 * The only place the Graph write functions are called (a contract test pins it). Every entry here is a catalog op and
 * every catalog op is here, so nothing is advertised without a real handler.
 */
export function createBuiltinHandlers(deps: BuiltinHandlerDeps = {}): ConnectorHandlers {
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
    // Success needs the readback-confirmed id and times; anything unconfirmed is effect_uncertain.
    return r.ok && r.id && r.startIso && r.endIso
      ? { ok: true, output: { id: r.id, verified: true, startIso: r.startIso, endIso: r.endIso } }
      : {
          ok: false,
          ...(r.uncertain || r.ok ? { refusal: 'effect_uncertain' as const } : {}),
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
    'outlook.event.create': event,
    'apple.calendar.event.create': createAppleEventCreateHandler(deps.eventKit ?? productionEventKit())
  }
}
