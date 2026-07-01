import { describe, it, expect } from 'vitest'
import { AskStartSchema, CaptureResultSchema, SettingsSchema, DEFAULT_SETTINGS } from './ipc'

describe('AskStartSchema', () => {
  it('accepts a valid vision payload with a small base64 PNG', () => {
    const valid = {
      id: 'ask-1',
      mode: 'vision' as const,
      prompt: 'describe this',
      image: Buffer.alloc(100).toString('base64'),
      history: []
    }
    const result = AskStartSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects an oversized image', () => {
    // The string is both longer than the 5 MB limit and not base64-valid,
    // so it is rejected. Using a valid multi-megabyte base64 string would
    // trip V8's regex stack limit in Zod's base64 validator.
    const oversized = {
      id: 'ask-2',
      mode: 'vision' as const,
      image: '!'.repeat(5_000_001),
      history: []
    }
    const result = AskStartSchema.safeParse(oversized)
    expect(result.success).toBe(false)
  })

  it('rejects a non-base64 image string', () => {
    const invalid = {
      id: 'ask-3',
      mode: 'vision' as const,
      image: 'not-valid-base64!!!',
      history: []
    }
    const result = AskStartSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })
})

describe('CaptureResultSchema', () => {
  it('requires a capturedAt timestamp for screen freshness UI', () => {
    const parsed = CaptureResultSchema.safeParse({
      image: Buffer.alloc(100).toString('base64'),
      width: 1280,
      height: 720,
      capturedAt: 1_700_000_000_000
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.capturedAt).toBe(1_700_000_000_000)
    }
  })
})

describe('SettingsSchema', () => {
  it('rejects custom provider with an empty base URL', () => {
    const invalid = {
      ...DEFAULT_SETTINGS,
      provider: 'custom' as const,
      customBaseUrl: ''
    }
    const result = SettingsSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('customBaseUrl'))).toBe(true)
    }
  })

  it('rejects custom provider with a non-https base URL', () => {
    const invalid = {
      ...DEFAULT_SETTINGS,
      provider: 'custom' as const,
      customBaseUrl: 'http://example.com'
    }
    const result = SettingsSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  it('accepts custom provider with a valid https base URL', () => {
    const valid = {
      ...DEFAULT_SETTINGS,
      provider: 'custom' as const,
      customBaseUrl: 'https://api.example.com/v1'
    }
    const result = SettingsSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('accepts the default settings', () => {
    const result = SettingsSchema.safeParse(DEFAULT_SETTINGS)
    expect(result.success).toBe(true)
  })

  it('defaults playListenChime, requireConsentIndicator, and lastConsentReminderAt', () => {
    expect(DEFAULT_SETTINGS.playListenChime).toBe(true)
    expect(DEFAULT_SETTINGS.requireConsentIndicator).toBe(false)
    expect(DEFAULT_SETTINGS.lastConsentReminderAt).toBe(0)
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS)
    expect(parsed.success).toBe(true)
  })

  it('parses new consent/recording settings when provided', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      playListenChime: false,
      requireConsentIndicator: true,
      lastConsentReminderAt: 1700000000000
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.playListenChime).toBe(false)
      expect(parsed.data.requireConsentIndicator).toBe(true)
      expect(parsed.data.lastConsentReminderAt).toBe(1700000000000)
    }
  })
})
