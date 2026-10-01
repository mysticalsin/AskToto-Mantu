import { describe, expect, it } from 'vitest'
import { pathTagForSeatProvider } from './operator-ingest'

describe('pathTagForSeatProvider', () => {
  it('tags Operator-proxied Cloudflare as portal-cf', () => {
    expect(pathTagForSeatProvider('cloudflare', true)).toBe('portal-cf')
  })
  it('tags Operator-proxied DeepSeek as portal-direct', () => {
    expect(pathTagForSeatProvider('deepseek', true)).toBe('portal-direct')
  })
  it('tags CLI providers as cli when not via Operator', () => {
    expect(pathTagForSeatProvider('claude-cli', false)).toBe('cli')
  })
  it('tags seat-local key providers when not via Operator', () => {
    expect(pathTagForSeatProvider('openai', false)).toBe('seat-local')
  })
})
