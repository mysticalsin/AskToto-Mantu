import { describe, expect, it } from 'vitest'
import {
  looksLikeSecret,
  providerRefusedPayload,
  redactUpstreamSnippet,
  safeChips,
  tokenPatternForTests,
  UPSTREAM_SNIPPET_CAP
} from './redact'

describe('token-free events', () => {
  it('detects bearer, sk-, JWT, HMAC hex, and long base64', () => {
    expect(looksLikeSecret('Bearer abcdefghijklmnop')).toBe(true)
    expect(looksLikeSecret('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(looksLikeSecret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.signaturexx')).toBe(true)
    expect(looksLikeSecret('a'.repeat(64).replace(/a/g, 'ab').slice(0, 64))).toBe(true)
    expect(looksLikeSecret('interview')).toBe(false)
    expect(looksLikeSecret('darwin')).toBe(false)
    expect(looksLikeSecret('CA')).toBe(false)
  })

  it('drops secret chips and keeps safe metadata', () => {
    const chips = safeChips({
      mode: 'interview',
      os: 'darwin',
      authorization: 'Bearer abcdefghijklmnop',
      token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      cache: 'hit'
    })
    expect(chips.map((c) => c.key).sort()).toEqual(['cache', 'mode', 'os'])
    expect(JSON.stringify(chips)).not.toMatch(tokenPatternForTests())
  })
})

describe('redacted upstream snippets', () => {
  it('caps at 200, strips Authorization / tokens / known secrets, and omits prompts', () => {
    const secret = 'sk-cf-OPERATOR-VAULT-TEST-only-xx99'
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    expect(redactUpstreamSnippet(long).length).toBe(UPSTREAM_SNIPPET_CAP)
    const mixed = `Gateway missing Authorization: Bearer ${secret} then more`
    const redacted = redactUpstreamSnippet(mixed, [secret])
    expect(redacted).not.toContain(secret)
    expect(redacted).not.toMatch(/Bearer /i)
    expect(redacted).toContain('Gateway missing')
    const payload = providerRefusedPayload(
      400,
      JSON.stringify({
        errors: [{ code: 7003, message: `No route Bearer ${secret}` }],
        messages: [{ role: 'user', content: 'full prompt that must not leak' }]
      }),
      [secret]
    )
    expect(payload.upstreamStatus).toBe(400)
    expect(payload.error).toContain('upstream 400')
    expect(payload.upstreamSnippet).toContain('7003')
    expect(JSON.stringify(payload)).not.toContain(secret)
    expect(JSON.stringify(payload)).not.toContain('full prompt that must not leak')
    expect(JSON.stringify(payload)).not.toMatch(tokenPatternForTests())
  })
})
