import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AccountInfo, AuthenticationResult } from '@azure/msal-node'

vi.mock('electron')
vi.mock('./logger', () => ({
  auditLog: vi.fn(),
  setAuditActor: vi.fn(),
  mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}))
vi.mock('./win-security', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./win-security')>()),
  readTrustedAdminManaged: vi.fn(() => null)
}))

const TENANT = '00000000-0000-4000-8000-000000000001'
const requireMsal = createRequire(import.meta.url)
const msal = requireMsal('@azure/msal-node') as typeof import('@azure/msal-node')
const revoked = () => Object.assign(new Error('Synthetic revoked refresh token'), { errorCode: 'invalid_grant' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('actual auth revalidation keeps revocation bound to its session owner', () => {
  let root: string
  let profile: string
  let auth: typeof import('./auth')
  let electron: typeof import('electron')
  let auditLog: typeof import('./logger')['auditLog']
  let accounts: AccountInfo[]
  let silent: MockInstance<typeof msal.PublicClientApplication.prototype.acquireTokenSilent>
  let teardown: ReturnType<typeof vi.fn<() => void>>

  const account = (username: string): AccountInfo => ({
    username,
    homeAccountId: username,
    localAccountId: username,
    environment: 'login.example.test',
    tenantId: TENANT
  })

  async function writeSession(email = 'owner-a@example.test'): Promise<void> {
    const { encryptSecret } = await import('./secrets')
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(profile, 'auth-session.bin'),
      encryptSecret(
        JSON.stringify({
          email,
          name: 'Synthetic owner',
          domain: 'example.test',
          tid: TENANT,
          at: Date.now()
        })
      )
    )
    writeFileSync(join(profile, 'msal-cache.bin'), 'SYNTHETIC_CACHE_SENTINEL')
  }

  beforeEach(async () => {
    vi.resetModules()
    auditLog = (await import('./logger')).auditLog
    vi.mocked(auditLog).mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'))
    root = mkdtempSync(join(tmpdir(), 'asktoto-auth-revalidation-'))
    profile = join(root, 'profile-a')
    electron = await import('electron')
    vi.mocked(electron.app.getPath).mockImplementation((name) => (name === 'userData' ? profile : join(profile, name)))
    vi.stubEnv('AZURE_CLIENT_ID', 'synthetic-client')
    vi.stubEnv('AZURE_TENANT_ID', TENANT)
    vi.stubEnv('ASKTOTO_ALLOWED_DOMAIN', 'example.test')
    accounts = [account('owner-a@example.test')]
    const cache = { getAllAccounts: vi.fn(async () => accounts) }
    vi.spyOn(msal.PublicClientApplication.prototype, 'getTokenCache').mockReturnValue(
      cache as unknown as ReturnType<typeof msal.PublicClientApplication.prototype.getTokenCache>
    )
    silent = vi.spyOn(msal.PublicClientApplication.prototype, 'acquireTokenSilent')
    await writeSession()
    auth = await import('./auth')
    teardown = vi.fn<() => void>()
    auth.setSessionClearedHandler(teardown)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  async function holdSweep() {
    const probe = deferred<AuthenticationResult>()
    silent.mockReturnValueOnce(probe.promise)
    expect(auth.authStatus().email).toBe('owner-a@example.test')
    await vi.advanceTimersByTimeAsync(10_000) // real authStatus-installed startup sweep
    expect(silent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        account: expect.objectContaining({ username: 'owner-a@example.test' }),
        forceRefresh: true
      })
    )
    return probe
  }

  async function finishRevoked(probe: ReturnType<typeof deferred<AuthenticationResult>>) {
    probe.reject(revoked())
    await vi.advanceTimersByTimeAsync(0)
  }

  function expectNoStaleRevocation(calls: number): void {
    expect(teardown).toHaveBeenCalledTimes(calls)
    expect(auditLog).not.toHaveBeenCalledWith('auth.refresh_failed', {})
  }

  it('clears the current revoked session, disk caches and actual teardown callback once', async () => {
    const probe = await holdSweep()
    await finishRevoked(probe)
    expect(auth.authStatus().signedIn).toBe(false)
    expect(existsSync(join(profile, 'auth-session.bin'))).toBe(false)
    expect(existsSync(join(profile, 'msal-cache.bin'))).toBe(false)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(auditLog).toHaveBeenCalledWith('auth.refresh_failed', {})
  })

  it('does not revoke a new session installed by actual interactive sign-in while A is held', async () => {
    const probe = await holdSweep()
    let redirect = ''
    let state = ''
    vi.spyOn(msal.CryptoProvider.prototype, 'generatePkceCodes').mockResolvedValue({
      verifier: 'verifier',
      challenge: 'challenge'
    })
    vi.spyOn(msal.PublicClientApplication.prototype, 'getAuthCodeUrl').mockImplementation(async (options) => {
      redirect = options.redirectUri || ''
      state = options.state || ''
      return 'https://login.example.test/authorize'
    })
    vi.spyOn(msal.PublicClientApplication.prototype, 'acquireTokenByCode').mockResolvedValue({
      account: account('owner-b@example.test'),
      idTokenClaims: { tid: TENANT }
    } as AuthenticationResult)
    vi.mocked(electron.shell.openExternal).mockImplementation(async () => {
      const response = await fetch(`${redirect}/?code=synthetic-code&state=${state}`)
      expect(response.status).toBe(200)
    })
    // Only timers are fake; the existing loopback callback and real saveSession remain production code.
    expect((await auth.signIn()).ok).toBe(true)
    expect(auth.authStatus().email).toBe('owner-b@example.test')
    expect(teardown).toHaveBeenCalledTimes(1)
    const saved = readFileSync(join(profile, 'auth-session.bin'))
    const cache = readFileSync(join(profile, 'msal-cache.bin'))
    await finishRevoked(probe)
    expect(auth.authStatus().email).toBe('owner-b@example.test')
    expect(readFileSync(join(profile, 'auth-session.bin'))).toEqual(saved)
    expect(readFileSync(join(profile, 'msal-cache.bin'))).toEqual(cache)
    expectNoStaleRevocation(1)
  })

  it('does not repeat teardown or revocation audit after actual sign-out', async () => {
    const probe = await holdSweep()
    auth.signOut()
    expect(teardown).toHaveBeenCalledTimes(1)
    await finishRevoked(probe)
    expect(auth.authStatus().signedIn).toBe(false)
    expectNoStaleRevocation(1)
  })

  it('does not touch a replacement profile even before another auth read loads it', async () => {
    const probe = await holdSweep()
    profile = join(root, 'profile-b')
    await writeSession('owner-b@example.test')
    const saved = readFileSync(join(profile, 'auth-session.bin'))
    await finishRevoked(probe)
    expect(readFileSync(join(profile, 'auth-session.bin'))).toEqual(saved)
    expect(readFileSync(join(profile, 'msal-cache.bin'), 'utf8')).toBe('SYNTHETIC_CACHE_SENTINEL')
    expectNoStaleRevocation(0)
    expect(auth.authStatus().email).toBe('owner-b@example.test')
  })

  it('keeps an A→B→A profile return retired, even with the same identity and original bytes', async () => {
    const probe = await holdSweep()
    const originalProfile = profile
    profile = join(root, 'profile-b')
    await writeSession('owner-b@example.test')
    expect(auth.authStatus().email).toBe('owner-b@example.test')
    profile = originalProfile
    expect(auth.authStatus().email).toBe('owner-a@example.test')
    const saved = readFileSync(join(profile, 'auth-session.bin'))
    const calls = teardown.mock.calls.length
    await finishRevoked(probe)
    expect(auth.authStatus().email).toBe('owner-a@example.test')
    expect(readFileSync(join(profile, 'auth-session.bin'))).toEqual(saved)
    expectNoStaleRevocation(calls)
  })

  it.each(['valid', 'unknown'] as const)('preserves an unchanged owner for a %s probe result', async (outcome) => {
    const probe = await holdSweep()
    if (outcome === 'valid') probe.resolve({ accessToken: 'synthetic-token' } as AuthenticationResult)
    else probe.reject(new Error('Synthetic offline failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(auth.authStatus().email).toBe('owner-a@example.test')
    expect(existsSync(join(profile, 'auth-session.bin'))).toBe(true)
    expectNoStaleRevocation(0)
  })
})
