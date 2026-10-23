import { createHmac } from 'node:crypto'
import type { AccountRef, ConnectorEffect, ConnectorKind } from '@shared/connector-catalog'
import type { ConnectorAccountHealth, ConnectorAccountHealthSignal } from '@shared/connector-accounts'

export interface ConnectorAccountScope {
  readonly ownerKey: string
  readonly tenantKey: string
}

export interface AccountResolver {
  /** Returns the requested account or the only non-disconnected account; ambiguity fails closed. */
  resolve(kind: ConnectorKind, requestedAccountRef?: AccountRef): AccountRef | null
  isReady(kind: ConnectorKind, accountRef: AccountRef, effect: ConnectorEffect): boolean
  /** Records only a result observed from the provider or its token refresh path. */
  observe(kind: ConnectorKind, accountRef: AccountRef, signal: ConnectorAccountHealthSignal): Promise<boolean>
}

const KEY = /^[0-9a-f]{64}$/

function assertScope(scope: ConnectorAccountScope): void {
  if (!KEY.test(scope.ownerKey) || !KEY.test(scope.tenantKey)) {
    throw new Error('Connector account scope is unavailable.')
  }
}

function accountSalt(scope: ConnectorAccountScope): string {
  assertScope(scope)
  // These pseudonymous keys are derived by the main-only owner-session authority and never cross IPC.
  return createHmac('sha256', scope.ownerKey).update(`connector-account-salt:v1\0${scope.tenantKey}`).digest('hex')
}

/** HMAC makes refs stable within one verified owner/tenant while hiding provider identity and tenant values. */
export function deriveConnectorAccountRef(
  scope: ConnectorAccountScope,
  kind: ConnectorKind,
  providerAccountId: string
): AccountRef {
  const identity = providerAccountId.trim()
  if (!identity || identity.length > 320) throw new Error('Connector account identity is invalid.')
  const ref = createHmac('sha256', accountSalt(scope))
    .update(`connector-account-ref:v1\0${kind}\0${identity}`)
    .digest('base64url')
  return `acct_${ref}` as AccountRef
}

/** The durable partition key is also derived from the main-held owner/tenant keys, never from raw identities. */
export function connectorAccountScopeKey(scope: ConnectorAccountScope): string {
  return createHmac('sha256', accountSalt(scope)).update('connector-account-scope:v1').digest('hex')
}

/** Produces a display-only hint. The full provider identity is never returned or persisted by this module. */
export function maskedAccountHint(providerAccountId: string): string {
  const identity = providerAccountId.trim()
  if (!identity) return ''
  const at = identity.lastIndexOf('@')
  const local = at > 0 ? identity.slice(0, at) : identity
  const domain = at > 0 ? identity.slice(at) : ''
  return `${[...local][0] ?? '*'}***${domain}`.slice(0, 120)
}

export function isAccountReadyForEffect(health: ConnectorAccountHealth, effect: ConnectorEffect): boolean {
  return health === 'healthy' || (health === 'degraded' && effect === 'read')
}
