/**
 * Command JEV availability from the last Operator heartbeat (memory only, never persisted).
 * Fail closed: a failed heartbeat, a stale answer, a reporting-only seat or the admin kill switch all read OFF.
 * Imports the two gate modules directly and never operator-ingest, so there is no cycle.
 */
import { COMMAND_JEV_TTL_MS, parseHeartbeatDecisionProviders } from '@shared/operator-decision-providers'
import { operatorReportingOnlySeat } from './operator-seat'
import { operatorReportingAllowed } from './operator-reporting-policy'

type SeatSettings = Parameters<typeof operatorReportingOnlySeat>[0]

let state: { jev: boolean; at: number } = { jev: false, at: 0 }

export function recordDecisionProvidersFromHeartbeat(ok: boolean, json: unknown, now: number = Date.now()): void {
  state = { jev: ok && parseHeartbeatDecisionProviders(json).jev, at: now }
}

export function commandJevEnabled(getSettings: () => SeatSettings, now: number = Date.now()): boolean {
  if (!state.jev || now - state.at > COMMAND_JEV_TTL_MS) return false
  if (!operatorReportingAllowed()) return false
  return !operatorReportingOnlySeat(getSettings())
}

export function resetDecisionProvidersState(): void {
  state = { jev: false, at: 0 }
}
