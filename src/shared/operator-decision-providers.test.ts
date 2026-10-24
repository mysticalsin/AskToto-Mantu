import { describe, expect, it } from 'vitest'
import { COMMAND_JEV_TTL_MS, parseHeartbeatDecisionProviders } from './operator-decision-providers'

describe('parseHeartbeatDecisionProviders', () => {
  it('returns jev:false for null, non-object, missing decisionProviders', () => {
    for (const input of [null, undefined, 'x', 3, [], {}, { decisionProviders: null }, { decisionProviders: 'jev' }]) {
      expect(parseHeartbeatDecisionProviders(input)).toEqual({ jev: false })
    }
  })

  it('returns jev:true only for decisionProviders.jev === true', () => {
    expect(parseHeartbeatDecisionProviders({ decisionProviders: { jev: true } })).toEqual({ jev: true })
    expect(parseHeartbeatDecisionProviders({ decisionProviders: { jev: false } })).toEqual({ jev: false })
  })

  it('rejects truthy non-boolean jev ("true", 1, {})', () => {
    for (const jev of ['true', 1, {}, [true]]) {
      expect(parseHeartbeatDecisionProviders({ decisionProviders: { jev } })).toEqual({ jev: false })
    }
  })

  it('keeps the freshness window at five minutes', () => {
    expect(COMMAND_JEV_TTL_MS).toBe(5 * 60_000)
  })
})
