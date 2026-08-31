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

  it('registers via DCR once, then reuses cached client_id + client_secret', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse(DCR_RESPONSE)
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { runPlaneOAuth } = await import('./planeOAuth')
    const first = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    expect(await first).toEqual({ ok: true, accessToken: 'plane-at-1', refreshToken: 'plane-rt-1' })

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/register'))).toHaveLength(1)

    openExternal.mockClear()
    const second = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const p2 = capturedAuthorizeParams()
    await hitCallback(p2.redirectUri, { code: 'auth-code-2', state: p2.state })
    await second
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/register'))).toHaveLength(1)
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
})
