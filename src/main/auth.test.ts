import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { requireAuth, authStatus, tenantMatches } from './auth'

vi.mock('electron')

// Shape Entra actually issues in the id-token `tid` claim, and the only tenantId the sign-in gate can
// ever match (Microsoft's own published sample tenant).
const TENANT_GUID = '72f988bf-86f1-41af-91ab-2d7cd011db47'

// The auth trust boundary (requireAuth) gates every privileged IPC handler in the main process.
// These tests cover the fail-open default and the fail-closed overrides (R-01 / R-17).
describe('auth trust boundary — requireAuth / authStatus', () => {
  let ud: string
  const AZURE_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN', 'ASKTOTO_REQUIRE_AUTH']

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'asktoto-auth-test-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) =>
      n === 'userData' ? ud : join(ud, n)
    )
    for (const k of AZURE_ENV) delete process.env[k]
  })
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    for (const k of AZURE_ENV) delete process.env[k]
    vi.restoreAllMocks()
  })

  it('fail-open by default when SSO is unconfigured (single-user)', () => {
    expect(authStatus().configured).toBe(false)
    expect(requireAuth()).toBe(true) // unconfigured → allowed (OS account is the gate)
  })

  it('is configured + fail-closed when Azure env IDs are present and the user is signed out', () => {
    process.env.AZURE_CLIENT_ID = 'client-id'
    process.env.AZURE_TENANT_ID = TENANT_GUID // must be the GUID Entra puts in `tid` — see MQA-027 below
    process.env.ASKTOTO_ALLOWED_DOMAIN = 'mantu.com'
    expect(authStatus().configured).toBe(true)
    expect(authStatus().signedIn).toBe(false)
    expect(requireAuth()).toBe(false) // configured + signed out → blocked
  })

  it('fail-CLOSED via ASKTOTO_REQUIRE_AUTH=1 even when SSO is unconfigured', () => {
    process.env.ASKTOTO_REQUIRE_AUTH = '1'
    expect(authStatus().configured).toBe(false)
    expect(requireAuth()).toBe(false) // override → require a signed-in session
  })

  it('fail-CLOSED via managed-config { requireAuth: true }', () => {
    writeFileSync(join(ud, 'managed-config.json'), JSON.stringify({ requireAuth: true }), 'utf8')
    expect(requireAuth()).toBe(false)
  })
})

// MQA-027 — a tenantId that isn't the tenant GUID (the Entra primary domain, a multi-tenant alias, or an
// unedited REPLACE-WITH-* placeholder from build/managed-config.enterprise.example.json) used to resolve
// as a working config: configured:true raised the SignInWall over the whole app, locked the three Settings
// ID fields and blocked settingsSet, while every sign-in died on the id-token `tid` compare — an install
// bricked by a typo with no in-app way back. Rejecting the shape both prevents the brick and releases the
// already-stuck population; folding case on the compare kills the second lockout trigger (an uppercase
// GUID pasted from the portal, which is a legitimate value the shape check cannot catch).
describe('MQA-027 — tenant id shape / sign-in gate cannot brick the install', () => {
  let ud: string
  const AZURE_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN', 'ASKTOTO_REQUIRE_AUTH']

  const configure = (tenantId: string): void => {
    process.env.AZURE_CLIENT_ID = 'client-id'
    process.env.AZURE_TENANT_ID = tenantId
    process.env.ASKTOTO_ALLOWED_DOMAIN = 'mantu.com'
  }

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'asktoto-auth-tenant-test-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) =>
      n === 'userData' ? ud : join(ud, n)
    )
    for (const k of AZURE_ENV) delete process.env[k]
  })
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    for (const k of AZURE_ENV) delete process.env[k]
    vi.restoreAllMocks()
  })

  it('accepts the tenant GUID (uppercase included — the portal copies it either way)', () => {
    configure(TENANT_GUID.toUpperCase())
    expect(authStatus().configured).toBe(true)
    expect(requireAuth()).toBe(false) // configured + signed out → still fail-closed
  })

  it('rejects a domain-form tenant id and leaves the app usable so the typo can be fixed', () => {
    configure('mantu.onmicrosoft.com') // passes the character allowlist, can never match `tid`
    expect(authStatus().configured).toBe(false)
    expect(authStatus().enforced).toBe(false) // no SignInWall
    expect(requireAuth()).toBe(true) // settingsSet stays reachable → the IDs can be re-entered
  })

  it('rejects the unedited enterprise-policy placeholder', () => {
    configure('REPLACE-WITH-AZURE-TENANT-ID')
    expect(authStatus().configured).toBe(false)
    expect(requireAuth()).toBe(true)
  })

  it('rejects the multi-tenant aliases — Métis is single-tenant, `tid` would never match', () => {
    for (const alias of ['common', 'organizations', 'consumers']) {
      configure(alias)
      expect(authStatus().configured).toBe(false)
    }
  })

  it('rejects a non-GUID tenant id from managed-config, not just env', () => {
    writeFileSync(
      join(ud, 'managed-config.json'),
      JSON.stringify({ azure: { clientId: 'client-id', tenantId: 'mantu.onmicrosoft.com', allowedDomain: 'mantu.com' } }),
      'utf8'
    )
    expect(authStatus().configured).toBe(false)
    writeFileSync(
      join(ud, 'managed-config.json'),
      JSON.stringify({ azure: { clientId: 'client-id', tenantId: TENANT_GUID, allowedDomain: 'mantu.com' } }),
      'utf8'
    )
    expect(authStatus().configured).toBe(true)
  })

  it('folds case on the sign-in tenant gate so an uppercase-pasted GUID is not a lockout', () => {
    expect(tenantMatches(TENANT_GUID, TENANT_GUID.toUpperCase())).toBe(true)
    expect(tenantMatches(` ${TENANT_GUID} `, TENANT_GUID)).toBe(true)
    expect(tenantMatches('9188040d-6c67-4c5b-b112-36a304b66dad', TENANT_GUID)).toBe(false) // other tenant → deny
  })
})
