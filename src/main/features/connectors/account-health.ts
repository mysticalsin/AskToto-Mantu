import type {
  ConnectorAccountHealth,
  ConnectorAccountHealthReason,
  ConnectorAccountHealthSignal
} from '@shared/connector-accounts'
import type { ConnectorEffect } from '@shared/connector-catalog'

export interface ConnectorAccountHealthRecord {
  health: ConnectorAccountHealth
  reason: ConnectorAccountHealthReason
  lastCheckedAt: number | null
  updatedAt: number
}

const NEXT_HEALTH: Readonly<Record<ConnectorAccountHealthSignal, ConnectorAccountHealth>> = {
  connect_started: 'connecting',
  connect_resumed: 'connecting',
  token_refresh_succeeded: 'healthy',
  token_refresh_rejected: 'needs_reauth',
  token_refresh_transient: 'degraded',
  operation_succeeded: 'healthy',
  transient_failure: 'degraded',
  consent_required: 'needs_reauth',
  user_disconnected: 'disconnected',
  auth_session_ended: 'disconnected',
  connect_timed_out: 'disconnected',
  connect_abandoned: 'disconnected'
}

const ALLOWED: Readonly<Record<ConnectorAccountHealth, readonly ConnectorAccountHealth[]>> = {
  connecting: ['connecting', 'healthy', 'degraded', 'needs_reauth', 'disconnected'],
  healthy: ['healthy', 'degraded', 'needs_reauth', 'disconnected'],
  degraded: ['connecting', 'healthy', 'degraded', 'needs_reauth', 'disconnected'],
  needs_reauth: ['connecting', 'healthy', 'degraded', 'needs_reauth', 'disconnected'],
  disconnected: ['connecting', 'disconnected']
}

const CHECK_SIGNALS = new Set<ConnectorAccountHealthSignal>([
  'token_refresh_succeeded',
  'token_refresh_rejected',
  'token_refresh_transient',
  'operation_succeeded',
  'transient_failure',
  'consent_required'
])

export function initialConnectorAccountHealth(now: number): ConnectorAccountHealthRecord {
  return { health: 'connecting', reason: 'connect_started', lastCheckedAt: null, updatedAt: now }
}

/** A late result after disconnect is ignored so a retired account cannot become healthy again. */
export function applyConnectorAccountHealthSignal(
  current: ConnectorAccountHealthRecord,
  signal: ConnectorAccountHealthSignal,
  now: number
): ConnectorAccountHealthRecord {
  const health = NEXT_HEALTH[signal]
  if (current.health === 'needs_reauth' && health === 'degraded' && CHECK_SIGNALS.has(signal)) {
    return { ...current, reason: signal, lastCheckedAt: now, updatedAt: now }
  }
  if (!ALLOWED[current.health].includes(health)) return current
  return {
    health,
    reason: signal,
    lastCheckedAt: CHECK_SIGNALS.has(signal) ? now : current.lastCheckedAt,
    updatedAt: now
  }
}

export function isConnectorAccountReady(health: ConnectorAccountHealth, effect: ConnectorEffect): boolean {
  return health === 'healthy' || (health === 'degraded' && effect === 'read')
}
