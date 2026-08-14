import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
