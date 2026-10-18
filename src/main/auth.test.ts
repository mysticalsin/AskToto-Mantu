import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import {
  requireAuth,
  authStatus,
  tenantMatches,
  signOut,
  resetSelfServeSso,
  isAdminManagedEnforced,
  ssoBootstrapAllowed
} from './auth'
import { getSettings, setSettings } from './store'
import { readTrustedAdminManaged } from './win-security'

vi.mock('electron')
// Node exposes these APIs through non-configurable ESM namespace properties on Windows. Delegate to
// the real modules while making the few filesystem probes in the lease hot-path test spyable on every OS.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) }
})
// Stub only the admin-trusted managed-config read so tests never inherit this machine's real ProgramData
// policy (default null = no admin policy). All other win-security exports stay real — store.ts imports
// adminManagedConfigPath from here. The MQA-107 admin-managed gate test overrides readTrustedAdminManaged.
vi.mock('./win-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./win-security')>()
  return {
    ...actual,
    adminManagedConfigPath: vi.fn(() => join(app.getPath('userData'), 'admin-managed-config.json')),
    readTrustedAdminManaged: vi.fn((): string | null => null)
  }
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
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) => (n === 'userData' ? ud : join(ud, n)))
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
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) => (n === 'userData' ? ud : join(ud, n)))
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
      JSON.stringify({
        azure: { clientId: 'client-id', tenantId: 'mantu.onmicrosoft.com', allowedDomain: 'mantu.com' }
      }),
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
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) => (n === 'userData' ? ud : join(ud, n)))
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

// MQA-107's sibling, and its mirror image. There the config is present but WRONG; here it is absent while
// enforcement is on — managed-config (or ASKTOTO_REQUIRE_AUTH) says requireAuth:true and supplies no
// tenant. authEnforced() alone raises the SignInWall, signIn() short-circuits {ok:true, configured:false},
// and the wall's own message sends the user to enter the IDs in Settings — which settingsSet then refused
// to persist, because requireAuth() is false in exactly that state. Unusable machine, no in-app recovery.
describe('MQA-066 — SSO bootstrap escapes an enforced-but-unconfigured wall', () => {
  let ud: string
  const AZURE_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN', 'ASKTOTO_REQUIRE_AUTH']
  // Well-formed, and a digit-swap of the real tenant — passes the shape check, can never match `tid`.
  const WRONG_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db74'

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'asktoto-auth-bootstrap-test-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) => (n === 'userData' ? ud : join(ud, n)))
    for (const k of AZURE_ENV) delete process.env[k]
  })
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    for (const k of AZURE_ENV) delete process.env[k]
    vi.restoreAllMocks()
  })

  const enforceWithoutConfig = (): void => {
    writeFileSync(join(ud, 'managed-config.json'), JSON.stringify({ requireAuth: true }), 'utf8')
  }

  it('allows the bootstrap in exactly the dead-end state', () => {
    enforceWithoutConfig()
    // The state the finding describes, asserted rather than assumed: wall up, nothing configured, and the
    // ordinary settings write path closed.
    expect(authStatus().enforced).toBe(true)
    expect(authStatus().configured).toBe(false)
    expect(requireAuth()).toBe(false)
    expect(ssoBootstrapAllowed()).toBe(true)
  })

  it('refuses it when there is no wall to escape', () => {
    expect(requireAuth()).toBe(true) // unconfigured + unenforced → nothing blocked, nothing to bootstrap
    expect(ssoBootstrapAllowed()).toBe(false)
  })

  // The typo case, and the reason this is NOT gated on "nothing resolves a config". A first shape of the
  // fix closed the bootstrap the moment any config resolved, which meant one fat-fingered digit in a
  // tenant GUID re-bricked the machine: every sign-in fails the tenant compare forever, and MQA-107's
  // reset hatch correctly refuses an authEnforced() fleet. The remedy the wall names has to stay usable
  // until a sign-in actually succeeds, or the brick has only moved one step later.
  it('stays open so a mistyped tenant can be corrected', () => {
    enforceWithoutConfig()
    setSettings({ azureClientId: 'client-id', azureTenantId: WRONG_TENANT, azureAllowedDomain: 'mantu.com' })
    expect(authStatus().configured).toBe(true) // a config resolves, and every sign-in against it fails
    expect(requireAuth()).toBe(false) // still walled
    expect(ssoBootstrapAllowed()).toBe(true) // ...and still correctable
  })

  it('cannot override an org deployment — env/managed outrank settings in readConfig()', () => {
    enforceWithoutConfig()
    process.env.AZURE_CLIENT_ID = 'client-id'
    process.env.AZURE_TENANT_ID = TENANT_GUID
    process.env.ASKTOTO_ALLOWED_DOMAIN = 'mantu.com'
    // The write is permitted but INERT: a higher tier already answers readConfig(), so what the renderer
    // puts in settings can never become the tenant this device signs into.
    setSettings({ azureClientId: 'evil', azureTenantId: WRONG_TENANT, azureAllowedDomain: 'evil.com' })
    expect(authStatus().domain).toBe('mantu.com')
  })

  it('never lifts enforcement — authEnforced() does not read these fields at all', () => {
    enforceWithoutConfig()
    setSettings({ azureClientId: '', azureTenantId: '', azureAllowedDomain: '' })
    expect(authStatus().enforced).toBe(true)
    expect(requireAuth()).toBe(false)
  })

  // The security property. Once a genuine sign-in has happened, an UNAUTHENTICATED renderer must never be
  // able to point SSO at a tenant of its choosing — that is precisely what the sticky flag was added to
  // stop, and this carve-out must not reopen it.
  it('refuses it on a sticky-configured device, even with every azure field cleared', () => {
    enforceWithoutConfig()
    writeFileSync(join(ud, 'auth-configured.flag'), '1', { mode: 0o600 })
    setSettings({ azureClientId: '', azureTenantId: '', azureAllowedDomain: '' })
    expect(authStatus().enforced).toBe(true)
    expect(ssoBootstrapAllowed()).toBe(false)
  })
})

describe('interactive sign-in backoff (sequential-failure rate limit)', () => {
  // The single-flight latch stops CONCURRENT flows; this pins the SEQUENTIAL control: escalating
  // backoff after consecutive failures, reset on success, gate checked before the latch is taken.
  it('owns consecutive failures per controller and follows the default clock through reset', async () => {
    const { createSignInBackoffController } = await import('./auth-session-policy')
    const controller = createSignInBackoffController()
    const other = createSignInBackoffController()
    let now = 10_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      expect(controller.failures).toBe(0)
      expect(controller.remainingMs()).toBe(0)
      for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000].entries()) {
        controller.recordSignInFailure()
        expect(controller.failures).toBe(index + 1)
        expect(controller.remainingMs()).toBe(delay)
        expect(other.failures).toBe(0)
        expect(other.remainingMs()).toBe(0)
        clock.mockReturnValue(now + delay - 1)
        expect(controller.remainingMs()).toBe(1)
        now += delay
        clock.mockReturnValue(now)
        expect(controller.remainingMs()).toBe(0)
      }
      controller.recordSignInSuccess()
      expect(controller.failures).toBe(0)
      expect(controller.remainingMs()).toBe(0)
      controller.recordSignInFailure()
      expect(controller.failures).toBe(1)
      expect(controller.remainingMs()).toBe(2_000)
    } finally {
      clock.mockRestore()
    }
  })

  it('escalates 2s -> 4s -> 8s capped at 60s and resets on success', async () => {
    const { INITIAL_SIGN_IN_BACKOFF, resetSignInBackoff, signInBackoffAfterFailure, signInBackoffRemaining } =
      await import('./auth-session-policy')
    let state = INITIAL_SIGN_IN_BACKOFF
    state = signInBackoffAfterFailure(state, 10_000)
    expect(signInBackoffRemaining(state, 10_000)).toBe(2_000)
    state = signInBackoffAfterFailure(state, 12_000)
    expect(signInBackoffRemaining(state, 12_000)).toBe(4_000)
    state = signInBackoffAfterFailure(state, 16_000)
    expect(signInBackoffRemaining(state, 16_000)).toBe(8_000)
    let cappedDelayStartedAt = 0
    for (let failure = 4; failure <= 7; failure += 1) {
      const attemptAt = state.blockedUntil
      state = signInBackoffAfterFailure(state, attemptAt)
      if (failure === 7) cappedDelayStartedAt = attemptAt
    }
    expect(signInBackoffRemaining(state, cappedDelayStartedAt)).toBe(60_000)
    expect(signInBackoffRemaining(resetSignInBackoff(), 16_000)).toBe(0)
  })

  it('reports remaining wait to the caller in whole seconds', async () => {
    const { signInBackoffRemainingMs } = await import('./auth')
    // Fresh module state: no failures recorded in this worker -> gate open.
    expect(signInBackoffRemainingMs()).toBe(0)
  })
})

// M2-0147 — a persisted session was only re-checked against MAX_SESSION_AGE_MS and the allowed domain.
// An IT tenant rotation (a new Entra tenant ID pushed to env/managed-config) left an old session's `tid`
// trusted for up to 7 more days: expiryReason never looked at it. Each test gets its own module instance
// (vi.resetModules() + dynamic import) because auth.ts's `loaded`/`session` state is module-level and
// would otherwise leak between cases — follows signout-revocation.contract.test.ts's pattern.
describe('tenant rotation ends a session whose tid no longer matches the configured tenant (M2-0147)', () => {
  const AZURE_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN', 'ASKTOTO_REQUIRE_AUTH']
  const OTHER_TENANT_GUID = '00000000-0000-4000-8000-000000000001'
  let ud: string
  let saved: Record<string, string | undefined>

  beforeEach(async () => {
    vi.resetModules()
    ud = mkdtempSync(join(tmpdir(), 'asktoto-auth-tenant-rotate-'))
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) =>
      n === 'userData' ? ud : join(ud, n)
    )
    saved = {}
    for (const k of AZURE_ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.AZURE_CLIENT_ID = 'client-id'
    process.env.ASKTOTO_ALLOWED_DOMAIN = 'example.com'
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    for (const k of AZURE_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A session file the real loadSession() will accept, for the given tenant id. */
  async function writeSessionFile(tid: string): Promise<void> {
    const { encryptSecret } = await import('./secrets')
    const session = { email: 'user@example.com', domain: 'example.com', tid, at: Date.now() }
    writeFileSync(join(ud, 'auth-session.bin'), encryptSecret(JSON.stringify(session)), { mode: 0o600 })
  }

  it('A1: clears a session whose tenant no longer matches the configured tenant on the next status check', async () => {
    await writeSessionFile(TENANT_GUID)
    process.env.AZURE_TENANT_ID = TENANT_GUID
    const auth = await import('./auth')
    expect(auth.authStatus().signedIn).toBe(true)

    process.env.AZURE_TENANT_ID = OTHER_TENANT_GUID
    const cleared = vi.fn()
    auth.setSessionClearedHandler(cleared)

    const status = auth.authStatus()
    expect(status.signedIn).toBe(false)
    expect(auth.requireAuth()).toBe(false)
    expect(cleared).toHaveBeenCalledTimes(1)
  })

  it('A2: the background re-validation sweep clears it with no user action', async () => {
    vi.useFakeTimers()
    await writeSessionFile(TENANT_GUID)
    process.env.AZURE_TENANT_ID = TENANT_GUID
    const auth = await import('./auth')
    expect(auth.authStatus().signedIn).toBe(true) // starts the background sweep

    process.env.AZURE_TENANT_ID = OTHER_TENANT_GUID
    const cleared = vi.fn()
    auth.setSessionClearedHandler(cleared)

    // The sweep's first kick fires 10s after authStatus() started it — before any further authStatus().
    await vi.advanceTimersByTimeAsync(10_000)
    expect(cleared).toHaveBeenCalledTimes(1)
  })

  it('A3: folds case like the sign-in gate (guards against a raw !== compare)', async () => {
    await writeSessionFile(TENANT_GUID.toLowerCase())
    process.env.AZURE_TENANT_ID = TENANT_GUID.toUpperCase()
    const auth = await import('./auth')
    expect(auth.authStatus().signedIn).toBe(true)
  })
})

// Speech authorization uses the real auth module as its source. The lease is only a short-lived,
// opaque capability: its per-frame check must stay in memory and must retire with the auth owner.
describe('speech auth lease (auth module authority)', () => {
  const AZURE_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN', 'ASKTOTO_REQUIRE_AUTH']
  let ud: string
  let saved: Record<string, string | undefined>
  let settingsEpoch = 0
  let policyRevision = 'profile-a|policy-a'
  let settingsBoundaryReads = 0
  let adminBoundaryReads = 0
  let policyRevisionReads = 0
  let activeProfilePath: string

  beforeEach(async () => {
    vi.resetModules()
    settingsEpoch = 0
    policyRevision = 'profile-a|policy-a'
    settingsBoundaryReads = 0
    adminBoundaryReads = 0
    policyRevisionReads = 0
    ud = mkdtempSync(join(tmpdir(), 'asktoto-speech-auth-lease-'))
    activeProfilePath = ud
    const electron = await import('electron')
    const readProfilePath = (n: string): string => (n === 'userData' ? activeProfilePath : join(activeProfilePath, n))
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation(readProfilePath)
    // The cached win-security mock closes over the initially imported Electron app. Keep its policy
    // path on the same isolated profile as the fresh auth/store modules created by resetModules().
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation(readProfilePath)
    saved = {}
    for (const k of AZURE_ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    for (const k of AZURE_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function writeSessionFile(tid = TENANT_GUID, email = 'user@example.com', at = Date.now()): Promise<void> {
    const { encryptSecret } = await import('./secrets')
    const session = { email, domain: 'example.com', tid, at }
    writeFileSync(join(ud, 'auth-session.bin'), encryptSecret(JSON.stringify(session)), { mode: 0o600 })
  }

  function configureTenant(): void {
    process.env.AZURE_CLIENT_ID = 'client-id'
    process.env.AZURE_TENANT_ID = TENANT_GUID
    process.env.ASKTOTO_ALLOWED_DOMAIN = 'example.com'
  }

  async function prepareAuth(adminReader?: (path: string) => Promise<Uint8Array | null>) {
    // vi.resetModules() also recreates the Electron mock module. Rebind its profile path before loading
    // auth/store so the newly imported modules read the same isolated files the test prepared.
    const electron = await import('electron')
    const readProfilePath = (n: string): string => (n === 'userData' ? activeProfilePath : join(activeProfilePath, n))
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation(readProfilePath)
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation(readProfilePath)
    const auth = await import('./auth')
    const { getSettings } = await import('./store')
    const { readTrustedAdminManagedBytes } = await import('./win-security')
    auth.configureSpeechAuthLeaseReaders({
      readSettingsAtBoundary: async () => {
        settingsBoundaryReads += 1
        return { settings: getSettings(), readable: true, epoch: settingsEpoch }
      },
      readSettingsEpoch: () => settingsEpoch,
      readPolicyPathsRevision: () => {
        policyRevisionReads += 1
        return policyRevision
      },
      readTrustedAdminManagedBytes: async (path) => {
        adminBoundaryReads += 1
        return adminReader ? adminReader(path) : readTrustedAdminManagedBytes(path)
      }
    })
    return auth
  }

  it('allows the real unconfigured developer mode and performs 600 pure in-memory checks', async () => {
    const unconfiguredAuth = await import('./auth')
    expect(await unconfiguredAuth.refreshSpeechAuthLease()).toBeNull() // no verified boundary yet
    expect(unconfiguredAuth.isSpeechAuthLeaseCurrent({} as never)).toBe(false)
    const auth = await prepareAuth()
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    const repeatedLease = await auth.refreshSpeechAuthLease()
    expect(repeatedLease).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(true)
    expect(auth.isSpeechAuthLeaseCurrent(repeatedLease)).toBe(true)

    const fs = await import('node:fs')
    const fsPromises = await import('node:fs/promises')
    const winSecurity = await import('./win-security')
    const electron = await import('electron')
    const reads = vi.mocked(fs.readFileSync)
    const lstatReads = vi.mocked(fsPromises.lstat)
    const openReads = vi.mocked(fsPromises.open)
    const pathReads = vi.mocked(electron.app.getPath)
    const adminPathReads = vi.mocked(winSecurity.adminManagedConfigPath)
    reads.mockClear()
    lstatReads.mockClear()
    openReads.mockClear()
    pathReads.mockClear()
    adminPathReads.mockClear()
    const settingsReadsBefore = settingsBoundaryReads
    const adminReadsBefore = adminBoundaryReads
    const policyRevisionReadsBefore = policyRevisionReads
    for (let i = 0; i < 600; i += 1) {
      expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(true)
    }
    expect(reads).not.toHaveBeenCalled()
    expect(lstatReads).not.toHaveBeenCalled()
    expect(openReads).not.toHaveBeenCalled()
    expect(pathReads).not.toHaveBeenCalled()
    expect(adminPathReads).not.toHaveBeenCalled()
    expect(settingsBoundaryReads).toBe(settingsReadsBefore)
    expect(adminBoundaryReads).toBe(adminReadsBefore)
    expect(policyRevisionReads).toBe(policyRevisionReadsBefore)
    expect(JSON.stringify(lease)).not.toMatch(/user@example\.com|client-id|example\.com|72f988bf/i)
  })

  it('keeps enforced org auth closed without a session, and accepts only a real in-bound session', async () => {
    configureTenant()
    const auth = await prepareAuth()
    expect(await auth.refreshSpeechAuthLease()).toBeNull()

    await writeSessionFile()
    vi.resetModules()
    const freshAuth = await prepareAuth()
    const lease = await freshAuth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    expect(freshAuth.isSpeechAuthLeaseCurrent(lease)).toBe(true)
  })

  it('keeps env, user managed, and admin managed enforcement fail-closed without SSO config', async () => {
    process.env.ASKTOTO_REQUIRE_AUTH = '1'
    let auth = await prepareAuth()
    expect(await auth.refreshSpeechAuthLease()).toBeNull()

    vi.resetModules()
    delete process.env.ASKTOTO_REQUIRE_AUTH
    writeFileSync(join(ud, 'managed-config.json'), JSON.stringify({ requireAuth: true }), 'utf8')
    auth = await prepareAuth()
    expect(await auth.refreshSpeechAuthLease()).toBeNull()

    vi.resetModules()
    rmSync(join(ud, 'managed-config.json'), { force: true })
    writeFileSync(join(ud, 'admin-managed-config.json'), '{}', 'utf8')
    auth = await prepareAuth(async () => new TextEncoder().encode(JSON.stringify({ requireAuth: true })))
    expect(await auth.refreshSpeechAuthLease()).toBeNull()
  })

  it('does not make an unused malformed LKG file change valid fresh-config behavior', async () => {
    configureTenant()
    await writeSessionFile()
    writeFileSync(join(ud, 'auth-lkg-config.json'), '{not-json', 'utf8')
    const auth = await prepareAuth()
    expect(await auth.refreshSpeechAuthLease()).not.toBeNull()
  })

  it('preserves the full-invalid-admin precedence over a valid per-user Azure block', async () => {
    const adminPath = join(ud, 'admin-managed-config.json')
    const admin = { azure: { clientId: 'bad value', tenantId: TENANT_GUID, allowedDomain: 'example.com' } }
    const user = { azure: { clientId: 'client-id', tenantId: TENANT_GUID, allowedDomain: 'example.com' } }
    writeFileSync(adminPath, JSON.stringify(admin), 'utf8')
    writeFileSync(join(ud, 'managed-config.json'), JSON.stringify(user), 'utf8')
    const auth = await prepareAuth(async () => new TextEncoder().encode(JSON.stringify(admin)))

    // The resolver selects a complete admin Azure block before validating it; it does not fall
    // through to per-user config. With no Settings config or enforcement, this is a dev install.
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(true)
  })

  it('keeps acknowledged unrelated updates but retires across a missed settings observation', async () => {
    const auth = await prepareAuth()
    const { getSettings } = await import('./store')
    const settings = getSettings()
    auth.observeSpeechAuthSettings({ settings, readable: true, epoch: settingsEpoch }, policyRevision)
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()

    settingsEpoch += 1
    auth.observeSpeechAuthSettings({ settings, readable: true, epoch: settingsEpoch }, policyRevision)
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(true)

    // No frame or observer saw this intervening store epoch; identical final values cannot prove there
    // was no A → B → A interval, so the prior owner must be retired before refresh republishes.
    settingsEpoch += 1
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
    auth.observeSpeechAuthSettings({ settings, readable: true, epoch: settingsEpoch }, policyRevision)
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
    settingsEpoch += 1
    const next = await auth.refreshSpeechAuthLease()
    expect(next).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
    expect(auth.isSpeechAuthLeaseCurrent(next)).toBe(true)
  })

  it('retires on actual tenant/domain/age failures and on sticky sign-out', async () => {
    configureTenant()
    await writeSessionFile()
    const auth = await prepareAuth()
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()

    process.env.AZURE_TENANT_ID = '00000000-0000-4000-8000-000000000001'
    expect(await auth.refreshSpeechAuthLease()).toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)

    vi.resetModules()
    configureTenant()
    await writeSessionFile()
    const domainAuth = await prepareAuth()
    const domainLease = await domainAuth.refreshSpeechAuthLease()
    expect(domainLease).not.toBeNull()
    // The real authStatus path rejects the cached identity under a changed allowed domain.
    process.env.ASKTOTO_ALLOWED_DOMAIN = 'other.example'
    expect(await domainAuth.refreshSpeechAuthLease()).toBeNull()
    expect(domainAuth.isSpeechAuthLeaseCurrent(domainLease)).toBe(false)

    vi.resetModules()
    configureTenant()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'))
    await writeSessionFile()
    const ageAuth = await prepareAuth()
    const ageLease = await ageAuth.refreshSpeechAuthLease()
    expect(ageLease).not.toBeNull()
    vi.setSystemTime(new Date('2026-10-22T00:00:00.001Z'))
    expect(await ageAuth.refreshSpeechAuthLease()).toBeNull()
    expect(ageAuth.isSpeechAuthLeaseCurrent(ageLease)).toBe(false)
  })

  it('invalidates on observer policy/path changes and profile recovery, including a held refresh result', async () => {
    configureTenant()
    await writeSessionFile()
    const auth = await prepareAuth()
    const invalidated = vi.fn()
    auth.subscribeSpeechAuthLeaseInvalidation(invalidated)
    const afterThrow = vi.fn()
    auth.subscribeSpeechAuthLeaseInvalidation(() => {
      throw new Error('teardown fixture')
    })
    auth.subscribeSpeechAuthLeaseInvalidation(afterThrow)
    const { getSettings } = await import('./store')
    const settings = getSettings()
    auth.observeSpeechAuthSettings({ settings, readable: true, epoch: settingsEpoch }, policyRevision)
    const first = await auth.refreshSpeechAuthLease()
    expect(first).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(first)).toBe(true)
    policyRevision = 'profile-a|policy-b'
    auth.observeSpeechAuthSettings({ settings, readable: true, epoch: settingsEpoch + 1 }, policyRevision)
    expect(auth.isSpeechAuthLeaseCurrent(first)).toBe(false)
    expect(invalidated).toHaveBeenCalled()
    expect(afterThrow).toHaveBeenCalled()

    const pending = auth.refreshSpeechAuthLease()
    auth.invalidateSpeechAuthLease()
    const held = await pending
    expect(auth.isSpeechAuthLeaseCurrent(held)).toBe(false)

    settingsEpoch += 1
    auth.observeSpeechAuthSettings({ settings, readable: true, epoch: settingsEpoch }, policyRevision)
    const second = await auth.refreshSpeechAuthLease()
    expect(second).not.toBeNull()
    auth.setSessionClearedHandler(() => {
      // The root teardown can synchronously re-enter the legacy auth path before profile files archive.
      auth.authStatus()
    })
    const nextProfile = join(ud, 'profile-b')
    mkdirSync(nextProfile)
    auth.resetSpeechAuthProfile()
    expect(auth.isSpeechAuthLeaseCurrent(second)).toBe(false)
    expect(auth.authStatus().signedIn).toBe(false)

    // Root archives profile A after its pre-archive reset and then switches userData to profile B.
    const app = (await import('electron')).app
    activeProfilePath = nextProfile
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) =>
      n === 'userData' ? nextProfile : join(nextProfile, n)
    )
    auth.completeSpeechAuthProfileReset()
    const { encryptSecret } = await import('./secrets')
    writeFileSync(
      join(nextProfile, 'auth-session.bin'),
      encryptSecret(
        JSON.stringify({ email: 'profile-b@example.com', domain: 'example.com', tid: TENANT_GUID, at: Date.now() })
      ),
      { mode: 0o600 }
    )
    const profileBLease = await auth.refreshSpeechAuthLease()
    expect(profileBLease).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(second)).toBe(false)
    expect(auth.isSpeechAuthLeaseCurrent(profileBLease)).toBe(true)
  })

  it('preserves sticky/LKG enforcement and revokes the owner on sign-out', async () => {
    await writeSessionFile()
    writeFileSync(join(ud, 'auth-configured.flag'), '1', { mode: 0o600 })
    writeFileSync(
      join(ud, 'auth-lkg-config.json'),
      JSON.stringify({ clientId: 'client-id', tenantId: TENANT_GUID, allowedDomain: 'example.com' }),
      { mode: 0o600 }
    )
    const auth = await prepareAuth()
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    auth.signOut()
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
    expect(await auth.refreshSpeechAuthLease()).not.toBeNull() // genuine sign-out clears sticky enforcement

    vi.resetModules()
    for (const k of AZURE_ENV) delete process.env[k]
    writeFileSync(join(ud, 'auth-configured.flag'), '1', { mode: 0o600 })
    const stickyAuth = await prepareAuth()
    expect(await stickyAuth.refreshSpeechAuthLease()).toBeNull()
  })

  it('rejects a held real admin-policy read when sign-out changes the captured session epoch', async () => {
    configureTenant()
    await writeSessionFile()
    writeFileSync(join(ud, 'admin-managed-config.json'), '{}', 'utf8')
    const { readTrustedAdminManagedBytes } = await import('./win-security')
    let began!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const auth = await prepareAuth(async (path) => {
      began()
      await gate
      return readTrustedAdminManagedBytes(path)
    })
    const pending = auth.refreshSpeechAuthLease()
    await started
    auth.signOut()
    release()
    expect(await pending).toBeNull()
  })

  it('rejects a held boundary across settings A-to-B-to-A observations', async () => {
    configureTenant()
    await writeSessionFile()
    writeFileSync(join(ud, 'admin-managed-config.json'), '{}', 'utf8')
    const { readTrustedAdminManagedBytes } = await import('./win-security')
    let began!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const auth = await prepareAuth(async (path) => {
      began()
      await gate
      return readTrustedAdminManagedBytes(path)
    })
    const pending = auth.refreshSpeechAuthLease()
    await started
    const { getSettings } = await import('./store')
    const original = getSettings()
    for (const [index, clientId] of ['client-a', 'client-b', 'client-a'].entries()) {
      settingsEpoch += 1
      auth.observeSpeechAuthSettings(
        { settings: { ...original, azureClientId: clientId }, readable: true, epoch: settingsEpoch },
        policyRevision
      )
      if (index < 2) expect(auth.isSpeechAuthLeaseCurrent(null)).toBe(false)
    }
    expect(auth.refreshSpeechAuthLease()).toBe(pending)
    release()
    expect(await pending).toBeNull()
  })

  it('does not treat a present admin policy removed during raw read as absent', async () => {
    const adminPath = join(ud, 'admin-managed-config.json')
    writeFileSync(adminPath, JSON.stringify({ requireAuth: true }), 'utf8')
    let began!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const auth = await prepareAuth(async () => {
      began()
      await gate
      rmSync(adminPath, { force: true })
      return null
    })
    const pending = auth.refreshSpeechAuthLease()
    await started
    release()
    expect(await pending).toBeNull()
  })

  it('shares one held boundary read across concurrent identical refresh requests', async () => {
    configureTenant()
    await writeSessionFile()
    const adminPath = join(ud, 'admin-managed-config.json')
    writeFileSync(adminPath, '{}', 'utf8')
    let began!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Model trusted bytes only for this fixture; readTrustedAdminText retains its real before/after
    // lstat file-stability checks. An ordinary temp file does not establish Windows machine ACL trust.
    const auth = await prepareAuth(async (path) => {
      if (path !== adminPath) throw new Error('Unexpected admin policy fixture path')
      began()
      await gate
      return readFileSync(path)
    })

    const older = auth.refreshSpeechAuthLease()
    await started
    const newer = auth.refreshSpeechAuthLease()
    expect(newer).toBe(older)
    release()
    const freshLease = await newer
    expect(freshLease).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(freshLease)).toBe(true)
    expect(adminBoundaryReads).toBe(1)
  })

  it('closes a boundary whose initial observer reentrantly replaces its readers', async () => {
    const auth = await prepareAuth()
    let unsubscribe = (): void => undefined
    unsubscribe = auth.subscribeSpeechAuthLeaseInvalidation(() => {
      unsubscribe()
      auth.resetSpeechAuthLeaseReaders()
    })

    expect(await auth.refreshSpeechAuthLease()).toBeNull()
    const retry = await prepareAuth()
    const lease = await retry.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    expect(retry.isSpeechAuthLeaseCurrent(lease)).toBe(true)
  })

  it('enforces interactive backoff before starting another flow, audits each failure, and resets after actual sign-in', async () => {
    configureTenant()
    const auth = await prepareAuth()
    const { shell } = await import('electron')
    const logger = await import('./logger')
    const audit = vi.spyOn(logger, 'auditLog').mockImplementation(() => {})
    const requireFixture = createRequire(import.meta.url)
    const msal = requireFixture('@azure/msal-node') as typeof import('@azure/msal-node')
    const http = requireFixture('node:http') as typeof import('node:http')
    const ownedServers = new Set<import('node:http').Server>()
    const originalListen = http.Server.prototype.listen
    const listen = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
      this: import('node:http').Server,
      ...args: Parameters<typeof originalListen>
    ) {
      ownedServers.add(this)
      return Reflect.apply(originalListen, this, args) as ReturnType<typeof originalListen>
    })
    const failure = new Error('synthetic-private-auth-failure')
    const pkce = vi.spyOn(msal.CryptoProvider.prototype, 'generatePkceCodes').mockRejectedValue(failure)
    let callbackUrl = ''
    let state = ''
    const authorize = vi
      .spyOn(msal.PublicClientApplication.prototype, 'getAuthCodeUrl')
      .mockImplementation(async (options) => {
        callbackUrl = options.redirectUri || ''
        state = options.state || ''
        return 'https://login.example.test/authorize'
      })
    const token = vi.spyOn(msal.PublicClientApplication.prototype, 'acquireTokenByCode').mockResolvedValue({
      account: { username: 'user@example.com', name: 'Fixture' },
      idTokenClaims: { tid: TENANT_GUID }
    } as Awaited<ReturnType<typeof msal.PublicClientApplication.prototype.acquireTokenByCode>>)
    const browser = vi.spyOn(shell, 'openExternal').mockImplementation(async () => {
      const response = await fetch(`${callbackUrl}/?code=auth-code&state=${state}`)
      await response.text()
      expect(response.status).toBe(200)
    })
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const delays = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
    audit.mockClear()
    try {
      for (const [index, delay] of delays.entries()) {
        expect(await auth.signIn()).toMatchObject({ ok: false, configured: true })
        expect(auth.signInBackoffRemainingMs()).toBe(delay)
        expect(pkce).toHaveBeenCalledTimes(index + 1)
        expect(await auth.signIn()).toEqual({
          ok: false,
          configured: true,
          error: `Too many failed sign-in attempts. Try again in ${Math.ceil(delay / 1_000)}s.`
        })
        now += delay - 1
        expect(await auth.signIn()).toEqual({
          ok: false,
          configured: true,
          error: 'Too many failed sign-in attempts. Try again in 1s.'
        })
        expect(pkce).toHaveBeenCalledTimes(index + 1)
        expect(listen).not.toHaveBeenCalled()
        expect(authorize).not.toHaveBeenCalled()
        expect(token).not.toHaveBeenCalled()
        expect(browser).not.toHaveBeenCalled()
        now += 1
      }
      expect(audit.mock.calls.filter(([event]) => event === 'auth.signin_failed')).toEqual(
        delays.map((_delay, index) => ['auth.signin_failed', { reason: 'other', consecutive: index + 1 }])
      )
      expect(JSON.stringify(audit.mock.calls)).not.toContain(failure.message)

      pkce.mockResolvedValueOnce({ verifier: 'verifier', challenge: 'challenge' })
      expect(await auth.signIn()).toMatchObject({ ok: true, configured: true, email: 'user@example.com' })
      expect(auth.signInBackoffRemainingMs()).toBe(0)
      expect(pkce).toHaveBeenCalledTimes(8)
      expect(listen).toHaveBeenCalledTimes(1)
      expect(authorize).toHaveBeenCalledTimes(1)
      expect(token).toHaveBeenCalledTimes(1)
      expect(browser).toHaveBeenCalledTimes(1)
      expect(audit).toHaveBeenCalledWith('auth.signin', { domain: 'example.com' })

      expect(await auth.signIn()).toMatchObject({ ok: false, configured: true })
      expect(auth.signInBackoffRemainingMs()).toBe(2_000)
      expect(audit).toHaveBeenLastCalledWith('auth.signin_failed', { reason: 'other', consecutive: 1 })
      expect(JSON.stringify(audit.mock.calls)).not.toContain(failure.message)
    } finally {
      auth.signOut()
      await Promise.all(
        [...ownedServers].map(
          (server) =>
            new Promise<void>((resolveClose) => {
              server.close(() => resolveClose())
              server.closeAllConnections()
            })
        )
      )
      clock.mockRestore()
      listen.mockRestore()
    }
  })

  it('retires the old owner when actual sign-in replaces the in-memory session', async () => {
    configureTenant()
    await writeSessionFile()
    writeFileSync(join(ud, 'admin-managed-config.json'), '{}', 'utf8')
    let callbackUrl = ''
    let state = ''
    let replacementEmail = 'replacement@example.com'
    const msalRequire = createRequire(import.meta.url)
    const msal = msalRequire('@azure/msal-node') as typeof import('@azure/msal-node')
    vi.spyOn(msal.CryptoProvider.prototype, 'generatePkceCodes').mockResolvedValue({
      verifier: 'verifier',
      challenge: 'challenge'
    })
    vi.spyOn(msal.PublicClientApplication.prototype, 'getAuthCodeUrl').mockImplementation(async (options) => {
      callbackUrl = options.redirectUri || ''
      state = options.state || ''
      return 'https://login.example.test/authorize'
    })
    vi.spyOn(msal.PublicClientApplication.prototype, 'acquireTokenByCode').mockImplementation(
      async () =>
        ({
          account: { username: replacementEmail, name: 'Replacement' },
          idTokenClaims: { tid: TENANT_GUID }
        }) as Awaited<ReturnType<typeof msal.PublicClientApplication.prototype.acquireTokenByCode>>
    )
    let adminReads = 0
    let began!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Keep the same test-owned trusted-byte seam while the production reader checks file stability
    // and the lease controller retains its session/profile/settings/authority epoch fences.
    const auth = await prepareAuth(async (path) => {
      if (path !== join(ud, 'admin-managed-config.json')) throw new Error('Unexpected admin policy fixture path')
      adminReads += 1
      if (adminReads === 2) {
        began()
        await gate
      }
      return readFileSync(path)
    })
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    const heldRefresh = auth.refreshSpeechAuthLease()
    await started
    let invalidatedBeforeReplacement = false
    const unsubscribe = auth.subscribeSpeechAuthLeaseInvalidation(() => {
      invalidatedBeforeReplacement =
        !auth.isSpeechAuthLeaseCurrent(lease) && auth.authStatus().email === 'user@example.com'
    })
    const { shell } = await import('electron')
    vi.spyOn(shell, 'openExternal').mockImplementation(async () => {
      const response = await fetch(`${callbackUrl}/?code=auth-code&state=${state}`)
      expect(response.status).toBe(200)
    })

    expect((await auth.signIn()).ok).toBe(true)
    expect(auth.authStatus().email).toBe('replacement@example.com')
    unsubscribe()
    expect(invalidatedBeforeReplacement).toBe(true)
    release()
    expect(await heldRefresh).toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
    const replacementLease = await auth.refreshSpeechAuthLease()
    expect(replacementLease).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(replacementLease)).toBe(true)
    replacementEmail = 'user@example.com'
    expect((await auth.signIn()).ok).toBe(true)
    expect(auth.authStatus().email).toBe('user@example.com')
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
    expect(auth.isSpeechAuthLeaseCurrent(replacementLease)).toBe(false)
    const returnedLease = await auth.refreshSpeechAuthLease()
    expect(returnedLease).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(returnedLease)).toBe(true)
  })

  it('does not publish a held boundary after wall-clock rollback', async () => {
    configureTenant()
    vi.useFakeTimers()
    const start = new Date('2026-10-14T00:00:00.000Z').getTime()
    vi.setSystemTime(start)
    await writeSessionFile(TENANT_GUID, 'user@example.com', start - 1_000)
    writeFileSync(join(ud, 'admin-managed-config.json'), '{}', 'utf8')
    let began!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { readTrustedAdminManagedBytes } = await import('./win-security')
    const auth = await prepareAuth(async (path) => {
      began()
      await gate
      return readTrustedAdminManagedBytes(path)
    })
    const pending = auth.refreshSpeechAuthLease()
    await started
    vi.setSystemTime(start - 1)
    release()
    expect(await pending).toBeNull()
  })

  it('retires an owner when its session reaches seven days before its lease expires', async () => {
    configureTenant()
    vi.useFakeTimers()
    const start = new Date('2026-10-14T00:00:00.000Z').getTime()
    vi.setSystemTime(start)
    await writeSessionFile(TENANT_GUID, 'user@example.com', start - 7 * 24 * 60 * 60 * 1000 + 100)
    const auth = await prepareAuth()
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    vi.advanceTimersByTime(101)
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
  })

  it('does not retire a fresh latest owner during identical t0/t30/t61 refreshes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'))
    const auth = await prepareAuth()
    const { getSettings } = await import('./store')
    auth.observeSpeechAuthSettings({ settings: getSettings(), readable: true, epoch: settingsEpoch }, policyRevision)
    const invalidated = vi.fn()
    auth.subscribeSpeechAuthLeaseInvalidation(invalidated)
    const first = await auth.refreshSpeechAuthLease()
    expect(first).not.toBeNull()
    vi.advanceTimersByTime(30_000)
    const second = await auth.refreshSpeechAuthLease()
    expect(second).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(first)).toBe(true)
    vi.advanceTimersByTime(31_000)
    const third = await auth.refreshSpeechAuthLease()
    expect(third).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(second)).toBe(true)
    expect(invalidated).not.toHaveBeenCalled()
  })

  it('rejects a rolled-back clock and expires at the one-minute boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'))
    const auth = await prepareAuth()
    const lease = await auth.refreshSpeechAuthLease()
    expect(lease).not.toBeNull()
    vi.setSystemTime(new Date('2026-10-13T23:59:59.999Z'))
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false)
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'))
    const fresh = await auth.refreshSpeechAuthLease()
    expect(fresh).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(lease)).toBe(false) // an observed rollback cannot revive the old owner
    vi.advanceTimersByTime(60_000)
    expect(auth.isSpeechAuthLeaseCurrent(fresh)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(auth.isSpeechAuthLeaseCurrent(fresh)).toBe(false)
    const recovered = await auth.refreshSpeechAuthLease()
    expect(recovered).not.toBeNull()
    expect(auth.isSpeechAuthLeaseCurrent(fresh)).toBe(false) // idle expiry retires the old owner before recovery
  })
})
