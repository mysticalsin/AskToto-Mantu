import { describe, expect, it } from 'vitest'
import { looksLikeSecret, safeChips, tokenPatternForTests } from './redact'

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
