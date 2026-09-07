import { describe, expect, it, vi } from 'vitest'
import { boundedFetch, isUnsafeGatewayHost, resolveThenValidate, safeGatewayUrl, safeResolvedUrl } from './shared'

const NOW = 1_725_000_000_000

function dohResponse(answers: { type: number; data: string }[]): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('isUnsafeGatewayHost', () => {
  it('blocks loopback, private, and link-local IPv4', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
      expect(isUnsafeGatewayHost(host)).toBe(true)
    }
  })

  it('allows public IPv4', () => {
    for (const host of ['8.8.8.8', '1.1.1.1', '104.16.0.1']) {
      expect(isUnsafeGatewayHost(host)).toBe(false)
    }
  })

  it('blocks localhost, .internal, .local, and the metadata hostname, with or without a trailing dot', () => {
    for (const host of ['localhost', 'localhost.', 'metadata.google.internal', 'foo.internal', 'printer.local']) {
      expect(isUnsafeGatewayHost(host)).toBe(true)
    }
  })

  it('blocks IPv6 loopback, unique-local, and link-local, and the IPv4-mapped metadata address', () => {
    for (const host of ['::1', 'fc00::1', 'fe80::1', '::ffff:169.254.169.254']) {
      expect(isUnsafeGatewayHost(host)).toBe(true)
    }
  })

  it('allows a public IPv6 address', () => {
    expect(isUnsafeGatewayHost('2606:4700:4700::1111')).toBe(false)
  })
})

describe('safeGatewayUrl', () => {
  it('rejects non-https schemes', () => {
    const check = safeGatewayUrl('http://example.com/x')
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('scheme')
  })

  it('rejects a private-IP literal URL outright, before any network call', () => {
    const check = safeGatewayUrl('https://169.254.169.254/latest/meta-data/')
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('blocked-host')
  })

  it('rejects an invalid URL', () => {
    expect(safeGatewayUrl('not a url').ok).toBe(false)
  })

  it('accepts a normal https URL', () => {
    const check = safeGatewayUrl('https://api.example.com/v1/resource')
    expect(check.ok).toBe(true)
    expect(check.url?.hostname).toBe('api.example.com')
  })
})

describe('resolveThenValidate (SSRF, security carry-over plan section 10)', () => {
  it('blocks a hostname that DNS resolves to a private address (the DNS-rebinding / Save-time-was-fine case)', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('type=A')) return dohResponse([{ type: 1, data: '10.0.0.5' }])
      return dohResponse([])
    })
    const check = await resolveThenValidate(fetchImpl as unknown as typeof fetch, new URL('https://internal-service.example.com/'), NOW + 10_000, () => NOW)
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('dns-private')
  })

  it('allows a hostname that resolves only to public addresses', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('type=A')) return dohResponse([{ type: 1, data: '104.16.0.1' }])
      return dohResponse([])
    })
    const check = await resolveThenValidate(fetchImpl as unknown as typeof fetch, new URL('https://api.example.com/'), NOW + 10_000, () => NOW)
    expect(check.ok).toBe(true)
  })

  it('fails closed when the DNS lookup itself errors (never "skip the check")', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const check = await resolveThenValidate(fetchImpl as unknown as typeof fetch, new URL('https://api.example.com/'), NOW + 10_000, () => NOW)
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('dns-unresolved')
  })

  it('fails closed when the DNS lookup returns no answers', async () => {
    const fetchImpl = vi.fn(async () => dohResponse([]))
    const check = await resolveThenValidate(fetchImpl as unknown as typeof fetch, new URL('https://nxdomain.example.com/'), NOW + 10_000, () => NOW)
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('dns-unresolved')
  })

  it('skips DNS resolution for a literal IP host (nothing to resolve) and still applies the literal check', async () => {
    const fetchImpl = vi.fn(async () => dohResponse([]))
    const check = await resolveThenValidate(fetchImpl as unknown as typeof fetch, new URL('https://8.8.8.8/'), NOW + 10_000, () => NOW)
    expect(check.ok).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never proceeds past the deadline', async () => {
    const fetchImpl = vi.fn(async () => dohResponse([{ type: 1, data: '8.8.8.8' }]))
    const check = await resolveThenValidate(fetchImpl as unknown as typeof fetch, new URL('https://api.example.com/'), NOW - 1, () => NOW)
    expect(check.ok).toBe(false)
  })

  // Deadline anchored to the real clock (like the boundedFetch tests below), not the fixed `NOW` used
  // elsewhere in this block, since dohLookup's timeout math is genuinely Date.now()-relative.
  it('blocks a hostname whose resolver returns a mix of one public and one private address', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('type=A')) {
        return dohResponse([
          { type: 1, data: '8.8.8.8' },
          { type: 1, data: '10.0.0.5' }
        ])
      }
      return dohResponse([])
    })
    const check = await resolveThenValidate(fetchImpl as unknown as typeof fetch, new URL('https://mixed-answer.example.com/'), Date.now() + 10_000)
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('dns-private')
  })
})

describe('safeResolvedUrl (literal check + resolve-then-validate together)', () => {
  it('rejects at the literal stage without ever attempting a DNS lookup', async () => {
    const fetchImpl = vi.fn(async () => dohResponse([{ type: 1, data: '8.8.8.8' }]))
    const check = await safeResolvedUrl(fetchImpl as unknown as typeof fetch, 'https://localhost/admin', NOW + 10_000, () => NOW)
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('blocked-host')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes both stages for a normal public host', async () => {
    const fetchImpl = vi.fn(async () => dohResponse([{ type: 1, data: '104.16.0.1' }]))
    const check = await safeResolvedUrl(fetchImpl as unknown as typeof fetch, 'https://api.example.com/v1', NOW + 10_000, () => NOW)
    expect(check.ok).toBe(true)
  })
})

describe('boundedFetch', () => {
  it('reports a timeout as timedOut, never as a thrown exception', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const result = await boundedFetch(fetchImpl as unknown as typeof fetch, 'https://api.example.com/', {}, Date.now() + 10)
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('never follows a redirect', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }))
    const result = await boundedFetch(fetchImpl as unknown as typeof fetch, 'https://api.example.com/', {}, Date.now() + 5000)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(302)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.com/', expect.objectContaining({ redirect: 'manual' }))
  })

  it('caps the response text and reports networkError distinctly from timedOut', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await boundedFetch(fetchImpl as unknown as typeof fetch, 'https://api.example.com/', {}, Date.now() + 5000)
    expect(result.networkError).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  it('returns ok for a 2xx response and surfaces the body text', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }))
    const result = await boundedFetch(fetchImpl as unknown as typeof fetch, 'https://api.example.com/', {}, Date.now() + 5000)
    expect(result.ok).toBe(true)
    expect(result.text).toBe('{"hello":"world"}')
  })
})
