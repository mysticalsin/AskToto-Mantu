import { describe, it, expect } from 'vitest'
import {
  AskStartSchema,
  CaptureResultSchema,
  SettingsSchema,
  DEFAULT_SETTINGS,
  McpCrmTestConnectionPayloadSchema,
  McpCrmSaveConnectionPayloadSchema,
  McpCrmPushPayloadSchema
} from './ipc'

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

  it('defaults bidstackEndpointUrl, bidstackConnected, and bidstackTools', () => {
    expect(DEFAULT_SETTINGS.bidstackEndpointUrl).toBe('')
    expect(DEFAULT_SETTINGS.bidstackConnected).toBe(false)
    expect(DEFAULT_SETTINGS.bidstackTools).toEqual([])
  })
})

// BidStack CRM (MCP push) IPC payload validation — this is what index.ts's mcpCrm:* handlers run
// every incoming payload through before ever touching the network or persisting anything.
describe('McpCrmTestConnectionPayloadSchema / McpCrmSaveConnectionPayloadSchema', () => {
  it('accepts a valid endpoint + key', () => {
    const r = McpCrmTestConnectionPayloadSchema.safeParse({
      endpointUrl: 'http://localhost:4001/mcp',
      apiKey: 'sk-bidstack-abc'
    })
    expect(r.success).toBe(true)
  })

  it('rejects an empty endpoint URL', () => {
    const r = McpCrmTestConnectionPayloadSchema.safeParse({ endpointUrl: '', apiKey: 'sk-abc' })
    expect(r.success).toBe(false)
  })

  it('rejects an empty API key', () => {
    const r = McpCrmTestConnectionPayloadSchema.safeParse({ endpointUrl: 'http://localhost:4001/mcp', apiKey: '' })
    expect(r.success).toBe(false)
  })

  it('rejects a missing field entirely', () => {
    const r = McpCrmTestConnectionPayloadSchema.safeParse({ endpointUrl: 'http://localhost:4001/mcp' })
    expect(r.success).toBe(false)
  })

  it('rejects a non-object payload (e.g. a compromised/malformed renderer message)', () => {
    expect(McpCrmTestConnectionPayloadSchema.safeParse(null).success).toBe(false)
    expect(McpCrmTestConnectionPayloadSchema.safeParse('http://localhost:4001/mcp').success).toBe(false)
    expect(McpCrmTestConnectionPayloadSchema.safeParse(undefined).success).toBe(false)
  })

  it('SaveConnection uses the identical shape as TestConnection', () => {
    const payload = { endpointUrl: 'http://localhost:4001/mcp', apiKey: 'sk-abc' }
    expect(McpCrmSaveConnectionPayloadSchema.safeParse(payload).success).toBe(true)
  })
})

describe('McpCrmPushPayloadSchema', () => {
  it('accepts a tool name with a plain args record', () => {
    const r = McpCrmPushPayloadSchema.safeParse({
      toolName: 'push_meeting_recap',
      args: { title: 'Q3 sync', date: '2026-06-30', summary: 'Recap text.' }
    })
    expect(r.success).toBe(true)
  })

  it('accepts empty args', () => {
    const r = McpCrmPushPayloadSchema.safeParse({ toolName: 'push_meeting_recap', args: {} })
    expect(r.success).toBe(true)
  })

  it('rejects an empty tool name — never silently pushes to an unspecified tool', () => {
    const r = McpCrmPushPayloadSchema.safeParse({ toolName: '', args: {} })
    expect(r.success).toBe(false)
  })

  it('rejects a missing args field', () => {
    const r = McpCrmPushPayloadSchema.safeParse({ toolName: 'push_meeting_recap' })
    expect(r.success).toBe(false)
  })

  it('rejects args that is not a record (e.g. an array or string)', () => {
    expect(McpCrmPushPayloadSchema.safeParse({ toolName: 'x', args: [] }).success).toBe(false)
    expect(McpCrmPushPayloadSchema.safeParse({ toolName: 'x', args: 'not-an-object' }).success).toBe(false)
  })

  it('rejects a nested object/array value inside args — flat primitives only', () => {
    const r = McpCrmPushPayloadSchema.safeParse({ toolName: 'x', args: { nested: { a: 1 } } })
    expect(r.success).toBe(false)
  })

  it('rejects an oversized string value inside args', () => {
    const r = McpCrmPushPayloadSchema.safeParse({ toolName: 'x', args: { summary: 'a'.repeat(50_001) } })
    expect(r.success).toBe(false)
  })

  it('rejects an args object with too many fields', () => {
    const args: Record<string, string> = {}
    for (let i = 0; i < 21; i++) args[`field${i}`] = 'v'
    const r = McpCrmPushPayloadSchema.safeParse({ toolName: 'x', args })
    expect(r.success).toBe(false)
  })

  it('accepts string/number/boolean/null primitive values within bounds', () => {
    const r = McpCrmPushPayloadSchema.safeParse({
      toolName: 'x',
      args: { title: 'ok', count: 3, active: true, note: null }
    })
    expect(r.success).toBe(true)
  })
})
