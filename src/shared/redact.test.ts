import { describe, it, expect } from 'vitest'
import { redactSecrets } from './redact'

describe('redactSecrets', () => {
  it('redacts Luhn-valid credit cards (grouped or not)', () => {
    expect(redactSecrets('card 4242424242424242 expires')).toBe('card [redacted card] expires')
    expect(redactSecrets('4242 4242 4242 4242')).toBe('[redacted card]')
  })

  it('leaves non-Luhn digit runs and short numbers alone', () => {
    expect(redactSecrets('4242424242424241')).toBe('4242424242424241') // bad checksum
    expect(redactSecrets('order 1234567890')).toBe('order 1234567890') // too short to be a card
  })

  it('redacts SSNs but not phone numbers', () => {
    expect(redactSecrets('ssn 123-45-6789')).toBe('ssn [redacted SSN]')
    expect(redactSecrets('call 415-555-2671')).toBe('call 415-555-2671')
  })

  it('redacts recognised API keys / tokens', () => {
    expect(redactSecrets('key sk-ant-abc123DEF456ghi789jkl0mn')).toContain('[redacted key]')
    expect(redactSecrets('ghp_0123456789abcdefghijABCDEFG')).toBe('[redacted key]')
    expect(redactSecrets('aws AKIAIOSFODNN7EXAMPLE here')).toBe('aws [redacted key] here')
    expect(redactSecrets('Authorization: Bearer abcdef0123456789ABCDEF')).toContain('[redacted key]')
  })

  // MQA-080 — the generic sk- class excluded '-', so a dashed prefix stopped the run before it could
  // reach 20 chars and every such key (including the sk-kimi- one this app ships) left the device raw.
  it('redacts sk- keys with a dashed prefix (MQA-080)', () => {
    // Shortest shape cahe-embedded-key.ts accepts — proves the 20-char floor still clears the prefix.
    expect(redactSecrets('key sk-kimi-AbCdEf0123456789')).toBe('key [redacted key]')
    expect(redactSecrets('sk-proj-AbCdEf0123456789xyzQWERTY')).toBe('[redacted key]')
    expect(redactSecrets('sk-or-v1-0123456789abcdef0123')).toBe('[redacted key]')
    expect(redactSecrets('sk-ant-abc123DEF456ghi789jkl0mn')).toBe('[redacted key]')
    expect(redactSecrets('sk-0123456789abcdefghijklmno')).toBe('[redacted key]')
  })

  it('does not let the widened sk- class eat hyphenated prose (MQA-080)', () => {
    // 'sk' here is mid-word, so the word boundary — not the character class — is what holds the line.
    const chan = 'posted in #ask-me-anything-2026-planning yesterday'
    expect(redactSecrets(chan)).toBe(chan)
    expect(redactSecrets('sk-test-1234')).toBe('sk-test-1234') // far too short to be a key
  })

  it('redacts PEM private-key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    expect(redactSecrets(pem)).toBe('[redacted private key]')
  })

  it('redacts labeled secret assignments, keeping the label', () => {
    expect(redactSecrets('password: hunter2xyz')).toBe('password: [redacted]')
    expect(redactSecrets('api_key=ABCDEF123456')).toBe('api_key=[redacted]')
  })

  it('leaves ordinary meeting text untouched', () => {
    const t = 'We agreed to ship in Q3, owner is Maya, budget is 50000 euros.'
    expect(redactSecrets(t)).toBe(t)
    expect(redactSecrets('')).toBe('')
  })
})
