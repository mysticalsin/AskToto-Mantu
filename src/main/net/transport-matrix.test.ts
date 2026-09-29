import { describe, expect, it, vi } from 'vitest'
import { installEgressGuard, type WebRequestLike } from './egress-guard'
import { createGuardedNetworkClient } from './guarded-network-client'
import { childNetworkBlocked, DEAD_PROXY_URL, pinChildEnv } from './egress-policy'

vi.mock('electron', () => ({
  session: {
    get defaultSession(): never {
      throw new Error('tests must inject webRequest')
    }
  }
}))
vi.mock('../logger', () => ({
  mainLog: { info: () => {}, warn: () => {} },
  auditLog: () => {}
}))

// One row per in-process transport in docs/NETWORK-EGRESS.md ("Transport matrix"): under a managed policy a
// host outside the allowlist is refused, and an allowed host still passes.
function armed(allow: readonly string[] | null) {
  type Listener = (details: { url: string }, cb: (r: { cancel: boolean }) => void) => void
  let listener: Listener | null = null
  const webRequest: WebRequestLike = {
    onBeforeRequest: (_filter, l) => {
      listener = l
    }
  }
  const baseFetch = vi.fn(async () => new Response('{"ok":true}'))
  let installed: typeof fetch | null = null
  const handle = installEgressGuard(allow, {
    baseFetch: baseFetch as unknown as typeof fetch,
    setGlobalFetch: (f) => {
      installed = f
    },
    webRequest,
    audit: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() }
  })
  const chromiumRefuses = (url: string): boolean => {
    let cancel = false
    listener?.({ url }, (r) => {
      cancel = r.cancel
    })
    return cancel
  }
  return { baseFetch, handle, installed: () => installed!, chromiumRefuses }
}

describe('transport matrix: in-process transports refuse a disallowed host', () => {
  it('renderer fetch / Chromium session: http(s) requests to a disallowed host are cancelled', () => {
    const g = armed(['graph.microsoft.com'])
    expect(g.chromiumRefuses('https://evil.example/x')).toBe(true)
    expect(g.chromiumRefuses('https://graph.microsoft.com/v1.0/me')).toBe(false)
    g.handle.restore()
  })

  it('renderer WebSocket: ws/wss to a disallowed host are cancelled by the same hook', () => {
    const g = armed(['graph.microsoft.com'])
    expect(g.chromiumRefuses('wss://evil.example/socket')).toBe(true)
    expect(g.chromiumRefuses('ws://evil.example/socket')).toBe(true)
    g.handle.restore()
  })

  it('main-process fetch: a disallowed host is rejected before the network is touched', async () => {
    const g = armed(['graph.microsoft.com'])
    await expect(g.installed()('https://evil.example/x')).rejects.toThrow(/egress allowlist/)
    expect(g.baseFetch).not.toHaveBeenCalled()
    await g.installed()('https://graph.microsoft.com/v1.0/me')
    expect(g.baseFetch).toHaveBeenCalledTimes(1)
    g.handle.restore()
  })

  it('raw https.request libraries (MSAL token client): requests ride the guarded fetch, so a disallowed host is refused', async () => {
    const g = armed(['login.microsoftonline.com'])
    const client = createGuardedNetworkClient(() => g.installed())
    await expect(client.sendPostRequestAsync('https://evil.example/token', { body: 'x' })).rejects.toThrow(/egress allowlist/)
    await expect(client.sendGetRequestAsync('https://evil.example/discovery')).rejects.toThrow(/egress allowlist/)
    expect(g.baseFetch).not.toHaveBeenCalled()
    const ok = await client.sendGetRequestAsync('https://login.microsoftonline.com/discovery')
    expect(ok).toMatchObject({ status: 200, body: { ok: true } })
    g.handle.restore()
  })

  it('the MSAL client passes non-2xx statuses and non-JSON bodies through for MSAL to classify', async () => {
    const send = createGuardedNetworkClient(() => (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch)
    await expect(send.sendGetRequestAsync('https://login.microsoftonline.com/x')).resolves.toMatchObject({
      status: 502,
      body: '<html>bad gateway</html>'
    })
  })
})

describe('transport matrix: child-process policy', () => {
  it('the guard publishes the policy for spawn sites and clears it on restore', () => {
    expect(childNetworkBlocked()).toBe(false)
    const g = armed(['graph.microsoft.com'])
    expect(childNetworkBlocked()).toBe(true)
    g.handle.restore()
    expect(childNetworkBlocked()).toBe(false)
  })

  it('no policy: the child environment is returned untouched and children are not blocked', () => {
    const env = { HTTPS_PROXY: 'http://corp-proxy:3128', PATH: '/usr/bin' }
    expect(pinChildEnv(env, null)).toBe(env)
    expect(childNetworkBlocked(null)).toBe(false)
  })

  it('under a policy every proxy variable is pinned to an unresolvable proxy and NO_PROXY is emptied', () => {
    const env = { HTTPS_PROXY: 'http://corp-proxy:3128', no_proxy: 'evil.example', PATH: '/usr/bin' }
    const pinned = pinChildEnv(env, ['graph.microsoft.com'])
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      expect(pinned[key]).toBe(DEAD_PROXY_URL)
    }
    expect(pinned.NO_PROXY).toBe('')
    expect(pinned.no_proxy).toBe('')
    expect(pinned.PATH).toBe('/usr/bin')
    expect(env.HTTPS_PROXY).toBe('http://corp-proxy:3128')
    expect(new URL(DEAD_PROXY_URL).hostname.endsWith('.invalid')).toBe(true)
    expect(childNetworkBlocked([])).toBe(true)
  })
})
