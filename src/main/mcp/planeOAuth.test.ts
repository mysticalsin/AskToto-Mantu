/**
 * planeOAuth.test.ts — OAuth 2.1 + PKCE + DCR against a real loopback callback.
 * Mirrors clickupOAuth.test.ts. Plane is a confidential client: DCR must return client_secret,
 * and the token exchange must send client_secret_post.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const openExternal = vi.fn(async (_url: string) => {})
const realFetch = globalThis.fetch.bind(globalThis)

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? '/tmp/asktoto-plane-oauth-fallback' : `/tmp/${name}`))
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

const DCR_RESPONSE = { client_id: 'plane-client-abc', client_secret: 'plane-secret-xyz' }
const TOKEN_RESPONSE = { access_token: 'plane-at-1', refresh_token: 'plane-rt-1', token_type: 'bearer' }

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: async () => body
  } as Response
}

describe('planeOAuth — OAuth 2.1 + PKCE connect flow', () => {
  let userData: string
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    openExternal.mockClear()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-plane-oauth-test-'))
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

  function capturedAuthorizeParams(): { redirectUri: string; state: string } {
    expect(openExternal).toHaveBeenCalledTimes(1)
    const authUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authUrl.origin + authUrl.pathname).toBe('https://mcp.plane.so/authorize')
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    return {
      redirectUri: authUrl.searchParams.get('redirect_uri') || '',
      state: authUrl.searchParams.get('state') || ''
    }
  }

  async function hitCallback(redirectUri: string, params: Record<string, string>): Promise<Response> {
    const u = new URL(redirectUri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return realFetch(u.toString())
  }

  it("registers a fresh confidential client per run whose DCR body is this run's exact ported loopback URI (never a cached portless one)", async () => {
    const dcrBodies: Array<{ redirect_uris?: string[] }> = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/register')) {
        dcrBodies.push(JSON.parse(String(init?.body || '{}')))
        return jsonResponse({ client_id: `plane-client-${dcrBodies.length}`, client_secret: `plane-secret-${dcrBodies.length}` })
      }
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { runPlaneOAuth } = await import('./planeOAuth')
    const first = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(dcrBodies).toHaveLength(1)
    expect(dcrBodies[0].redirect_uris).toEqual([redirectUri])
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    expect(await first).toEqual({
      ok: true,
      accessToken: 'plane-at-1',
      refreshToken: 'plane-rt-1',
      clientId: 'plane-client-1',
      clientSecret: 'plane-secret-1'
    })

    // Second run: its own ephemeral port, so DCR must run again scoped to THAT run's own URI — a
    // cached client registered with the first run's (or any fixed portless) URI is never reused.
    openExternal.mockClear()
    const second = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const p2 = capturedAuthorizeParams()
    expect(dcrBodies).toHaveLength(2)
    expect(dcrBodies[1].redirect_uris).toEqual([p2.redirectUri])
    await hitCallback(p2.redirectUri, { code: 'auth-code-2', state: p2.state })
    await second
    const secondAuthUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(secondAuthUrl.searchParams.get('client_id')).toBe('plane-client-2')
  })

  it('does not reuse a cached client_id/client_secret registered with a different (portless) URI (P4-F2, AGUC-021)', async () => {
    // A previously-cached client — e.g. from a one-time registration, or one Plane has since rejected —
    // must never short-circuit a fresh interactive Connect. Reusing it silently is exactly the bug: this
    // pre-seeds settings/mcpSecrets the way a leftover cached client would, so the test can prove DCR
    // registers fresh regardless of what's already stored.
    const { setSettings } = await import('../store')
    const { setMcpClientSecret } = await import('./mcpSecrets')
    setSettings({ planeClientId: 'cached-portless-client' })
    setMcpClientSecret('plane', 'cached-portless-secret')

    let capturedRedirectUris: string[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/register')) {
        capturedRedirectUris = (JSON.parse(String(init?.body || '{}')) as { redirect_uris?: string[] }).redirect_uris || []
        return jsonResponse({ client_id: 'fresh-ported-client', client_secret: 'fresh-ported-secret' })
      }
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    expect(capturedRedirectUris).toEqual([redirectUri])
    expect(capturedRedirectUris).not.toContain('http://127.0.0.1/callback')
    const authUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get('client_id')).toBe('fresh-ported-client')
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    await flow
  })

  it('sends client_secret + PKCE verifier on the token exchange (confidential client)', async () => {
    let capturedTokenBody = ''
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/register')) return jsonResponse(DCR_RESPONSE)
      if (String(url).includes('/token')) {
        capturedTokenBody = String(init?.body || '')
        return jsonResponse(TOKEN_RESPONSE)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    await flow

    const body = new URLSearchParams(capturedTokenBody)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('plane-client-abc')
    expect(body.get('client_secret')).toBe('plane-secret-xyz')
    expect(body.get('code_verifier')!.length).toBeGreaterThanOrEqual(43)
  })

  it('binds the loopback server to literal 127.0.0.1', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse(DCR_RESPONSE)
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    expect(new URL(redirectUri).hostname).toBe('127.0.0.1')
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    await flow
  })

  it('opens the login tab (authorize URL) from Connect — no form fields in the authorize URL', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse(DCR_RESPONSE)
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const authUrl = new URL(openExternal.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get('api_key')).toBeNull()
    expect(authUrl.searchParams.get('workspace')).toBeNull()
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    await flow
  })

  it('fails closed when DCR returns no client_secret', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse({ client_id: 'only-id' })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const result = await runPlaneOAuth()
    expect(result.ok).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('single-flight: a second concurrent call is rejected', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse(DCR_RESPONSE)
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const first = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(await runPlaneOAuth()).toEqual({ ok: false, error: 'A Plane sign-in is already in progress.' })
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    expect((await first).ok).toBe(true)
  })

  it('keeps the previously stored client unchanged when the sign-in is denied (P4-F2, AGUC-021)', async () => {
    const { getSettings, setSettings } = await import('../store')
    const { getMcpClientSecret, setMcpClientSecret } = await import('./mcpSecrets')
    setSettings({ planeClientId: 'client-A' })
    setMcpClientSecret('plane', 'secret-A')

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse({ client_id: 'client-B', client_secret: 'secret-B' })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { error: 'access_denied', state })
    expect((await flow).ok).toBe(false)
    expect(getSettings().planeClientId).toBe('client-A')
    expect(getMcpClientSecret('plane')).toBe('secret-A')
  })

  it('keeps the previously stored client unchanged when the token exchange fails (P4-F2, AGUC-021)', async () => {
    const { getSettings, setSettings } = await import('../store')
    const { getMcpClientSecret, setMcpClientSecret } = await import('./mcpSecrets')
    setSettings({ planeClientId: 'client-A' })
    setMcpClientSecret('plane', 'secret-A')

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse({ client_id: 'client-B', client_secret: 'secret-B' })
      if (String(url).includes('/token')) {
        return jsonResponse({ error: 'invalid_grant', error_description: 'bad code' }, false, 400)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    expect((await flow).ok).toBe(false)
    expect(getSettings().planeClientId).toBe('client-A')
    expect(getMcpClientSecret('plane')).toBe('secret-A')
  })

  it('never persists the client itself on success — it only returns it alongside the tokens (P4-F2, AGUC-021)', async () => {
    // A successful token exchange isn't the same as connectMcp proving the connection is live —
    // persistence is the caller's job (see savePlaneClientAndTokens).
    const { getSettings, setSettings } = await import('../store')
    const { getMcpClientSecret, setMcpClientSecret } = await import('./mcpSecrets')
    setSettings({ planeClientId: 'client-A' })
    setMcpClientSecret('plane', 'secret-A')

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse({ client_id: 'client-B', client_secret: 'secret-B' })
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    const result = await flow
    expect(result).toEqual({
      ok: true,
      accessToken: 'plane-at-1',
      refreshToken: 'plane-rt-1',
      clientId: 'client-B',
      clientSecret: 'secret-B'
    })
    expect(getSettings().planeClientId).toBe('client-A')
    expect(getMcpClientSecret('plane')).toBe('secret-A')
  })

  it('savePlaneClientAndTokens persists client + tokens together, so a later refresh sends the matching pair (P4-F2, AGUC-021)', async () => {
    const { getSettings, setSettings } = await import('../store')
    const { getMcpApiKey, getMcpRefreshToken, setMcpClientSecret, setMcpApiKey, setMcpRefreshToken } = await import(
      './mcpSecrets'
    )
    const { savePlaneClientAndTokens, refreshPlaneToken } = await import('./planeOAuth')

    // Seed an existing connection at client-A, the way a prior successful Connect would have left it.
    setSettings({ planeClientId: 'client-A' })
    setMcpClientSecret('plane', 'secret-A')
    setMcpApiKey('plane', 'plane-at-A')
    setMcpRefreshToken('plane', 'plane-rt-A')

    // The step main/index.ts's mcpPlaneConnect handler takes only after its own connectMcp probe of
    // the fresh client-B grant's access token has succeeded.
    savePlaneClientAndTokens(
      { clientId: 'client-B', clientSecret: 'secret-B' },
      { accessToken: 'plane-at-B', refreshToken: 'plane-rt-B' }
    )
    expect(getSettings().planeClientId).toBe('client-B')
    expect(getMcpApiKey('plane')).toBe('plane-at-B')
    expect(getMcpRefreshToken('plane')).toBe('plane-rt-B')

    // The refresh path a background 401 takes (index.ts:5917-5918): read back whatever was just saved
    // and send it as one pair — never client-B mismatched with the old RT-A.
    let refreshBody = ''
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/token')) {
        refreshBody = String(init?.body || '')
        return jsonResponse({ access_token: 'plane-at-B2', refresh_token: 'plane-rt-B2' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const refreshed = await refreshPlaneToken(getMcpRefreshToken('plane'))
    expect(refreshed.ok).toBe(true)
    const body = new URLSearchParams(refreshBody)
    expect(body.get('client_id')).toBe('client-B')
    expect(body.get('client_secret')).toBe('secret-B')
    expect(body.get('refresh_token')).toBe('plane-rt-B')
  })

  it('savePlaneClientAndTokens clears the previously stored refresh token when the new grant has none, so a token-less re-grant cannot leave it paired with the new client (P4-F2, AGUC-021)', async () => {
    const { setSettings } = await import('../store')
    const { getMcpRefreshToken, setMcpClientSecret, setMcpRefreshToken } = await import('./mcpSecrets')
    const { savePlaneClientAndTokens } = await import('./planeOAuth')

    setSettings({ planeClientId: 'client-A' })
    setMcpClientSecret('plane', 'secret-A')
    setMcpRefreshToken('plane', 'plane-rt-A')

    savePlaneClientAndTokens({ clientId: 'client-B', clientSecret: 'secret-B' }, { accessToken: 'plane-at-B', refreshToken: '' })
    expect(getMcpRefreshToken('plane')).toBe('')
  })

  it('pins the official hosted MCP URLs and never asks the user to paste them', async () => {
    const { PLANE_MCP_OAUTH_ENDPOINT, PLANE_MCP_PAT_ENDPOINT } = await import('./planeOAuth')
    expect(PLANE_MCP_OAUTH_ENDPOINT).toBe('https://mcp.plane.so/http/mcp')
    expect(PLANE_MCP_PAT_ENDPOINT).toBe('https://mcp.plane.so/http/api-key/mcp')
  })
})

describe('refreshPlaneToken', () => {
  let userData: string

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-plane-refresh-test-'))
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('refuses to refresh without a cached client_id + client_secret', async () => {
    const { refreshPlaneToken } = await import('./planeOAuth')
    const r = await refreshPlaneToken('some-refresh-token')
    expect(r.ok).toBe(false)
  })

  it('surfaces a rejected refresh token as a human sentence, not a raw JSON blob (AGUC-021)', async () => {
    const { setSettings } = await import('../store')
    const { setMcpClientSecret } = await import('./mcpSecrets')
    setSettings({ planeClientId: 'stale-client' })
    setMcpClientSecret('plane', 'stale-secret')
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'refresh token is expired or revoked' }, false, 400)
    )
    vi.stubGlobal('fetch', fetchMock)
    const { refreshPlaneToken } = await import('./planeOAuth')
    const r = await refreshPlaneToken('revoked-refresh-token')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('refresh token is expired or revoked')
    expect(r.error).not.toMatch(/[{[]/)
  })
})

describe('humanizePlaneOAuthError', () => {
  it('maps a redirect_uri mismatch and an unrecognized client to human sentences, mirroring humanizeClickupOAuthError', async () => {
    const { humanizePlaneOAuthError } = await import('./planeOAuth')
    const blob = '{"error":"invalid_client","error_description":"redirect_uri is not registered for this client"}'
    const mapped = humanizePlaneOAuthError('', blob)
    expect(mapped).toMatch(/callback address/i)
    expect(mapped).toMatch(/Connect again/)
    expect(mapped).not.toMatch(/[{[]/)
    expect(humanizePlaneOAuthError('invalid_client', 'redirect_uri is not registered for this client')).toBe(mapped)
    expect(humanizePlaneOAuthError('invalid_client', '')).toMatch(/did not recognize this sign-in client/i)
  })

  it('passes through a plain Plane error sentence unchanged', async () => {
    const { humanizePlaneOAuthError } = await import('./planeOAuth')
    expect(humanizePlaneOAuthError('', 'refresh token is expired or revoked')).toBe('refresh token is expired or revoked')
  })
})
