import { describe, expect, it } from 'vitest'
import { isUnsafeProbeHost, probeConnection, safeProbeUrl, type ProbeDeps } from './probe'
import { getConnectorCatalogEntry, type ConnectorCatalogEntry } from './catalog'

function entryFor(kind: string): ConnectorCatalogEntry {
  const entry = getConnectorCatalogEntry(kind)
  if (!entry) throw new Error(`no catalog entry for ${kind}`)
  return entry
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  })
}

describe('safeProbeUrl / isUnsafeProbeHost (SSRF guard)', () => {
  it('requires https', () => {
    expect(safeProbeUrl('http://api.hubapi.com/x').ok).toBe(false)
    expect(safeProbeUrl('http://api.hubapi.com/x').error?.code).toBe('scheme')
    expect(safeProbeUrl('https://api.hubapi.com/x').ok).toBe(true)
    expect(safeProbeUrl('ftp://api.hubapi.com/x').ok).toBe(false)
  })

  it('blocks localhost, *.local, *.internal, and the GCP metadata host', () => {
    expect(isUnsafeProbeHost('localhost')).toBe(true)
    expect(isUnsafeProbeHost('LOCALHOST')).toBe(true)
    expect(isUnsafeProbeHost('printer.local')).toBe(true)
    expect(isUnsafeProbeHost('service.internal')).toBe(true)
    expect(isUnsafeProbeHost('metadata.google.internal')).toBe(true)
    expect(isUnsafeProbeHost('169.254.169.254')).toBe(true)
  })

  it('blocks every private/loopback/link-local IPv4 range', () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '0.0.0.1']) {
      expect(isUnsafeProbeHost(host), host).toBe(true)
    }
  })

  it('does not block public IPv4 addresses or the adjacent-but-public 172 range', () => {
    for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '193.168.0.1']) {
      expect(isUnsafeProbeHost(host), host).toBe(false)
    }
  })

  it('blocks ::1, fe80::/10, and fc00::/7', () => {
    for (const host of ['::1', 'fe80::1', 'fe80::abcd:1', 'fc00::1', 'fd12:3456::1']) {
      expect(isUnsafeProbeHost(host), host).toBe(true)
    }
  })

  it('does not block a public IPv6 address', () => {
    expect(isUnsafeProbeHost('2606:4700:4700::1111')).toBe(false)
  })

  it('safeProbeUrl rejects a bracketed IPv6 loopback URL', () => {
    const check = safeProbeUrl('https://[::1]/x')
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('blocked-host')
  })

  it('rejects a malformed URL', () => {
    expect(safeProbeUrl('not a url').ok).toBe(false)
    expect(safeProbeUrl('not a url').error?.code).toBe('bad-url')
  })

  it('blocks a trailing-dot FQDN the same way as the bare name (new URL() keeps the trailing dot)', () => {
    for (const host of ['localhost.', 'metadata.google.internal.', 'service.internal.', 'printer.local.']) {
      expect(isUnsafeProbeHost(host), host).toBe(true)
      const check = safeProbeUrl(`https://${host}/x`)
      expect(check.ok, host).toBe(false)
      expect(check.error?.code, host).toBe('blocked-host')
    }
  })

  it('a public domain with a trailing dot resolves to the same decision as without one', () => {
    expect(isUnsafeProbeHost('api.hubapi.com.')).toBe(isUnsafeProbeHost('api.hubapi.com'))
    expect(isUnsafeProbeHost('api.hubapi.com.')).toBe(false)
  })
})

describe('probeConnection - REST', () => {
  it('reaches HubSpot, builds the summary from the response, and never returns the credential', async () => {
    const entry = entryFor('hubspot')
    let seenUrl = ''
    let seenAuth = ''
    const fetchImpl = (async (url, init) => {
      seenUrl = String(url)
      seenAuth = (init?.headers as Record<string, string>).authorization
      return jsonResponse({ portalId: 998877, accountType: 'STANDARD' })
    }) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'pat-na1-super-secret', config: {} }, { fetch: fetchImpl })
    expect(seenUrl).toBe('https://api.hubapi.com/account-info/v3/details')
    expect(seenAuth).toBe('Bearer pat-na1-super-secret')
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('998877')
    expect(JSON.stringify(result)).not.toContain('pat-na1-super-secret')
  })

  it('refuses a redirect (3xx) even with a 2xx-shaped body', async () => {
    const entry = entryFor('hubspot')
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'x', config: {} }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('redirect')
  })

  it('refuses a private-range URL built from a template field (GitLab self-hosted baseUrl)', async () => {
    const entry = entryFor('gitlab')
    const fetchImpl = (async () => {
      throw new Error('fetch must never be called for a blocked host')
    }) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'glpat-x', config: { baseUrl: 'https://169.254.169.254' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('blocked-host')
  })

  it('times out after the deadline and never hangs the caller', async () => {
    const entry = entryFor('hubspot')
    const fetchImpl = ((_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'x', config: {} }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('timeout')
  }, 15000)

  it('a slow-drip body (one byte every 100ms, never closing) times out rather than hanging the caller', async () => {
    // fetch() resolves immediately (headers arrive at once); only the body trickles in forever. This is
    // exactly what an old "clear the abort timer once fetch resolves" bug would miss: the header-phase
    // timeout no longer covers the body-read phase, so readCapped's own deadline race must catch it.
    const entry = entryFor('hubspot')
    // The drip has to stop when the probe gives up. Left unbounded, the timer outlives the test and
    // fires once more against a controller the aborted read has already closed, which surfaces as an
    // unhandled "Invalid state: Controller is already closed" -- a whole-run failure attributed to
    // whichever file happened to be running, with every test still reported as passing. `cancel` is
    // what the reader calls on abort, so clearing the timer there ends the drip exactly when the real
    // consumer walks away; the enqueue is guarded too, since the close can land between two ticks.
    let timer: ReturnType<typeof setTimeout> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const tick = (): void => {
          try {
            controller.enqueue(new TextEncoder().encode('a'))
          } catch {
            return
          }
          timer = setTimeout(tick, 100)
        }
        tick()
      },
      cancel() {
        if (timer) clearTimeout(timer)
      }
    })
    const fetchImpl = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'x', config: {} }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('timeout')
    if (timer) clearTimeout(timer)
  }, 15000)

  it('caps the response body at 64 KB while reading it', async () => {
    const entry = entryFor('hubspot')
    const huge = '{"hubId":1,"pad":"' + 'a'.repeat(200_000) + '"}'
    const fetchImpl = (async () => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'x', config: {} }, { fetch: fetchImpl })
    // The capped body is no longer valid JSON (truncated mid-string), so summary falls back to the
    // generic "Reached {label}, status {status}." form rather than a parsed field - the request that
    // matters here is that the probe never buffered the full 200 KB body.
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('HubSpot')
  })

  it('never leaks the credential in a failure summary or error message, even when the upstream echoes it back', async () => {
    const entry = entryFor('hubspot')
    const fetchImpl = (async () => new Response('unauthorized: bad token pat-na1-super-secret-leak', { status: 401 })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'pat-na1-super-secret-leak', config: {} }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('pat-na1-super-secret-leak')
  })

  it('never leaks a credential echoed back as "Basic <base64>" (the request\'s own Authorization header reflected in an error body)', async () => {
    const entry = entryFor('close') // basic auth: credential as the Basic username, empty password
    const credential = 'close-api-key-abcdef123456'
    const basicValue = btoa(`${credential}:`)
    const fetchImpl = (async () => new Response(`invalid credentials: Basic ${basicValue}`, { status: 401 })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential, config: {} }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(credential)
    expect(serialized).not.toContain(basicValue)
  })

  it('never leaks a percent-encoded credential (a query-param-auth vendor echoing the request URL back)', async () => {
    const entry = entryFor('trello')
    const credential = 'token/with+special=chars'
    const encoded = encodeURIComponent(credential)
    const fetchImpl = (async () => new Response(`invalid request: token=${encoded}`, { status: 401 })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential, config: { key: 'k1' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(credential)
    expect(serialized).not.toContain(encoded)
  })

  it('treats Slack auth.test ok:false as a failure even though the HTTP status is 200', async () => {
    const entry = entryFor('slack')
    const fetchImpl = (async () => jsonResponse({ ok: false, error: 'invalid_auth' })) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'xoxb-bad', config: {} }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('rejected')
  })

  it('sends HTTP Basic auth for a basic-auth kind (Jira: email + token)', async () => {
    const entry = entryFor('jira')
    const fetchImpl = (async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).authorization
      const decoded = atob(auth.replace('Basic ', ''))
      expect(decoded).toBe('a@b.com:jira-token')
      return jsonResponse({ displayName: 'Ada' })
    }) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'jira-token', config: { email: 'a@b.com', subdomain: 'acme' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('Ada')
  })

  it('answers "no probe available" for a kind with probe: null (Plane) rather than guessing an endpoint', async () => {
    const entry = entryFor('plane')
    const fetchImpl = (async () => {
      throw new Error('must never be called')
    }) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'x', config: { workspace: 'acme' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('no-probe')
    expect(result.summary).toBe('No probe available for this kind yet.')
  })
})

describe('probeConnection - MCP (Streamable HTTP)', () => {
  function mcpFetch(handlers: { initialize?: () => Response; toolsList?: () => Response }): ProbeDeps['fetch'] {
    return (async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (payload.method === 'initialize') return (handlers.initialize ?? (() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })))()
      if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (payload.method === 'tools/list') return (handlers.toolsList ?? (() => jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [] } })))()
      throw new Error(`unexpected MCP method ${payload.method}`)
    }) as ProbeDeps['fetch']
  }

  it('parses a JSON tools/list response and applies the write heuristic', async () => {
    const entry = entryFor('custom-mcp')
    const fetchImpl = mcpFetch({
      toolsList: () =>
        jsonResponse({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              { name: 'list_issues', description: 'List issues', annotations: { readOnlyHint: true } },
              { name: 'create_issue', description: 'Create an issue' },
              { name: 'archive_issue' },
              { name: 'get_issue', annotations: { destructiveHint: true } }
            ]
          }
        })
    })
    const result = await probeConnection(entry, { credential: 'tok', config: { baseUrl: 'https://mcp.example.com' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.tools).toEqual([
      { name: 'list_issues', description: 'List issues', write: false },
      { name: 'create_issue', description: 'Create an issue', write: true },
      { name: 'archive_issue', description: undefined, write: true },
      { name: 'get_issue', description: undefined, write: true }
    ])
  })

  it('parses an SSE tools/list response', async () => {
    const entry = entryFor('custom-mcp')
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'send_message' }] } })}\n\n`
    const fetchImpl = mcpFetch({
      toolsList: () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const result = await probeConnection(entry, { credential: 'tok', config: { baseUrl: 'https://mcp.example.com' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(true)
    expect(result.tools).toEqual([{ name: 'send_message', description: undefined, write: true }])
  })

  it('falls back from 2025-06-18 to 2025-03-26 when the server rejects the first protocol version', async () => {
    const entry = entryFor('custom-mcp')
    let attempt = 0
    const fetchImpl = (async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { method?: string; params?: { protocolVersion?: string } }
      if (payload.method === 'initialize') {
        attempt += 1
        if (attempt === 1) return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unsupported protocol version' } }, { status: 400 })
        expect(payload.params?.protocolVersion).toBe('2025-03-26')
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } })
      }
      if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (payload.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [] } })
      throw new Error('unexpected')
    }) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'tok', config: { baseUrl: 'https://mcp.example.com' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(true)
    expect(attempt).toBe(2)
  })

  it('refuses an mcp endpoint on a private host without ever calling fetch', async () => {
    const entry = entryFor('custom-mcp')
    const fetchImpl = (async () => {
      throw new Error('must never be called')
    }) as ProbeDeps['fetch']
    const result = await probeConnection(entry, { credential: 'tok', config: { baseUrl: 'https://10.0.0.5' } }, { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('blocked-host')
  })

  it('never includes the credential in the summary, error, or tool list', async () => {
    const entry = entryFor('custom-mcp')
    const fetchImpl = mcpFetch({ toolsList: () => jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'secret_leaker_tool_9999' }] } }) })
    const result = await probeConnection(entry, { credential: 'super-secret-mcp-9999', config: { baseUrl: 'https://mcp.example.com' } }, { fetch: fetchImpl })
    expect(JSON.stringify(result)).not.toContain('super-secret-mcp-9999')
  })
})
