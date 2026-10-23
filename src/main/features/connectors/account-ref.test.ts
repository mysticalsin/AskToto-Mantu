import { describe, expect, it } from 'vitest'
import { connectorAccountScopeKey, deriveConnectorAccountRef, maskedAccountHint } from './account-ref'

const OWNER_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }
const OWNER_B = { ownerKey: 'c'.repeat(64), tenantKey: 'b'.repeat(64) }
const TENANT_B = { ownerKey: OWNER_A.ownerKey, tenantKey: 'd'.repeat(64) }

describe('connector account references', () => {
  it('creates a stable opaque ref without copying an email or tenant id into it', () => {
    const email = 'alice.smith@example.test'
    const ref = deriveConnectorAccountRef(OWNER_A, 'outlook', email)
    expect(ref).toBe(deriveConnectorAccountRef(OWNER_A, 'outlook', email))
    expect(ref).toMatch(/^acct_[A-Za-z0-9_-]{43}$/)
    expect(ref).not.toContain(email)
    expect(ref).not.toContain(OWNER_A.tenantKey)
  })

  it('scopes refs by both owner and tenant', () => {
    const identity = 'alice@example.test'
    const ref = deriveConnectorAccountRef(OWNER_A, 'outlook', identity)
    expect(deriveConnectorAccountRef(OWNER_B, 'outlook', identity)).not.toBe(ref)
    expect(deriveConnectorAccountRef(TENANT_B, 'outlook', identity)).not.toBe(ref)
    expect(connectorAccountScopeKey(OWNER_A)).not.toBe(connectorAccountScopeKey(OWNER_B))
    expect(connectorAccountScopeKey(OWNER_A)).not.toBe(connectorAccountScopeKey(TENANT_B))
  })

  it('returns only a masked hint for renderer display', () => {
    expect(maskedAccountHint('alice.smith@example.test')).toBe('a***@example.test')
    expect(maskedAccountHint('not-an-email')).toBe('n***')
    expect(maskedAccountHint('')).toBe('')
  })
})
