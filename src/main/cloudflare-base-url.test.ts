import { describe, expect, it } from 'vitest'
import {
  cloudflareBaseUrlAllowed,
  cloudflareBaseUrlHostname,
  isWorkersDevHost,
  parseCloudflareBaseUrlAllowlist
} from './cloudflare-base-url'

describe('cloudflareBaseUrl packaged pin', () => {
  it('recognises workers.dev hosts and rejects lookalikes', () => {
    expect(isWorkersDevHost('metis-ai.example.workers.dev')).toBe(true)
    expect(isWorkersDevHost('workers.dev')).toBe(true)
    expect(isWorkersDevHost('evil.workers.dev.attacker.com')).toBe(false)
    expect(isWorkersDevHost('workers.dev.evil.com')).toBe(false)
    expect(isWorkersDevHost('api.cloudflare.com')).toBe(false)
  })

  it('parses admin cloudflareBaseUrlAllowlist hostnames and wildcards', () => {
    expect(parseCloudflareBaseUrlAllowlist('{"cloudflareBaseUrlAllowlist":["proxy.example.com","*.corp.example"]}')).toEqual([
      'proxy.example.com',
      '*.corp.example'
    ])
    expect(parseCloudflareBaseUrlAllowlist('{"cloudflareBaseUrlAllowlist":[]}')).toEqual([])
    expect(parseCloudflareBaseUrlAllowlist('not-json')).toEqual([])
    expect(parseCloudflareBaseUrlAllowlist(null)).toEqual([])
  })

  it('unpackaged: any https URL is allowed; empty mid-setup is allowed', () => {
    expect(cloudflareBaseUrlAllowed('', { packaged: false })).toBe(true)
    expect(cloudflareBaseUrlAllowed('https://attacker.example/v1', { packaged: false })).toBe(true)
    expect(cloudflareBaseUrlAllowed('http://insecure.example/v1', { packaged: false })).toBe(false)
  })

  it('packaged: only *.workers.dev by default — attacker hosts fail closed', () => {
    expect(cloudflareBaseUrlAllowed('https://metis-ai.example.workers.dev/v1', { packaged: true })).toBe(true)
    expect(cloudflareBaseUrlAllowed('https://attacker.example/steal', { packaged: true })).toBe(false)
    expect(cloudflareBaseUrlAllowed('https://api.cloudflare.com/client/v4/accounts/x/ai/v1', { packaged: true })).toBe(
      false
    )
    expect(cloudflareBaseUrlAllowed('', { packaged: true })).toBe(true)
  })

  it('packaged: admin allowlist and admin-configured URL enable self-host', () => {
    expect(
      cloudflareBaseUrlAllowed('https://proxy.corp.example/v1', {
        packaged: true,
        adminAllowlist: ['proxy.corp.example']
      })
    ).toBe(true)
    expect(
      cloudflareBaseUrlAllowed('https://edge.corp.example/v1', {
        packaged: true,
        adminAllowlist: ['*.corp.example']
      })
    ).toBe(true)
    expect(
      cloudflareBaseUrlAllowed('https://selfhost.example/v1', {
        packaged: true,
        adminConfiguredUrl: 'https://selfhost.example/v1'
      })
    ).toBe(true)
    // User-writable host still refused without admin listing
    expect(
      cloudflareBaseUrlAllowed('https://attacker.example/v1', {
        packaged: true,
        adminAllowlist: ['proxy.corp.example'],
        adminConfiguredUrl: 'https://selfhost.example/v1'
      })
    ).toBe(false)
  })

  it('cloudflareBaseUrlHostname requires https', () => {
    expect(cloudflareBaseUrlHostname('https://x.workers.dev/v1')).toBe('x.workers.dev')
    expect(cloudflareBaseUrlHostname('http://x.workers.dev/v1')).toBe(null)
    expect(cloudflareBaseUrlHostname('')).toBe(null)
  })
})
