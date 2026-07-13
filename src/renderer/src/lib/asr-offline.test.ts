import { describe, expect, it } from 'vitest'
import { shouldUseBundledAsr } from './asr-offline'

describe('shouldUseBundledAsr', () => {
  it('forces installer-owned assets in production even when a caller reports false', () => {
    expect(shouldUseBundledAsr(true, false)).toBe(true)
  })

  it('fails closed when the bundled-assets probe fails or returns no value', () => {
    expect(shouldUseBundledAsr(false, undefined)).toBe(true)
    expect(shouldUseBundledAsr(false, null)).toBe(true)
  })

  it('allows the remote resolver only for an explicit false result in development', () => {
    expect(shouldUseBundledAsr(false, true)).toBe(true)
    expect(shouldUseBundledAsr(false, false)).toBe(false)
  })
})
