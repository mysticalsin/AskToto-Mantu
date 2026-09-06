import { describe, expect, it } from 'vitest'
import { hostAllowed, normalizeHost, parseEgressAllowlist, requestHostname } from './egress-policy'

describe('parseEgressAllowlist', () => {
  it('absent or non-array means no policy; an explicit empty array is deny-all', () => {
    expect(parseEgressAllowlist('{}')).toBeNull()
    expect(parseEgressAllowlist('{"egressAllowlist":"graph.microsoft.com"}')).toBeNull()
    expect(parseEgressAllowlist('not json')).toBeNull()
    expect(parseEgressAllowlist('{"egressAllowlist":[]}')).toEqual([])
  })

  it('normalizes hosts, tolerates URLs and ports, drops junk, dedupes', () => {
    expect(
      parseEgressAllowlist(
        '{"egressAllowlist":["Graph.Microsoft.com.","https://login.microsoftonline.com/tenant","dust.tt:443","*.dust.tt",42,"","bad host"]}'
      )
    ).toEqual(['graph.microsoft.com', 'login.microsoftonline.com', 'dust.tt', '*.dust.tt'])
  })
})

describe('normalizeHost', () => {
  it('keeps wildcard entries and rejects non-host strings', () => {
    expect(normalizeHost('*.example.com')).toBe('*.example.com')
    expect(normalizeHost('https://a.b.example.com:8443/path?x=1')).toBe('a.b.example.com')
    expect(normalizeHost('a b')).toBeNull()
    expect(normalizeHost(null)).toBeNull()
  })
})

describe('hostAllowed', () => {
  const allow = ['graph.microsoft.com', '*.dust.tt']

  it('null policy allows everything; empty policy allows only loopback', () => {
    expect(hostAllowed('evil.example', null)).toBe(true)
    expect(hostAllowed('evil.example', [])).toBe(false)
    expect(hostAllowed('localhost', [])).toBe(true)
    expect(hostAllowed('127.0.0.1', [])).toBe(true)
    expect(hostAllowed('::1', [])).toBe(true)
  })

  it('exact entries match that host only; wildcard entries match the base and subdomains', () => {
    expect(hostAllowed('graph.microsoft.com', allow)).toBe(true)
    expect(hostAllowed('GRAPH.MICROSOFT.COM.', allow)).toBe(true)
    expect(hostAllowed('evil.graph.microsoft.com', allow)).toBe(false)
    expect(hostAllowed('graph.microsoft.com.evil.example', allow)).toBe(false)
    expect(hostAllowed('dust.tt', allow)).toBe(true)
    expect(hostAllowed('eu.dust.tt', allow)).toBe(true)
    expect(hostAllowed('notdust.tt', allow)).toBe(false)
    expect(hostAllowed('', allow)).toBe(false)
  })
})

describe('requestHostname', () => {
  it('reads string, URL and Request-like inputs; ignores non-network schemes', () => {
    expect(requestHostname('https://api.openai.com/v1/chat')).toBe('api.openai.com')
    expect(requestHostname(new URL('wss://relay.example/x'))).toBe('relay.example')
    expect(requestHostname({ url: 'http://127.0.0.1:8080/health' })).toBe('127.0.0.1')
    expect(requestHostname('data:text/plain,hi')).toBeNull()
    expect(requestHostname('file:///tmp/x.wasm')).toBeNull()
    expect(requestHostname('/relative')).toBeNull()
    expect(requestHostname(undefined)).toBeNull()
  })
})
