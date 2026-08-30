/**
 * planeOAuth.test.ts — same loopback-callback stance as clickupOAuth.test.ts: real HTTP callback,
 * mocked DCR/token fetch + shell.openExternal. Pins Plane's client_secret_post + refresh_token shape.
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

const DCR_RESPONSE = {
  client_id: 'plane-client-abc',
  client_secret: 'plane-secret-xyz',
  token_endpoint_auth_method: 'client_secret_post'
}
const TOKEN_RESPONSE = { access_token: 'plane-at-1', refresh_token: 'plane-rt-1', token_type: 'bearer' }

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response
}

describe('planeOAuth — OAuth 2.1 + PKCE plug-and-play connect', () => {
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

  it('registers via DCR, opens browser, exchanges code with client_secret + PKCE verifier', async () => {
    let capturedTokenBody = ''
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/register')) return jsonResponse(DCR_RESPONSE)
      if (String(url).includes('/token')) {
        capturedTokenBody = String(init?.body || '')
        return jsonResponse(TOKEN_RESPONSE)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { runPlaneOAuth, PLANE_MCP_ENDPOINT } = await import('./planeOAuth')
    expect(PLANE_MCP_ENDPOINT).toBe('https://mcp.plane.so/http/mcp')

    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    expect(new URL(redirectUri).hostname).toBe('127.0.0.1')
    await hitCallback(redirectUri, { code: 'auth-code-1', state })
    const result = await flow

    expect(result.ok).toBe(true)
    expect(result.accessToken).toBe('plane-at-1')
    expect(result.refreshToken).toBe('plane-rt-1')
    expect(result.clientSecret).toBe('plane-secret-xyz')

    const body = new URLSearchParams(capturedTokenBody)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('plane-client-abc')
    expect(body.get('client_secret')).toBe('plane-secret-xyz')
    expect(body.get('code_verifier')).toBeTruthy()
  })

  it('reuses cached client_id + encrypted client_secret without re-registering', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/register')) return jsonResponse(DCR_RESPONSE)
      if (String(url).includes('/token')) return jsonResponse(TOKEN_RESPONSE)
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { setMcpClientSecret } = await import('./mcpSecrets')
    const { setSettings } = await import('../store')
    setSettings({ planeClientId: 'cached-plane-client' })
    setMcpClientSecret('plane', 'cached-plane-secret')

    const { runPlaneOAuth } = await import('./planeOAuth')
    const flow = runPlaneOAuth()
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const { redirectUri, state } = capturedAuthorizeParams()
    await hitCallback(redirectUri, { code: 'auth-code-2', state })
    const result = await flow

    expect(result.ok).toBe(true)
    expect(result.clientSecret).toBeUndefined() // already on disk — caller must not re-write from result
    const registerCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/register'))
    expect(registerCalls).toHaveLength(0)
  })

  it('refreshPlaneToken posts refresh_token with client_secret_post', async () => {
    let capturedBody = ''
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/token')) {
        capturedBody = String(init?.body || '')
        return jsonResponse({ access_token: 'plane-at-2', refresh_token: 'plane-rt-2' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { setMcpClientSecret } = await import('./mcpSecrets')
    const { setSettings } = await import('../store')
    setSettings({ planeClientId: 'cached-plane-client' })
    setMcpClientSecret('plane', 'cached-plane-secret')

    const { refreshPlaneToken } = await import('./planeOAuth')
    const r = await refreshPlaneToken('plane-rt-old')
    expect(r.ok).toBe(true)
    expect(r.accessToken).toBe('plane-at-2')
    const body = new URLSearchParams(capturedBody)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_secret')).toBe('cached-plane-secret')
  })
})
