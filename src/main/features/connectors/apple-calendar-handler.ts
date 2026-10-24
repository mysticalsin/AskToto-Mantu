import type { EventKitHost, EventKitPermission } from '../../infra/process/eventkit-helper-host'
import { matchesReadback } from '../calendar'
import type { HandlerOutcome } from './connector-executor'

const UNAVAILABLE = 'Apple Calendar is not available on this device.'
const NOT_SAVED = 'Apple Calendar did not save the event.'

interface AppleEventInput {
  subject: string
  body: string
  startIso: string
  endIso: string
}

const missing = (permission: EventKitPermission): HandlerOutcome => ({
  ok: false,
  refusal: 'os_permission_missing',
  permission
})

/**
 * Create an Apple Calendar event through EventKit (G65, D-22). The ActionGuard approval has already been verified by
 * the executor. This handler checks the OS permission at the moment of dispatch (asking only when the system has not
 * asked yet, which is after the owner pressed Confirm), creates ONE event with no attendees, and reports success only
 * when an EventKit readback matches what was confirmed. Anything unconfirmed after a save may have happened is
 * `effect_uncertain` and is never retried.
 */
export function createAppleEventCreateHandler(host: EventKitHost): (input: AppleEventInput) => Promise<HandlerOutcome> {
  return async (input) => {
    let status = await host.status()
    if (status === null) return { ok: false, error: UNAVAILABLE }
    if (status === 'notDetermined') {
      status = await host.ask()
      if (status === null) return { ok: false, error: UNAVAILABLE }
    }
    // Write-only access cannot read the event back, so it counts as missing.
    if (status !== 'fullAccess') return missing(status)

    const created = await host.create(input)
    if (created.kind === 'permission') return missing('denied')
    if (created.kind === 'unavailable') return { ok: false, error: UNAVAILABLE }
    if (created.kind === 'failed') return { ok: false, error: NOT_SAVED }
    if (created.kind === 'uncertain') return { ok: false, refusal: 'effect_uncertain' }

    const readback = await host.read(created.id)
    if (readback.kind === 'found' && matchesReadback(input, readback)) {
      return {
        ok: true,
        output: { id: created.id, verified: true, startIso: readback.startIso, endIso: readback.endIso }
      }
    }
    return { ok: false, refusal: 'effect_uncertain' }
  }
}
