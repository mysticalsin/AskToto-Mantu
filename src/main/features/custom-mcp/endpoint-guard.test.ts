import { describe, expect, it } from 'vitest'
import { customAddressGuard, checkHttpsEndpoint, isPrivateOrLocalAddress } from './endpoint-guard'
import { readCustomMcpPolicy, type CustomMcpPolicy } from './policy'

const base = readCustomMcpPolicy(null, null)
const privateOk: CustomMcpPolicy = { ...base, allowPrivateNetwork: true }
const rule = (url: string, p: CustomMcpPolicy = base): string | null => {
  const r = checkHttpsEndpoint(url, p)
  return r.ok ? null : r.rule
}

describe('custom MCP endpoint guard', () => {
  it('accepts a public https endpoint and reports its host only', () => {
    expect(checkHttpsEndpoint('https://mcp.example.com/v1/mcp?x=1', base)).toEqual({
      ok: true,
      host: 'mcp.example.com'
    })
  })

  it('rejects http:', () => {
    expect(rule('http://mcp.example.com/mcp')).toBe('customMcp.https')
    expect(rule('ftp://mcp.example.com/mcp')).toBe('customMcp.https')
    expect(rule('not a url')).toBe('customMcp.url')
  })

  it('rejects userinfo', () => {
    expect(rule('https://user:pw@mcp.example.com/mcp')).toBe('customMcp.credentials')
    expect(rule('https://user@mcp.example.com/mcp')).toBe('customMcp.credentials')
  })

  it.each([
    'https://10.1.2.3/mcp',
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://[fc00::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://localhost/mcp',
    'https://printer.local/mcp',
    'https://db.internal/mcp',
    'https://192.168.1.5/mcp',
    'https://172.20.0.1/mcp',
    'https://100.64.0.1/mcp',
    'https://0.0.0.0/mcp'
  ])('rejects private/loopback target %s', (url) => {
    expect(rule(url)).toBe('customMcp.allowPrivateNetwork')
  })

  it('the whole link-local range is refused as metadata, whatever the policy', () => {
    expect(rule('https://169.254.10.10/mcp')).toBe('customMcp.metadata')
    expect(rule('https://169.254.10.10/mcp', privateOk)).toBe('customMcp.metadata')
  })

  it('private allowed only with allowPrivateNetwork', () => {
    expect(rule('https://10.1.2.3/mcp', privateOk)).toBeNull()
    expect(rule('https://localhost/mcp', privateOk)).toBeNull()
  })

  it('metadata blocked even when private allowed', () => {
    expect(rule('https://169.254.169.254/latest', privateOk)).toBe('customMcp.metadata')
    expect(rule('https://metadata.google.internal/', privateOk)).toBe('customMcp.metadata')
    expect(rule('https://[::ffff:169.254.169.254]/', privateOk)).toBe('customMcp.metadata')
  })

  it('allowedHosts enforced', () => {
    const p = { ...base, allowedHosts: ['*.corp.example', 'mcp.ok.example'] }
    expect(rule('https://a.corp.example/mcp', p)).toBeNull()
    expect(rule('https://mcp.ok.example/mcp', p)).toBeNull()
    expect(rule('https://evil.example/mcp', p)).toBe('customMcp.allowedHosts')
  })

  it('loopback not passed by hostAllowed shortcut', () => {
    const p = { ...base, allowedHosts: ['mcp.ok.example'] }
    expect(rule('https://localhost/mcp', p)).toBe('customMcp.allowPrivateNetwork')
    expect(rule('https://127.0.0.1/mcp', p)).toBe('customMcp.allowPrivateNetwork')
    // with private allowed, the allow-list still applies to loopback hosts
    expect(rule('https://localhost/mcp', { ...p, allowPrivateNetwork: true })).toBe('customMcp.allowedHosts')
  })

  it('a policy that is off refuses everything naming its rule', () => {
    expect(rule('https://mcp.example.com/mcp', { ...base, allow: false, deniedRule: 'customMcp.allow' })).toBe(
      'customMcp.allow'
    )
  })

  it('isPrivateOrLocalAddress covers ranges and mapped forms', () => {
    for (const ip of [
      '0.1.1.1',
      '10.0.0.1',
      '100.127.0.1',
      '127.9.9.9',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.0.1',
      '::',
      '::1',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1'
    ])
      expect(isPrivateOrLocalAddress(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(isPrivateOrLocalAddress(ip), ip).toBe(false)
  })

  it('customAddressGuard refuses a resolved private address unless allowed, and always metadata', () => {
    expect(customAddressGuard(base)('10.0.0.5')).toBeInstanceOf(Error)
    expect(customAddressGuard(base)('93.184.216.34')).toBeNull()
    expect(customAddressGuard(privateOk)('10.0.0.5')).toBeNull()
    expect(customAddressGuard(privateOk)('169.254.169.254')).toBeInstanceOf(Error)
  })
})
