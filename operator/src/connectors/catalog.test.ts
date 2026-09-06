import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG, tenantFieldPosition, validateTenantValue } from './catalog'
import { CONNECTOR_KINDS } from '../../../src/shared/operator-connectors'

describe('every host-positioned auth-code tenant field has allowedValues (CRITICAL fix)', () => {
  // Scoped to auth-code kinds: only those are ever reachable through GET /v1/admin/connectors/:kind/
  // oauth/start's query string, the attack surface this fix closes (a crafted link needs only an
  // already-authenticated admin's click, no session of the attacker's own). A client-credentials kind's
  // tenant/instance value is always submitted via the POST-body drawer, already CSRF-covered by the
  // central gate (origin/sec-fetch-site on every mutation) - Salesforce's `instanceUrl`, for one, is
  // host-positioned too but is a genuinely unbounded per-org domain with no fixed set to enumerate, so it
  // is deliberately out of scope for this specific "allowedValues required" rule. See the report for the
  // open question on whether that residual deserves its own control.
  for (const kind of CONNECTOR_KINDS) {
    const entry = CONNECTOR_CATALOG[kind]
    if (!entry.oauth || entry.oauth.flow !== 'auth-code') continue
    const position = tenantFieldPosition(entry.oauth)
    it(`${kind}: tenantFieldPosition is ${position}`, () => {
      if (position === 'host') {
        expect(entry.oauth!.tenantField, `${kind} has a host-positioned tenant field but no tenantField object`).toBeTruthy()
        const allowed = entry.oauth!.tenantField!.allowedValues
        expect(allowed, `${kind}'s host-positioned tenant field has no allowedValues`).toBeTruthy()
        expect(allowed!.length, `${kind}'s allowedValues is empty`).toBeGreaterThan(0)
      }
    })
  }

  it('zoho is host-positioned and its allowedValues match the seven documented Zoho data centres exactly', () => {
    const oauth = CONNECTOR_CATALOG.zoho.oauth!
    expect(tenantFieldPosition(oauth)).toBe('host')
    expect(oauth.tenantField?.allowedValues).toEqual([
      'accounts.zoho.com',
      'accounts.zoho.eu',
      'accounts.zoho.in',
      'accounts.zoho.com.au',
      'accounts.zoho.jp',
      'accounts.zoho.com.cn',
      'accounts.zohocloud.ca'
    ])
  })

  it('googledrive has no tenant field at all (nothing to validate)', () => {
    expect(tenantFieldPosition(CONNECTOR_CATALOG.googledrive.oauth!)).toBe('none')
  })
})

describe('tenantFieldPosition', () => {
  it('classifies a Microsoft-style tenant id (path-positioned, client-credentials tokenUrl) as path', () => {
    for (const kind of ['dynamics365', 'sharepoint', 'microsoftteams'] as const) {
      expect(tenantFieldPosition(CONNECTOR_CATALOG[kind].oauth!), kind).toBe('path')
    }
  })

  it('classifies Salesforce\'s instanceUrl (fills the whole origin, no literal scheme in the template) as host', () => {
    expect(tenantFieldPosition(CONNECTOR_CATALOG.salesforce.oauth!)).toBe('host')
  })
})

describe('validateTenantValue', () => {
  it('accepts only an exact allowlisted value for a host-positioned field, case-sensitively', () => {
    const oauth = CONNECTOR_CATALOG.zoho.oauth!
    expect(validateTenantValue(oauth, 'accounts.zoho.eu').ok).toBe(true)
    expect(validateTenantValue(oauth, 'evil.example').ok).toBe(false)
    expect(validateTenantValue(oauth, 'accounts.zoho.eu.evil.example').ok).toBe(false)
    expect(validateTenantValue(oauth, 'ACCOUNTS.ZOHO.EU').ok).toBe(false) // no case-folding smuggling
  })

  it('accepts a GUID or a single DNS label for a path-positioned Microsoft tenant id, rejects dots/slashes/percent', () => {
    const oauth = CONNECTOR_CATALOG.dynamics365.oauth!
    expect(validateTenantValue(oauth, '11111111-1111-1111-1111-111111111111').ok).toBe(true)
    expect(validateTenantValue(oauth, 'contoso').ok).toBe(true)
    expect(validateTenantValue(oauth, 'contoso.onmicrosoft.com').ok).toBe(false) // dot
    expect(validateTenantValue(oauth, 'contoso/../evil').ok).toBe(false) // slash
    expect(validateTenantValue(oauth, 'contoso%2e%2e').ok).toBe(false) // percent
  })

  it('passes trivially for a kind with no tenant field', () => {
    expect(validateTenantValue(CONNECTOR_CATALOG.googledrive.oauth!, 'anything').ok).toBe(true)
  })
})
