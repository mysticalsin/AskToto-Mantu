import { describe, expect, it } from 'vitest'
import { freezeAsciiUserAgent } from './app-user-agent'

describe('startup User-Agent normalization (ENT-029)', () => {
  it.each([
    ['Mozilla/5.0 asktoto/1.8.9 Chrome/142.0.0.0', 'Mozilla/5.0 asktoto/1.8.9 Chrome/142.0.0.0'],
    ['Mozilla/5.0 Métis/1.8.9 Chrome/142.0.0.0', 'Mozilla/5.0 Metis/1.8.9 Chrome/142.0.0.0'],
    ['Mozilla/5.0 Me\u0301tis/1.8.9 Chrome/142.0.0.0', 'Mozilla/5.0 Metis/1.8.9 Chrome/142.0.0.0'],
    ['Mozilla/5.0 Métis\r\nInjected: value/1.8.9', 'Mozilla/5.0 MetisInjected: value/1.8.9']
  ])('keeps the fallback HTTP-safe without dropping normal UA tokens: %s', (input, expected) => {
    const application = { userAgentFallback: input }
    freezeAsciiUserAgent(application)
    expect(application.userAgentFallback).toBe(expected)
    // Characterize Electron's native byte-header -> UTF-8 reconstruction boundary. The original
    // Latin-1 é becomes U+FFFD, so only testing new Headers(original) misses this failure.
    const reconstructed = Buffer.from(application.userAgentFallback, 'latin1').toString('utf8')
    expect(new Headers({ 'User-Agent': reconstructed }).get('User-Agent')).toBe(expected)
  })

  it('freezes the default before a later display-name change can reintroduce accented header bytes', () => {
    let displayName = 'asktoto'
    let override: string | undefined
    const application = {
      get userAgentFallback() { return override ?? `Mozilla/5.0 ${displayName}/1.8.9` },
      set userAgentFallback(value: string) { override = value }
    }
    freezeAsciiUserAgent(application)
    displayName = 'Métis'
    expect(application.userAgentFallback).toBe('Mozilla/5.0 asktoto/1.8.9')
    expect(displayName).toBe('Métis')
  })

  it('is idempotent when another edition initializer freezes the normalized value again', () => {
    const application = { userAgentFallback: 'Mozilla/5.0 Métis/1.8.9' }
    freezeAsciiUserAgent(application)
    application.userAgentFallback = application.userAgentFallback
    freezeAsciiUserAgent(application)
    expect(application.userAgentFallback).toBe('Mozilla/5.0 Metis/1.8.9')
  })
})
