import { afterEach, describe, expect, it } from 'vitest'
import { COMMAND_JEV_TTL_MS } from '@shared/operator-decision-providers'
import {
  commandJevEnabled,
  recordDecisionProvidersFromHeartbeat,
  resetDecisionProvidersState
} from './operator-decision-providers-state'
import { configureOperatorReportingPolicy } from './operator-reporting-policy'

const MANAGED = { operatorUrl: 'https://operator.test', operatorIngestSecret: 'shared-secret-for-tests' }
const REPORTING_ONLY = { operatorUrl: 'https://operator.test', operatorReportingToken: 'auto-enrolled-licence' }
const ON = { decisionProviders: { jev: true } }

afterEach(() => {
  resetDecisionProvidersState()
  configureOperatorReportingPolicy(null)
})

describe('command JEV heartbeat state', () => {
  it('starts OFF before any heartbeat', () => {
    expect(commandJevEnabled(() => MANAGED, 1_000)).toBe(false)
  })

  it('ok heartbeat with jev:true turns ON', () => {
    recordDecisionProvidersFromHeartbeat(true, ON, 1_000)
    expect(commandJevEnabled(() => MANAGED, 1_001)).toBe(true)
  })

  it('ok:false heartbeat turns OFF (fail closed, unlike entitlements grace)', () => {
    recordDecisionProvidersFromHeartbeat(true, ON, 1_000)
    recordDecisionProvidersFromHeartbeat(false, ON, 2_000)
    expect(commandJevEnabled(() => MANAGED, 2_001)).toBe(false)
  })

  it('ok heartbeat without the field turns OFF', () => {
    recordDecisionProvidersFromHeartbeat(true, ON, 1_000)
    recordDecisionProvidersFromHeartbeat(true, { ok: true }, 2_000)
    expect(commandJevEnabled(() => MANAGED, 2_001)).toBe(false)
  })

  it('reads OFF once state is older than COMMAND_JEV_TTL_MS', () => {
    recordDecisionProvidersFromHeartbeat(true, ON, 1_000)
    expect(commandJevEnabled(() => MANAGED, 1_000 + COMMAND_JEV_TTL_MS)).toBe(true)
    expect(commandJevEnabled(() => MANAGED, 1_000 + COMMAND_JEV_TTL_MS + 1)).toBe(false)
  })

  it('reads OFF on a reporting-only seat', () => {
    recordDecisionProvidersFromHeartbeat(true, ON, 1_000)
    expect(commandJevEnabled(() => REPORTING_ONLY, 1_001)).toBe(false)
  })

  it('reads OFF under the admin kill switch', () => {
    recordDecisionProvidersFromHeartbeat(true, ON, 1_000)
    configureOperatorReportingPolicy({ readAdmin: () => JSON.stringify({ operatorReporting: false }) })
    expect(commandJevEnabled(() => MANAGED, 1_001)).toBe(false)
  })

  it('reset returns to OFF', () => {
    recordDecisionProvidersFromHeartbeat(true, ON, 1_000)
    resetDecisionProvidersState()
    expect(commandJevEnabled(() => MANAGED, 1_001)).toBe(false)
  })
})
