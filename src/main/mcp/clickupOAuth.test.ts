/**
 * clickupOAuth.test.ts — proves the OAuth mechanics against a REAL loopback HTTP callback (not a mock of
 * the flow's own server), mirroring bidstackClient.test.ts's "real local server, not just types" stance.
 *
 * shell.openExternal is stubbed to CAPTURE the authorize URL instead of actually opening a browser; the
 * test then plays the browser's role by making a real HTTP request to the redirect_uri embedded in that
 * URL, carrying the code/state ClickUp's authorize page would have appended. Dynamic Client Registration
 * and the token endpoint are the only genuinely external calls, so `fetch` is mocked for those.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const openExternal = vi.fn(async (_url: string) => {})
// The real, unstubbed fetch — used only by the test itself to simulate the browser's callback hit
// against the flow's real loopback HTTP server. vi.stubGlobal('fetch', ...) below replaces the global
// the module under test calls for DCR/token requests; capturing the real one first keeps this test's
// OWN network call (to 127.0.0.1) working after that stub is installed.
const realFetch = globalThis.fetch.bind(globalThis)

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? '/tmp/asktoto-clickup-oauth-fallback' : `/tmp/${name}`))
  },
  shell: { openExternal },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
    decryptString: vi.fn((buffer: Buffer) => {
      const s = buffer.toString('utf8')
      return s.startsWith('enc:') ? s.slice(4) : s
    })
  }
}))

const DCR_RESPONSE = { client_id: 'clickup-client-abc' }
const TOKEN_RESPONSE = { access_token: 'clickup-at-1', refresh_token: 'clickup-rt-1', token_type: 'bearer' }

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: async () => body
  } as Response
}

describe('clickupOAuth — OAuth 2.1 + PKCE connect flow', () => {
  let userData: string
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    openExternal.mockClear()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-clickup-oauth-test-'))
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  /** Extract redirect_uri + state from the authorize URL captured via the mocked shell.openExternal. */
  function capturedAuthorizeParams(): { redirectUri: string; state: string; verifierChallenge: string } {
    expect(openExternal).toHaveBeenCalledTimes(1)
    const authUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authUrl.origin + authUrl.pathname).toBe('https://mcp.clickup.com/oauth/authorize')
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    return {
      redirectUri: authUrl.searchParams.get('redirect_uri') || '',
      state: authUrl.searchParams.get('state') || '',
      verifierChallenge: authUrl.searchParams.get('code_challenge') || ''
    }
  }

  /** Simulate the browser's callback hit against the loopback server the flow bound. */
  async function hitCallback(redirectUri: string, params: Record<string, string>): Promise<Response> {
    const u = new URL(redirectUri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return realFetch(u.toString())
  }

  it('registers a fresh client per run whose DCR body is this run\'s exact ported loopback URI', async () => {
    const dcrBodies: unknown[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth/register')) {
        dcrBodies.push(JSON.parse(String(init?.body || '{}')))
        return jsonResponse({ client_id: `clickup-client-${dcrBodies.length}` })
      }
      if (url.includes('/oauth/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { runClickupOAuth } = await import('./clickupOAuth')

    const first = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(dcrBodies).toHaveLength(1)
    expect(dcrBodies[0]).toMatchObject({
      client_name: 'Métis',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
    const cbRes = await hitCallback(redirectUri, { code: 'auth-code-1', state })
    expect(cbRes.status).toBe(200)
    const result = await first
    expect(result).toEqual({ ok: true, accessToken: 'clickup-at-1', refreshToken: 'clickup-rt-1' })

    // Second run: ephemeral port will differ, so DCR must run again with THAT run's URI — never reuse.
    openExternal.mockClear()
    const second = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const p2 = capturedAuthorizeParams()
    expect(dcrBodies).toHaveLength(2)
    expect((dcrBodies[1] as { redirect_uris: string[] }).redirect_uris).toEqual([p2.redirectUri])
    await hitCallback(p2.redirectUri, { code: 'auth-code-2', state: p2.state })
    await second
    const authUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get('client_id')).toBe('clickup-client-2')
  })

  it('does not reuse a cached client_id registered with a different (portless) URI', async () => {
    const { setSettings, getSettings } = await import('../store')
    setSettings({ clickupClientId: 'cached-portless-client' })
    expect(getSettings().clickupClientId).toBe('cached-portless-client')

    const capturedDcr: { redirect_uris?: string[] } = {}
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth/register')) {
        Object.assign(capturedDcr, JSON.parse(String(init?.body || '{}')) as { redirect_uris?: string[] })
        return jsonResponse({ client_id: 'fresh-ported-client' })
      }
      if (url.includes('/oauth/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(capturedDcr.redirect_uris).toEqual([redirectUri])
    const authUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get('client_id')).toBe('fresh-ported-client')
    expect(authUrl.searchParams.get('client_id')).not.toBe('cached-portless-client')
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    await flow
    expect(getSettings().clickupClientId).toBe('fresh-ported-client')
  })

  it('sends the PKCE verifier on the token exchange (not just the challenge on authorize)', async () => {
    let capturedTokenBody = ''
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      if (url.includes('/oauth/token')) {
        capturedTokenBody = String(init?.body || '')
        return jsonResponse(TOKEN_RESPONSE)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    await flow

    const body = new URLSearchParams(capturedTokenBody)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code-1')
    expect(body.get('client_id')).toBe('clickup-client-abc')
    expect(body.get('redirect_uri')).toBe(redirectUri)
    expect(body.get('code_verifier')).toBeTruthy()
    expect(body.get('code_verifier')!.length).toBeGreaterThanOrEqual(43) // RFC 7636 floor
  })

  it('binds the loopback server to the literal 127.0.0.1, never 0.0.0.0 or localhost', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      if (url.includes('/oauth/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    expect(new URL(redirectUri).hostname).toBe('127.0.0.1')
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    await flow
  })

  it('rejects a callback whose state does not match, and keeps listening for the real one', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      if (url.includes('/oauth/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()

    const badRes = await hitCallback(redirectUri, { code: 'attacker-code', state: 'wrong-state' })
    expect(badRes.status).toBe(400)

    // The flow is still alive — completing it now with the CORRECT state still succeeds.
    const goodRes = await hitCallback(redirectUri, { code: 'auth-code-1', state })
    expect(goodRes.status).toBe(200)
    const result = await flow
    expect(result.ok).toBe(true)
  })

  it('returns a typed failure (never throws) when the browser reports access_denied', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { error: 'access_denied', error_description: 'user denied access', state })
    const result = await flow
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/denied/i)
  })

  it('returns a typed failure when the token endpoint rejects the code', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      if (url.includes('/oauth/token')) {
        return jsonResponse({ error: 'invalid_grant', error_description: 'code expired' }, false, 400)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'stale-code', state })
    const result = await flow
    expect(result).toEqual({ ok: false, error: 'code expired' })
  })

  it('maps token invalid_client / redirect_uri to a human sentence, never the raw JSON blob', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      if (url.includes('/oauth/token')) {
        return jsonResponse(
          { error: 'invalid_client', error_description: 'redirect_uri is not registered for this client' },
          false,
          401
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    const result = await flow
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/callback address/i)
    expect(result.error).not.toMatch(/\{/)
    expect(result.error).not.toMatch(/invalid_client/)
  })

  it('maps a callback invalid_client / redirect_uri error to a human sentence', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')
    const flow = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, {
      error: 'invalid_client',
      error_description: 'redirect_uri is not registered for this client',
      state
    })
    const result = await flow
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/callback address/i)
    expect(result.error).not.toMatch(/\{/)
    expect(result.error).not.toMatch(/invalid_client/)
  })

  it('single-flight: a second concurrent call is rejected while one flow is in progress', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse(DCR_RESPONSE)
      if (url.includes('/oauth/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')

    const first = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))

    const second = await runClickupOAuth()
    expect(second).toEqual({ ok: false, error: 'A ClickUp sign-in is already in progress.' })

    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    const firstResult = await first
    expect(firstResult.ok).toBe(true)

    // Guard released after settling — a THIRD call now proceeds normally.
    openExternal.mockClear()
    const third = runClickupOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const p3 = capturedAuthorizeParams()
    await hitCallback(p3.redirectUri, { code: 'auth-code-3', state: p3.state })
    expect((await third).ok).toBe(true)
  })

  it('returns a typed failure without opening the browser when DCR fails and no client_id is cached', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/register')) return jsonResponse({ error: 'server_error' }, false, 500)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runClickupOAuth } = await import('./clickupOAuth')
    const result = await runClickupOAuth()
    expect(result.ok).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('refreshClickupToken', () => {
  let userData: string
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-clickup-refresh-test-'))
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('returns a typed failure with no client_id cached (nothing to refresh against)', async () => {
    const { refreshClickupToken } = await import('./clickupOAuth')
    const r = await refreshClickupToken('some-refresh-token')
    expect(r).toEqual({ ok: false, error: 'No ClickUp refresh token available.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a typed failure with an empty refresh token, even with a cached client_id', async () => {
    const { setSettings } = await import('../store')
    setSettings({ clickupClientId: 'cached-client' })
    const { refreshClickupToken } = await import('./clickupOAuth')
    const r = await refreshClickupToken('')
    expect(r).toEqual({ ok: false, error: 'No ClickUp refresh token available.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exchanges a refresh token for a fresh access token (matches ClickUp adding refresh support later)', async () => {
    const { setSettings } = await import('../store')
    setSettings({ clickupClientId: 'cached-client' })
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'new-at', refresh_token: 'new-rt' }))
    const { refreshClickupToken } = await import('./clickupOAuth')
    const r = await refreshClickupToken('old-rt')
    expect(r).toEqual({ ok: true, accessToken: 'new-at', refreshToken: 'new-rt' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mcp.clickup.com/oauth/token')
    const body = new URLSearchParams(String((init as RequestInit).body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('old-rt')
  })

  it('surfaces a typed failure when the server rejects the refresh grant (expected today per the discovery doc)', async () => {
    const { setSettings } = await import('../store')
    setSettings({ clickupClientId: 'cached-client' })
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unsupported_grant_type' }, false, 400))
    const { refreshClickupToken } = await import('./clickupOAuth')
    const r = await refreshClickupToken('old-rt')
    expect(r.ok).toBe(false)
  })
})

describe('humanizeClickupOAuthError', () => {
  it('maps Tony\'s live invalid_client / redirect_uri JSON blob to a human sentence', async () => {
    const { humanizeClickupOAuthError } = await import('./clickupOAuth')
    const blob =
      '{"error":"invalid_client","error_description":"redirect_uri is not registered for this client","state":"7515cca659f4c87d9538deb1c1ce1f13"}'
    const mapped = humanizeClickupOAuthError('', blob)
    expect(mapped).toMatch(/callback address/i)
    expect(mapped).toMatch(/Connect again/)
    expect(mapped).not.toMatch(/\{/)
    expect(mapped).not.toBe(blob)
    expect(humanizeClickupOAuthError('invalid_client', 'redirect_uri is not registered for this client')).toBe(mapped)
    expect(humanizeClickupOAuthError('invalid_client', '')).toMatch(/did not recognize this sign-in client/i)
  })
})

describe('tryAcquireClickupTokenLock / releaseClickupTokenLock — shared with index.ts mcp:push retry path', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('acquires when free, refuses while held, and is free again after release', async () => {
    const { tryAcquireClickupTokenLock, releaseClickupTokenLock } = await import('./clickupOAuth')
    expect(tryAcquireClickupTokenLock()).toBe(true)
    expect(tryAcquireClickupTokenLock()).toBe(false) // already held
    releaseClickupTokenLock()
    expect(tryAcquireClickupTokenLock()).toBe(true) // free again
    releaseClickupTokenLock()
  })
})
