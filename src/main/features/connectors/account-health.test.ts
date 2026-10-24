import { describe, expect, it } from 'vitest'
import {
  applyConnectorAccountHealthSignal,
  initialConnectorAccountHealth,
  isConnectorAccountReady
} from './account-health'

describe('connector account health state machine', () => {
  it('does not report a newly registered account healthy before a real verification signal', () => {
    const initial = initialConnectorAccountHealth(10)
    expect(initial).toMatchObject({ health: 'connecting', reason: 'connect_started', lastCheckedAt: null })
  })

  it('marks a successful token refresh healthy and a transient failure degraded', () => {
    const initial = initialConnectorAccountHealth(10)
    const healthy = applyConnectorAccountHealthSignal(initial, 'token_refresh_succeeded', 20)
    expect(healthy).toMatchObject({ health: 'healthy', reason: 'token_refresh_succeeded', lastCheckedAt: 20 })
    const degraded = applyConnectorAccountHealthSignal(healthy, 'transient_failure', 30)
    expect(degraded).toMatchObject({ health: 'degraded', reason: 'transient_failure', lastCheckedAt: 30 })
    expect(isConnectorAccountReady(degraded.health, 'read')).toBe(true)
    expect(isConnectorAccountReady(degraded.health, 'create')).toBe(false)
  })

  it('requires reauthentication for a real token or consent rejection and can recover only on a later success', () => {
    const healthy = applyConnectorAccountHealthSignal(initialConnectorAccountHealth(10), 'token_refresh_succeeded', 20)
    const reauth = applyConnectorAccountHealthSignal(healthy, 'consent_required', 30)
    expect(reauth).toMatchObject({ health: 'needs_reauth', reason: 'consent_required', lastCheckedAt: 30 })
    expect(isConnectorAccountReady(reauth.health, 'read')).toBe(false)
    expect(applyConnectorAccountHealthSignal(reauth, 'token_refresh_succeeded', 40).health).toBe('healthy')
  })

  it('does not turn a reauthentication requirement into read readiness after a transient failure', () => {
    const reauth = applyConnectorAccountHealthSignal(
      applyConnectorAccountHealthSignal(initialConnectorAccountHealth(10), 'token_refresh_succeeded', 20),
      'consent_required',
      30
    )
    const checked = applyConnectorAccountHealthSignal(reauth, 'transient_failure', 40)
    expect(checked.health).toBe('needs_reauth')
    expect(checked.reason).toBe('transient_failure')
    expect(checked.lastCheckedAt).toBe(40)
    expect(isConnectorAccountReady(checked.health, 'read')).toBe(false)
  })

  it('does not let a late operation result revive a disconnected account', () => {
    const disconnected = applyConnectorAccountHealthSignal(
      applyConnectorAccountHealthSignal(initialConnectorAccountHealth(10), 'token_refresh_succeeded', 20),
      'user_disconnected',
      30
    )
    expect(disconnected).toMatchObject({ health: 'disconnected', reason: 'user_disconnected', lastCheckedAt: 20 })
    expect(applyConnectorAccountHealthSignal(disconnected, 'operation_succeeded', 40)).toEqual(disconnected)
  })
})
