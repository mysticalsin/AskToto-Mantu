import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import {
  requireAuth,
  authStatus,
  tenantMatches,
  signOut,
  resetSelfServeSso,
  isAdminManagedEnforced
} from './auth'
import { getSettings, setSettings } from './store'
import { readTrustedAdminManaged } from './win-security'

vi.mock('electron')
// Stub only the admin-trusted managed-config read so tests never inherit this machine's real ProgramData
// policy (default null = no admin policy). All other win-security exports stay real — store.ts imports
// adminManagedConfigPath from here. The MQA-107 admin-managed gate test overrides readTrustedAdminManaged.
vi.mock('./win-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./win-security')>()
  return { ...actual, readTrustedAdminManaged: vi.fn((): string | null => null) }
})

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

// MQA-107 — MQA-027's shape check rejects a NON-GUID tenant, but a well-formed-but-factually-WRONG tenant
// GUID (a digit-swap typo, or another tenant's GUID pasted by mistake) still passes: readConfig() reports
// configured:true, the SignInWall replaces the whole app, the Settings ID fields lock behind it, and
// settingsSet is refused by requireAuth() — an unrecoverable in-app brick. The ledger's own remedy item 2
// is an escape hatch: a "Reset Microsoft sign-in setup" action, reachable through the (requireAuth-ungated)
// signOut IPC, that clears the self-serve azure* config ONLY when there is no live session and enforcement
// is self-serve (never an env/managed/admin-trusted/sticky lock), returning the install to a usable state.
describe('MQA-107 — SignInWall reset escape hatch recovers a wrong-tenant self-serve brick', () => {
  let ud: string
  const AZURE_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN', 'ASKTOTO_REQUIRE_AUTH']
  // Well-formed GUID, but a digit-swap of the real tenant (…db47 → …db74) — passes TENANT_GUID_RE, can
  // never match the id-token `tid`. This is exactly the repro: a typo that bricks with no in-app recovery.
  const WRONG_GUID = '72f988bf-86f1-41af-91ab-2d7cd011db74'

  const configureSelfServe = (tenantId: string): void => {
    setSettings({ azureClientId: 'client-id', azureTenantId: tenantId, azureAllowedDomain: 'mantu.com' })
  }

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'asktoto-auth-reset-test-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) =>
      n === 'userData' ? ud : join(ud, n)
    )
    for (const k of AZURE_ENV) delete process.env[k]
    vi.mocked(readTrustedAdminManaged).mockReturnValue(null) // default: no admin policy
  })
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    for (const k of AZURE_ENV) delete process.env[k]
    vi.restoreAllMocks()
  })

  it('a well-formed-but-wrong self-serve tenant bricks the app, and the reset (signOut with no session) recovers it', () => {
    configureSelfServe(WRONG_GUID)
    // Bricked: shape check passes → configured:true, the wall is up, and requireAuth() blocks settingsSet,
    // so the bad ID can't be corrected in-app (the exact MQA-107 dead end).
    expect(authStatus().configured).toBe(true)
    expect(authStatus().signedIn).toBe(false)
    expect(requireAuth()).toBe(false)
    // The escape hatch: signOut() with no live session clears the self-serve azure* config.
    signOut()
    // Recovered: unconfigured + unenforced + usable, so the IDs can be re-entered. The first assertion is
    // the one that FAILS without the fix — signOut() with no session used to be a pure no-op, leaving the
    // wrong config in place and configured:true forever.
    expect(authStatus().configured).toBe(false)
    expect(authStatus().enforced).toBe(false)
    expect(requireAuth()).toBe(true)
    expect(getSettings().azureTenantId).toBe('')
    expect(getSettings().azureClientId).toBe('')
    expect(getSettings().azureAllowedDomain).toBe('')
  })

  it('a self-serve config is NOT admin-managed, so the reset is permitted', () => {
    configureSelfServe(WRONG_GUID)
    expect(isAdminManagedEnforced()).toBe(false)
    expect(resetSelfServeSso()).toBe(true)
    expect(getSettings().azureTenantId).toBe('')
  })

  it('refuses to reset when auth is env-forced (ASKTOTO_REQUIRE_AUTH) — an org lock survives the UI', () => {
    process.env.ASKTOTO_REQUIRE_AUTH = '1'
    configureSelfServe(WRONG_GUID)
    expect(authStatus().enforced).toBe(true)
    expect(resetSelfServeSso()).toBe(false)
    expect(getSettings().azureTenantId).toBe(WRONG_GUID) // config left untouched
    expect(authStatus().enforced).toBe(true) // still locked
  })

  it('refuses to reset a sticky-configured device — a prior genuine sign-in has the LKG recovery path', () => {
    configureSelfServe(WRONG_GUID)
    // Simulate a genuine prior sign-in having written the sticky flag (userData/auth-configured.flag).
    writeFileSync(join(ud, 'auth-configured.flag'), '1', { mode: 0o600 })
    expect(resetSelfServeSso()).toBe(false)
    expect(getSettings().azureTenantId).toBe(WRONG_GUID) // known-good-era config not destroyed
  })

  it('refuses to reset an admin-trusted managed-config (IT-locked) fleet, and flags it as admin-managed', () => {
    // Admin-trusted machine policy supplies a full azure block — the one case the escape hatch must refuse
    // so an IT-locked fleet can never be talked out of enforcement from the UI.
    vi.mocked(readTrustedAdminManaged).mockReturnValue(
      JSON.stringify({ azure: { clientId: 'client-id', tenantId: TENANT_GUID, allowedDomain: 'mantu.com' } })
    )
    configureSelfServe(WRONG_GUID)
    expect(isAdminManagedEnforced()).toBe(true)
    expect(resetSelfServeSso()).toBe(false)
  })

  it('flags admin-trusted requireAuth:true as admin-managed too (blocks the reset)', () => {
    vi.mocked(readTrustedAdminManaged).mockReturnValue(JSON.stringify({ requireAuth: true }))
    configureSelfServe(WRONG_GUID)
    expect(isAdminManagedEnforced()).toBe(true)
    expect(resetSelfServeSso()).toBe(false)
  })

  it('does not clear anything on a routine already-signed-out signOut() with no self-serve config', () => {
    // Fresh install, no azure config: signOut() must stay a no-op (returns nothing to clear).
    expect(resetSelfServeSso()).toBe(false)
    signOut()
    expect(authStatus().configured).toBe(false)
  })
})
