import { describe, expect, it } from 'vitest'
import { configDisablesAutoUpdate } from './updater'

describe('configDisablesAutoUpdate — enterprise auto-update kill-switch', () => {
  it('disables updates only when disableAutoUpdate is exactly true', () => {
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": true}')).toBe(true)
  })

  it('leaves updates on when the key is false, absent, or a truthy-but-not-true value', () => {
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": false}')).toBe(false)
    expect(configDisablesAutoUpdate('{"provider": "anthropic"}')).toBe(false)
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": "true"}')).toBe(false) // string, not boolean
    expect(configDisablesAutoUpdate('{"disableAutoUpdate": 1}')).toBe(false)
  })

  it('fails open (updates on) on malformed or empty config, never throws', () => {
    expect(configDisablesAutoUpdate('')).toBe(false)
    expect(configDisablesAutoUpdate('not json')).toBe(false)
    expect(configDisablesAutoUpdate('null')).toBe(false)
  })
})
