import { describe, it, expect } from 'vitest'
import { detectProxyFromEnv, parseElectronProxy, redactProxyUrl } from './proxy-url'

describe('detectProxyFromEnv', () => {
  it('returns null when no proxy var is set (direct connection)', () => {
    expect(detectProxyFromEnv({})).toBeNull()
    expect(detectProxyFromEnv({ NO_PROXY: 'localhost' })).toBeNull()
  })

  it('prefers HTTPS_PROXY over HTTP_PROXY', () => {
    expect(
      detectProxyFromEnv({ HTTPS_PROXY: 'http://secure:8080', HTTP_PROXY: 'http://plain:3128' })
    ).toBe('http://secure:8080')
  })

  it('falls back through http/all proxy variants (incl. lowercase)', () => {
    expect(detectProxyFromEnv({ HTTP_PROXY: 'http://p:3128' })).toBe('http://p:3128')
    expect(detectProxyFromEnv({ http_proxy: 'http://p:3128' })).toBe('http://p:3128')
    expect(detectProxyFromEnv({ ALL_PROXY: 'http://p:3128' })).toBe('http://p:3128')
    expect(detectProxyFromEnv({ all_proxy: 'http://p:3128' })).toBe('http://p:3128')
  })
})

describe('redactProxyUrl', () => {
  it('strips user:pass credentials before logging', () => {
    // The real Mantu/sandbox proxy shape: http://user:token@host:port
    expect(redactProxyUrl('http://srt:2369449e1d13d04a74233abd731e04cb@localhost:50004')).toBe(
      'http://localhost:50004/'
    )
  })

  it('leaves a credential-free proxy url intact', () => {
    expect(redactProxyUrl('http://proxy.corp:3128')).toBe('http://proxy.corp:3128/')
  })

  it('never echoes an unparseable value verbatim', () => {
    expect(redactProxyUrl('not a url with secret@stuff')).toBe('(set)')
  })
})

describe('parseElectronProxy', () => {
  it('returns null for a direct connection', () => {
    expect(parseElectronProxy('DIRECT')).toBeNull()
    expect(parseElectronProxy('')).toBeNull()
  })

  it('parses a PROXY entry into an http:// url undici can tunnel through', () => {
    expect(parseElectronProxy('PROXY proxy.corp:3128')).toBe('http://proxy.corp:3128')
    expect(parseElectronProxy('HTTPS secure.corp:8080')).toBe('http://secure.corp:8080')
  })

  it('takes the first usable hop from a PAC fallback list', () => {
    expect(parseElectronProxy('PROXY a.corp:3128; PROXY b.corp:3128; DIRECT')).toBe('http://a.corp:3128')
    // A leading DIRECT that the OS lists first is skipped in favor of the named proxy hop.
    expect(parseElectronProxy('SOCKS5 s.corp:1080; PROXY b.corp:3128')).toBe('http://b.corp:3128')
  })

  it('returns null when the only hops are SOCKS (undici ProxyAgent cannot use them)', () => {
    expect(parseElectronProxy('SOCKS5 s.corp:1080')).toBeNull()
    expect(parseElectronProxy('SOCKS s.corp:1080; DIRECT')).toBeNull()
  })
})
