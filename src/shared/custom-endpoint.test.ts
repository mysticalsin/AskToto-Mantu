import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema } from './ipc'
import { customEndpointError } from './custom-endpoint'

describe('customEndpointError', () => {
  it('accepts an https address and an optional empty value', () => {
    expect(customEndpointError('https://api.example.invalid/v1')).toBeNull()
    expect(customEndpointError('  HTTPS://api.example.invalid  ')).toBeNull()
    expect(customEndpointError('')).toBeNull()
  })

  it('explains each refusal in a sentence', () => {
    expect(customEndpointError('', { required: true })).toBe('Enter the endpoint address. It starts with https://.')
    expect(customEndpointError('http://api.example.invalid')).toBe('Use an address that starts with https://.')
    expect(customEndpointError('api.example.invalid')).toBe('Use an address that starts with https://.')
    expect(customEndpointError('https://')).toBe('Enter a full address, like https://your-endpoint/v1.')
  })

  it('never accepts what the settings schema would refuse', () => {
    const shape = BaseSettingsSchema.shape.customBaseUrl
    for (const value of ['http://a.invalid', 'ftp://a.invalid', 'a.invalid', 'https://a.invalid/v1']) {
      if (customEndpointError(value) === null) expect(shape.safeParse(value).success).toBe(true)
    }
  })
})
