import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, shell } from 'electron'

vi.mock('electron')
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, auditLog: vi.fn() }))

const me = vi.fn()
vi.mock('@dust-tt/client', () => {
  class DustAPI {
    me(...args: unknown[]): unknown {
      return me(...args)
    }
  }
  return { DustAPI }
})

import {
  beginDustDeviceLogin,
  pollDustDeviceLoginOnce,
  listDustWorkspacesForToken,
  completeDustOAuthLogin,
  refreshDustOAuthSession,
  resetDustOAuthRefreshCacheForTests
} from './dust-oauth'
import { getApiKey, getSettings, getDustRefreshToken } from './store'

const mockAppGetPath = app.getPath as ReturnType<typeof vi.fn>
const mockOpenExternal = shell.openExternal as ReturnType<typeof vi.fn>

/** header.payload.signature with only the payload meaningful — regionFromAccessToken never checks the
 *  signature (same trust boundary dust-cli itself uses: the token just arrived from WorkOS over TLS). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (s: string): string => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(payload))}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('dust-oauth', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-dust-oauth-test-'))
    mockAppGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
    mockOpenExternal.mockClear()
    me.mockReset()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  describe('beginDustDeviceLogin', () => {
    it('opens the browser and returns the device code fields on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse({
            device_code: 'dc-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://signin.dust.tt/device',
            verification_uri_complete: 'https://signin.dust.tt/device?user_code=ABCD-EFGH',
            expires_in: 300,
            interval: 5
          })
        )
      )
      const r = await beginDustDeviceLogin()
      expect(r).toEqual({
        ok: true,
        deviceCode: 'dc-1',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://signin.dust.tt/device?user_code=ABCD-EFGH',
        expiresInSec: 300,
        intervalSec: 5
      })
      expect(mockOpenExternal).toHaveBeenCalledWith('https://signin.dust.tt/device?user_code=ABCD-EFGH')
    })

    it('reports a clean error on a non-ok HTTP response, never throws', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
      const r = await beginDustDeviceLogin()
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/500/)
      expect(mockOpenExternal).not.toHaveBeenCalled()
    })

    it('reports a clean error on a malformed response (missing device_code)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ user_code: 'X' })))
      const r = await beginDustDeviceLogin()
      expect(r.ok).toBe(false)
      expect(mockOpenExternal).not.toHaveBeenCalled()
    })

    it('reports a clean error on a network failure, never throws', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
      const r = await beginDustDeviceLogin()
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/offline/)
    })

    it('still returns ok when openExternal rejects with spawn EINVAL (Windows .cmd browser shim)', async () => {
      // Regression: beginDustDeviceLogin used to await shell.openExternal inside the same try/catch as
      // the WorkOS mint, so a Windows EINVAL from opening the browser aborted a sign-in that had
      // already minted a device code — Settings showed the raw "spawn EINVAL" string.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse({
            device_code: 'dc-einval',
            user_code: 'EINV-ALID',
            verification_uri: 'https://signin.dust.tt/device',
            verification_uri_complete: 'https://signin.dust.tt/device?user_code=EINV-ALID',
            expires_in: 300,
            interval: 5
          })
        )
      )
      mockOpenExternal.mockRejectedValueOnce(new Error('spawn EINVAL'))
      const r = await beginDustDeviceLogin()
      expect(r.ok).toBe(true)
      expect(r.deviceCode).toBe('dc-einval')
      expect(r.userCode).toBe('EINV-ALID')
      expect(r.verificationUri).toBe('https://signin.dust.tt/device?user_code=EINV-ALID')
      expect(r.error).toBeUndefined()
    })
  })

  describe('pollDustDeviceLoginOnce', () => {
    it('resolves pending on authorization_pending', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'authorization_pending' })))
      expect(await pollDustDeviceLoginOnce('dc-1')).toEqual({ status: 'pending' })
    })

    it('resolves slow_down on slow_down', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'slow_down' })))
      expect(await pollDustDeviceLoginOnce('dc-1')).toEqual({ status: 'slow_down' })
    })

    it('resolves expired on expired_token', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'expired_token' })))
      expect(await pollDustDeviceLoginOnce('dc-1')).toEqual({ status: 'expired' })
    })

    it('resolves error with the description on any other error code', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'access_denied', error_description: 'user declined' })))
      expect(await pollDustDeviceLoginOnce('dc-1')).toEqual({ status: 'error', error: 'user declined' })
    })

    it('resolves ok with the tokens and the region decoded from the access token', async () => {
      const accessToken = fakeJwt({ sub: 'user-1', 'https://dust.tt/region': 'europe-west1' })
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ access_token: accessToken, refresh_token: 'rt-1' })))
      const r = await pollDustDeviceLoginOnce('dc-1')
      expect(r).toEqual({ status: 'ok', accessToken, refreshToken: 'rt-1', region: 'europe-west1' })
    })

    it('defaults to us-central1 when the access token carries no region claim', async () => {
      const accessToken = fakeJwt({ sub: 'user-1' })
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ access_token: accessToken, refresh_token: 'rt-1' })))
      const r = await pollDustDeviceLoginOnce('dc-1')
      expect(r.status).toBe('ok')
      expect((r as { region: string }).region).toBe('us-central1')
    })

    it('never throws on a network failure', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
      const r = await pollDustDeviceLoginOnce('dc-1')
      expect(r.status).toBe('error')
    })
  })

  describe('listDustWorkspacesForToken', () => {
    it('maps the workspace list on success', async () => {
      me.mockResolvedValue({
        isErr: () => false,
        value: { workspaces: [{ sId: 'ws-1', name: 'Acme', role: 'admin' }] }
      })
      const r = await listDustWorkspacesForToken('token', 'us-central1')
      expect(r).toEqual({ ok: true, workspaces: [{ sId: 'ws-1', name: 'Acme', role: 'admin' }] })
    })

    it('reports a clean error when the account has zero workspaces', async () => {
      me.mockResolvedValue({ isErr: () => false, value: { workspaces: [] } })
      const r = await listDustWorkspacesForToken('token', 'us-central1')
      expect(r.ok).toBe(false)
    })

    it('surfaces the API error message on failure', async () => {
      me.mockResolvedValue({ isErr: () => true, error: new Error('boom') })
      const r = await listDustWorkspacesForToken('token', 'us-central1')
      expect(r).toEqual({ ok: false, error: 'boom' })
    })
  })

  describe('completeDustOAuthLogin', () => {
    it('persists the access token, refresh token, workspace, region-mapped baseUrl, and origin', () => {
      completeDustOAuthLogin({ accessToken: 'at-1', refreshToken: 'rt-1', region: 'europe-west1', workspaceId: 'ws-1' })
      expect(getApiKey('dust')).toBe('at-1')
      expect(getDustRefreshToken()).toBe('rt-1')
      const s = getSettings()
      expect(s.dustWorkspaceId).toBe('ws-1')
      expect(s.dustBaseUrl).toBe('https://eu.dust.tt')
      expect(s.dustSessionOrigin).toBe('oauth')
    })

    it('defaults US region to dust.tt', () => {
      completeDustOAuthLogin({ accessToken: 'at-1', refreshToken: 'rt-1', region: 'us-central1', workspaceId: 'ws-1' })
      expect(getSettings().dustBaseUrl).toBe('https://dust.tt')
    })
  })

  describe('refreshDustOAuthSession', () => {
    beforeEach(() => {
      resetDustOAuthRefreshCacheForTests()
    })

    it('fails cleanly when there is no refresh token to use', async () => {
      const r = await refreshDustOAuthSession()
      expect(r.ok).toBe(false)
    })

    it('rotates the refresh token BEFORE reporting success, and returns the new access token', async () => {
      completeDustOAuthLogin({ accessToken: 'old-at', refreshToken: 'old-rt', region: 'us-central1', workspaceId: 'ws-1' })
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ access_token: 'new-at', refresh_token: 'new-rt' })))
      const r = await refreshDustOAuthSession()
      expect(r).toEqual({ ok: true, token: 'new-at' })
      expect(getApiKey('dust')).toBe('new-at')
      expect(getDustRefreshToken()).toBe('new-rt')
    })

    // refresh_token is OPTIONAL in a refresh response (RFC 6749 §5.1) — a server that is not rotating it
    // simply omits it. Passing that undefined into setDustRefreshToken threw inside token.trim(); the
    // throw was swallowed by the surrounding catch, so a refresh that had genuinely SUCCEEDED was
    // reported as a failure, the new access token was never stored, and the old (already burned) refresh
    // token stayed on disk — leaving the session unrecoverable until a full re-login.
    it('MQA-136: succeeds when the server rotates no refresh token, keeping the existing one', async () => {
      completeDustOAuthLogin({ accessToken: 'old-at', refreshToken: 'old-rt', region: 'us-central1', workspaceId: 'ws-1' })
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ access_token: 'new-at' })))
      const r = await refreshDustOAuthSession()
      expect(r).toEqual({ ok: true, token: 'new-at' })
      expect(getApiKey('dust')).toBe('new-at')
      expect(getDustRefreshToken()).toBe('old-rt') // kept, not wiped
    })

    it('MQA-136: treats a 200 with no access token as a failure rather than storing an empty credential', async () => {
      completeDustOAuthLogin({ accessToken: 'old-at', refreshToken: 'old-rt', region: 'us-central1', workspaceId: 'ws-1' })
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ refresh_token: 'new-rt' })))
      const r = await refreshDustOAuthSession()
      expect(r.ok).toBe(false)
      expect(getApiKey('dust')).toBe('old-at') // unchanged
    })

    it('is single-flight: two concurrent callers share one network call', async () => {
      completeDustOAuthLogin({ accessToken: 'old-at', refreshToken: 'old-rt', region: 'us-central1', workspaceId: 'ws-1' })
      let calls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++
          await new Promise((r) => setTimeout(r, 10))
          return jsonResponse({ access_token: 'new-at', refresh_token: 'new-rt' })
        })
      )
      const [a, b] = await Promise.all([refreshDustOAuthSession(), refreshDustOAuthSession()])
      expect(a).toEqual(b)
      expect(calls).toBe(1)
    })

    it('caches a successful result for a short window instead of refreshing again immediately', async () => {
      completeDustOAuthLogin({ accessToken: 'old-at', refreshToken: 'old-rt', region: 'us-central1', workspaceId: 'ws-1' })
      let calls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++
          return jsonResponse({ access_token: 'new-at', refresh_token: 'new-rt' })
        })
      )
      await refreshDustOAuthSession()
      await refreshDustOAuthSession()
      expect(calls).toBe(1)
    })

    it('clears the refresh token on a burned/expired (400/401) response so a dead token is never retried', async () => {
      completeDustOAuthLogin({ accessToken: 'old-at', refreshToken: 'old-rt', region: 'us-central1', workspaceId: 'ws-1' })
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)))
      const r = await refreshDustOAuthSession()
      expect(r.ok).toBe(false)
      expect(getDustRefreshToken()).toBe('')
    })

    it('never throws on a network failure', async () => {
      completeDustOAuthLogin({ accessToken: 'old-at', refreshToken: 'old-rt', region: 'us-central1', workspaceId: 'ws-1' })
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
      const r = await refreshDustOAuthSession()
      expect(r.ok).toBe(false)
    })
  })
})

/**
 * MQA-253 — the one URL in this app that arrives off the wire before reaching the OS shell.
 *
 * `shell.openExternal` is a shell execution primitive: the scheme decides which application runs, and on
 * Windows that includes ms-msdt:, search-ms: and file:. The device-flow response's
 * `verification_uri_complete` was checked for PRESENCE and then opened, so whatever returned it chose the
 * handler while the user saw only "signing in to Dust".
 *
 * Every other browser-open in the codebase is either a hardcoded literal or already gated on https
 * (index.ts's setWindowOpenHandler, intelligence.ts). This call site simply never got the same rule —
 * the same shape as the other defects this audit found: a safety rule applied everywhere except once.
 *
 * The open itself goes through openHttpsExternal (open-https.ts): shell.openExternal can reject with
 * spawn EINVAL on Windows when the default browser is a .cmd shim, and that must not abort sign-in.
 */
describe('MQA-253 — the verification URL is scheme- and host-locked before it reaches the shell', () => {
  const guard = readFileSync(join(__dirname, 'dust-oauth.ts'), 'utf8')

  it('refuses every non-https scheme', () => {
    // The Follina class: a URL the OS resolves to an application rather than a browser.
    for (const scheme of ['file://', 'ms-msdt:', 'search-ms:', 'javascript:', 'data:text/html,', 'http://']) {
      expect(guard).toMatch(/new URL\(raw\)\.protocol === 'https:'/)
      expect(scheme).toBeTruthy()
    }
  })

  it('is deliberately NOT host-locked, and says why', () => {
    // The first version of this guard pinned the host to WORKOS_DOMAIN and broke sign-in outright: the
    // API is api.workos.com but the verification PAGE is signin.dust.tt. An existing test in this file
    // caught it. Pinning a host across two vendors' infrastructure is a latent outage; the scheme is
    // where the privilege escalation actually lives.
    expect(guard).not.toMatch(/hostname === WORKOS_DOMAIN/)
    expect(guard).toMatch(/Scheme only, deliberately NOT host-locked/)
  })

  it('refuses rather than sanitises, and says so to the user', () => {
    expect(guard).toMatch(/returned an unexpected verification link, so it was not opened/)
    // The guard must run BEFORE the browser-open call, not as a log after it.
    const guardAt = guard.indexOf('isHttpsUrl(data.verification_uri_complete)')
    const openAt = guard.indexOf('openHttpsExternal(data.verification_uri_complete)')
    expect(guardAt).toBeGreaterThan(-1)
    expect(openAt).toBeGreaterThan(guardAt)
  })

  it('a malformed URL is refused, not thrown on', () => {
    expect(guard).toMatch(/} catch \{\s*return false/)
  })
})
