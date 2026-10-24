import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

// auth.ts loads MSAL with a runtime require(), which vi.mock does not intercept: spy on the real prototypes instead
// (same pattern as auth.revalidation.test.ts).
const msal = createRequire(import.meta.url)('@azure/msal-node') as typeof import('@azure/msal-node')
const msalMocks = {
  getAllAccounts: vi.fn(),
  acquireTokenSilent: vi.fn(),
  InteractionRequiredAuthError: class extends msal.InteractionRequiredAuthError {
    constructor(errorCode: string) {
      super(errorCode, 'provider error detail')
    }
  }
}

vi.mock('electron')
vi.mock('./store', () => ({ getSettings: vi.fn(() => ({})), setSettings: vi.fn() }))
vi.mock('./logger', () => ({
  auditLog: vi.fn(),
  mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  setAuditActor: vi.fn()
}))
vi.mock('./win-security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./win-security')>()
  return {
    ...actual,
    adminManagedConfigPath: vi.fn(() => '/unused-in-test'),
    readTrustedAdminManaged: vi.fn(() => null)
  }
})

import { getGraphToken, getGraphTokenOutcome } from './auth'
import { encryptSecret } from './secrets'

const TENANT_ID = '00000000-0000-4000-8000-000000000001'
const CONFIG_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN'] as const
const savedEnv = Object.fromEntries(CONFIG_ENV.map((key) => [key, process.env[key]]))
let userDataPath = ''

function configure(): void {
  process.env.AZURE_CLIENT_ID = '00000000-0000-4000-8000-000000000002'
  process.env.AZURE_TENANT_ID = TENANT_ID
  process.env.ASKTOTO_ALLOWED_DOMAIN = 'example.test'
}

function writeSignedInSession(): void {
  writeFileSync(
    join(userDataPath, 'auth-session.bin'),
    encryptSecret(
      JSON.stringify({ email: 'alice@example.test', domain: 'example.test', tid: TENANT_ID, at: Date.now() })
    ),
    { mode: 0o600 }
  )
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'asktoto-graph-token-test-'))
  ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
    name === 'userData' ? userDataPath : join(userDataPath, name)
  )
  for (const key of CONFIG_ENV) delete process.env[key]
  msalMocks.getAllAccounts.mockReset()
  msalMocks.acquireTokenSilent.mockReset()
  msalMocks.getAllAccounts.mockResolvedValue([{ username: 'alice@example.test' }])
  msalMocks.acquireTokenSilent.mockResolvedValue({ accessToken: 'test-access-token' })
  vi.spyOn(msal.PublicClientApplication.prototype, 'getTokenCache').mockReturnValue({
    getAllAccounts: msalMocks.getAllAccounts
  } as unknown as ReturnType<typeof msal.PublicClientApplication.prototype.getTokenCache>)
  vi.spyOn(msal.PublicClientApplication.prototype, 'acquireTokenSilent').mockImplementation(
    (request) => msalMocks.acquireTokenSilent(request) as never
  )
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
  for (const key of CONFIG_ENV) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

describe('getGraphTokenOutcome', () => {
  it('distinguishes missing configuration from a missing signed-in cache account', async () => {
    await expect(getGraphTokenOutcome(['User.Read'])).resolves.toEqual({ ok: false, reason: 'not_configured' })

    configure()
    writeSignedInSession()
    msalMocks.getAllAccounts.mockResolvedValue([])
    await expect(getGraphTokenOutcome(['User.Read'])).resolves.toEqual({ ok: false, reason: 'no_account' })
  })

  it('returns the bound account token on silent acquisition success', async () => {
    configure()
    writeSignedInSession()

    await expect(getGraphTokenOutcome(['User.Read'])).resolves.toEqual({ ok: true, token: 'test-access-token' })
    expect(msalMocks.acquireTokenSilent).toHaveBeenCalledOnce()
  })

  it('classifies the MSAL interaction-required error class without exposing provider text', async () => {
    configure()
    writeSignedInSession()
    msalMocks.acquireTokenSilent.mockRejectedValue(
      new msalMocks.InteractionRequiredAuthError('unknown_ms_al_interaction')
    )

    const outcome = await getGraphTokenOutcome(['User.Read'])

    expect(outcome).toEqual({ ok: false, reason: 'interaction_required' })
    expect(JSON.stringify(outcome)).not.toContain('provider error detail')
  })

  it.each([
    'invalid_grant',
    'no_tokens_found',
    'refresh_token_expired',
    'ui_not_allowed',
    'consent_required',
    'interaction_required',
    'login_required',
    'bad_token',
    'interrupted_user'
  ])('classifies MSAL errorCode %s as requiring interaction', async (errorCode) => {
    configure()
    writeSignedInSession()
    msalMocks.acquireTokenSilent.mockRejectedValue(Object.assign(new Error('provider detail'), { errorCode }))

    await expect(getGraphTokenOutcome(['User.Read'])).resolves.toEqual({
      ok: false,
      reason: 'interaction_required'
    })
  })

  it('classifies a thrown network error as transient and the legacy wrapper still returns null', async () => {
    configure()
    writeSignedInSession()
    msalMocks.acquireTokenSilent.mockRejectedValue(new Error('network timeout with provider detail'))

    const outcome = await getGraphTokenOutcome(['User.Read'])

    expect(outcome).toEqual({ ok: false, reason: 'transient' })
    expect(JSON.stringify(outcome)).not.toContain('provider detail')
    await expect(getGraphToken(['User.Read'])).resolves.toBeNull()
  })
})
