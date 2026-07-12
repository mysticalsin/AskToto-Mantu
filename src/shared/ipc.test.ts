import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AskStartSchema,
  CaptureResultSchema,
  SettingsSchema,
  DEFAULT_SETTINGS,
  IPC,
  McpCrmTestConnectionPayloadSchema,
  McpCrmSaveConnectionPayloadSchema,
  McpCrmPushPayloadSchema,
  StreamMetaSchema,
  EntityRenamePayloadSchema,
  EntityMergePayloadSchema,
  EntityUnmergePayloadSchema,
  EntityUpdateFieldPayloadSchema,
  CommitmentRejectPayloadSchema,
  MeetingExtractionQuerySchema,
  AttentionItemSchema,
  BrainAttentionResultSchema,
  appendAsrCorrection
} from './ipc'

/** process.platform is configurable in Node — flip it for the duration of a platform-specific test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

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

  it('accepts only a UUID localSessionId', () => {
    const base = { id: 'ask-4', mode: 'answer' as const, history: [] }
    expect(
      AskStartSchema.safeParse({ ...base, localSessionId: '123e4567-e89b-12d3-a456-426614174000' }).success
    ).toBe(true)
    expect(AskStartSchema.safeParse({ ...base, localSessionId: 'not-a-uuid' }).success).toBe(false)
  })

  it('accepts bounded structured visionEvidence only for vision mode and without a raw image', () => {
    const visionEvidence = {
      version: 1,
      modelId: 'smolvlm-256m-instruct',
      modelSha256: 'a'.repeat(64),
      capturedAt: 1,
      backend: 'wasm' as const,
      capabilities: ['caption'] as const,
      caption: 'A roadmap slide',
      text: '',
      regions: []
    }
    expect(
      AskStartSchema.safeParse({ id: 'ask-5', mode: 'vision', visionEvidence, history: [] }).success
    ).toBe(true)
    expect(
      AskStartSchema.safeParse({ id: 'ask-6', mode: 'answer', visionEvidence, history: [] }).success
    ).toBe(false)
    expect(
      AskStartSchema.safeParse({
        id: 'ask-7',
        mode: 'vision',
        visionEvidence,
        image: Buffer.alloc(100).toString('base64'),
        history: []
      }).success
    ).toBe(false)
    expect(
      AskStartSchema.safeParse({
        id: 'ask-7-empty-image',
        mode: 'vision',
        visionEvidence,
        image: '',
        history: []
      }).success
    ).toBe(false)
  })

  it('rejects visionEvidence whose complete JSON exceeds 64 KiB UTF-8', () => {
    const visionEvidence = {
      version: 1,
      modelId: 'smolvlm-256m-instruct',
      modelSha256: 'a'.repeat(64),
      capturedAt: 1,
      backend: 'wasm' as const,
      capabilities: ['regions'] as const,
      caption: '',
      text: '',
      regions: Array.from({ length: 200 }, () => ({ text: 'é'.repeat(400), box: [0, 0, 1, 1] }))
    }
    expect(new TextEncoder().encode(JSON.stringify(visionEvidence)).length).toBeGreaterThan(64 * 1024)
    expect(AskStartSchema.safeParse({ id: 'ask-8', mode: 'vision', visionEvidence, history: [] }).success).toBe(false)
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
    // On by default: it's the only consent mechanism Métis has, so the persistent reminder should be
    // the opt-out, not the opt-in (mirrors the encryptTranscripts default-flip reasoning).
    expect(DEFAULT_SETTINGS.requireConsentIndicator).toBe(true)
    expect(DEFAULT_SETTINGS.lastConsentReminderAt).toBe(0)
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS)
    expect(parsed.success).toBe(true)
  })

  it('parses new consent/recording settings when provided (including turning the indicator off)', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      playListenChime: false,
      requireConsentIndicator: false,
      lastConsentReminderAt: 1700000000000
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.playListenChime).toBe(false)
      expect(parsed.data.requireConsentIndicator).toBe(false)
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

// Correction engine (Task MI-2) IPC payload validation — this is what index.ts's five brain:entity*/
// brain:commitmentReject handlers run every incoming payload through before ever touching the store.
describe('EntityRenamePayloadSchema', () => {
  it('accepts a valid rename, with and without alsoFixAsr', () => {
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'acme-corp', newName: 'Acme' }).success).toBe(true)
    expect(
      EntityRenamePayloadSchema.safeParse({ kind: 'person', id: 'm-silva', newName: 'Maria Silva', alsoFixAsr: true })
        .success
    ).toBe(true)
  })

  it('rejects an invalid kind, an empty id/newName, and a non-boolean alsoFixAsr', () => {
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'meeting', id: 'x', newName: 'Y' }).success).toBe(false)
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: '', newName: 'Y' }).success).toBe(false)
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'x', newName: '' }).success).toBe(false)
    expect(
      EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'x', newName: 'Y', alsoFixAsr: 'yes' }).success
    ).toBe(false)
  })

  it('rejects a missing field entirely and a non-object payload', () => {
    expect(EntityRenamePayloadSchema.safeParse({ id: 'x', newName: 'Y' }).success).toBe(false)
    expect(EntityRenamePayloadSchema.safeParse(null).success).toBe(false)
  })

  // MI-2.5 Fix B: a path-traversal/non-slug id is rejected OUTRIGHT here, before the payload ever reaches
  // the main-process handler — defense in depth alongside corrections.ts's own slugify sanitization.
  it('rejects a path-traversal or otherwise non-slug id', () => {
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: '../../../etc/hosts', newName: 'Y' }).success).toBe(
      false
    )
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'Acme Corp', newName: 'Y' }).success).toBe(false) // spaces/uppercase — not a slug
    expect(EntityRenamePayloadSchema.safeParse({ kind: 'account', id: 'acme-corp', newName: 'Y' }).success).toBe(true) // a real slug still passes
  })

  // The pair alsoFixAsr composes in index.ts must round-trip through the SAME settings.asrCorrections
  // shape commitLine's consumer expects (lib/listen.ts: c.from / c.to, both plain strings).
  it('a constructed {from, to} correction pair round-trips through the persisted settings shape', () => {
    const pair = { from: 'Acme Corp', to: 'Acme' }
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: [pair] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.asrCorrections).toEqual([pair])
  })
})

describe('EntityMergePayloadSchema', () => {
  it('accepts a valid merge and rejects a missing fromId/intoId or bad kind', () => {
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: 'a', intoId: 'b' }).success).toBe(true)
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: '', intoId: 'b' }).success).toBe(false)
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', intoId: 'b' }).success).toBe(false)
    expect(EntityMergePayloadSchema.safeParse({ kind: 'invalid', fromId: 'a', intoId: 'b' }).success).toBe(false)
  })

  it('rejects a path-traversal fromId/intoId', () => {
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: '../../secrets', intoId: 'b' }).success).toBe(
      false
    )
    expect(EntityMergePayloadSchema.safeParse({ kind: 'deal', fromId: 'a', intoId: '../../secrets' }).success).toBe(
      false
    )
  })
})

describe('EntityUnmergePayloadSchema', () => {
  it('accepts a non-negative integer targetSeq and rejects negative/fractional/missing', () => {
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: 0 }).success).toBe(true)
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: 3 }).success).toBe(true)
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: -1 }).success).toBe(false)
    expect(EntityUnmergePayloadSchema.safeParse({ targetSeq: 1.5 }).success).toBe(false)
    expect(EntityUnmergePayloadSchema.safeParse({}).success).toBe(false)
  })
})

describe('EntityUpdateFieldPayloadSchema', () => {
  it('accepts any field name + unknown value shape here — corrections.ts validates per (kind, field)', () => {
    expect(
      EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: 'acme-core', field: 'stage', value: 'contract' })
        .success
    ).toBe(true)
    expect(
      EntityUpdateFieldPayloadSchema.safeParse({
        kind: 'deal',
        id: 'acme-core',
        field: 'velocity',
        value: { signal: 'hard-calendar-gate', evidence: 'go/no-go June 3' }
      }).success
    ).toBe(true)
  })

  it('rejects an empty id/field and a missing kind', () => {
    expect(EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: '', field: 'stage', value: 'x' }).success).toBe(
      false
    )
    expect(EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: 'x', field: '', value: 'x' }).success).toBe(
      false
    )
    expect(EntityUpdateFieldPayloadSchema.safeParse({ id: 'x', field: 'stage', value: 'x' }).success).toBe(false)
  })

  it('rejects a path-traversal id', () => {
    expect(
      EntityUpdateFieldPayloadSchema.safeParse({ kind: 'deal', id: '../../secrets', field: 'stage', value: 'x' })
        .success
    ).toBe(false)
  })
})

describe('CommitmentRejectPayloadSchema', () => {
  it('accepts personSlug + text with dealSlug optional, rejects an empty personSlug/text', () => {
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', text: 'send the deck' }).success).toBe(
      true
    )
    expect(
      CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', dealSlug: 'acme-core', text: 'x' }).success
    ).toBe(true)
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: '', text: 'x' }).success).toBe(false)
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', text: '' }).success).toBe(false)
  })

  it('rejects a path-traversal personSlug/dealSlug', () => {
    expect(CommitmentRejectPayloadSchema.safeParse({ personSlug: '../../secrets', text: 'x' }).success).toBe(false)
    expect(
      CommitmentRejectPayloadSchema.safeParse({ personSlug: 'maria-silva', dealSlug: '../../secrets', text: 'x' })
        .success
    ).toBe(false)
  })
})

// Task MI-3 read-only channels: brain:meetingExtraction / brain:attention payload + result shapes.
describe('MeetingExtractionQuerySchema (brain:meetingExtraction)', () => {
  it('accepts a file path or basename', () => {
    expect(MeetingExtractionQuerySchema.safeParse({ file: 'meeting-2026-07-11.md' }).success).toBe(true)
    expect(MeetingExtractionQuerySchema.safeParse({ file: '/Users/x/Meetings/meeting.md' }).success).toBe(true)
  })

  it('rejects an empty/missing file and a non-object payload', () => {
    expect(MeetingExtractionQuerySchema.safeParse({ file: '' }).success).toBe(false)
    expect(MeetingExtractionQuerySchema.safeParse({}).success).toBe(false)
    expect(MeetingExtractionQuerySchema.safeParse(null).success).toBe(false)
    expect(MeetingExtractionQuerySchema.safeParse({ file: 42 }).success).toBe(false)
  })
})

describe('AttentionItemSchema / BrainAttentionResultSchema (brain:attention)', () => {
  const valid = {
    kind: 'ambiguous',
    entityKind: 'account',
    id: 'acme-corp',
    label: 'Acme Corp',
    detail: 'Sector: "banking" is unconfirmed (AMBIGUOUS)'
  }

  it('accepts every item kind and wraps into the {items} result', () => {
    for (const kind of ['lint', 'ambiguous', 'contradicted_pin']) {
      expect(AttentionItemSchema.safeParse({ ...valid, kind }).success).toBe(true)
    }
    expect(BrainAttentionResultSchema.safeParse({ items: [valid] }).success).toBe(true)
    expect(BrainAttentionResultSchema.safeParse({ items: [] }).success).toBe(true)
  })

  it('rejects an unknown kind, a bad entityKind, an empty id, and a missing items array', () => {
    expect(AttentionItemSchema.safeParse({ ...valid, kind: 'other' }).success).toBe(false)
    expect(AttentionItemSchema.safeParse({ ...valid, entityKind: 'meeting' }).success).toBe(false)
    expect(AttentionItemSchema.safeParse({ ...valid, id: '' }).success).toBe(false)
    expect(BrainAttentionResultSchema.safeParse({}).success).toBe(false)
  })
})

// alsoFixAsr composition (reviewer IMPORTANT 3): a pair that fails element validation must be SKIPPED
// (rename still applied) — never appended, because store.ts's validKeysOnly drops the whole
// asrCorrections array when any one element fails, silently wiping every existing correction.
describe('appendAsrCorrection (alsoFixAsr composition)', () => {
  it('appends a valid pair in the exact consumer shape (commitLine correctionsRef: {from, to})', () => {
    const r = appendAsrCorrection([{ from: 'Old Co', to: 'New Co' }], 'Acme Corp', 'Acme')
    expect(r.kind).toBe('append')
    if (r.kind === 'append') {
      expect(r.pairs).toEqual([
        { from: 'Old Co', to: 'New Co' },
        { from: 'Acme Corp', to: 'Acme' }
      ])
      // The composed array must round-trip whole-array settings validation.
      expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: r.pairs }).success).toBe(true)
    }
  })

  it('skips (with a reason) a name over the 80-char cap instead of poisoning whole-array validation', () => {
    const longName = 'X'.repeat(81)
    const r = appendAsrCorrection([], longName, 'Acme')
    expect(r.kind).toBe('skipped')
    if (r.kind === 'skipped') expect(r.reason).toContain('80')
    // The failure mode the pre-validation prevents: one bad element fails the ENTIRE array parse,
    // which is exactly what store.ts's validKeysOnly would then drop wholesale.
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: [{ from: longName, to: 'Acme' }] }).success
    ).toBe(false)
  })

  it('no-ops on a duplicate pair and enforces the 100-entry cap on append', () => {
    const pair = { from: 'Acme Corp', to: 'Acme' }
    expect(appendAsrCorrection([pair], 'Acme Corp', 'Acme')).toEqual({ kind: 'noop' })

    const full = Array.from({ length: 100 }, (_, i) => ({ from: `word-${i}`, to: `fix-${i}` }))
    const r = appendAsrCorrection(full, 'Acme Corp', 'Acme')
    expect(r.kind).toBe('append')
    if (r.kind === 'append') {
      expect(r.pairs).toHaveLength(100) // oldest dropped, cap respected
      expect(r.pairs[99]).toEqual(pair)
      expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, asrCorrections: r.pairs }).success).toBe(true)
    }
  })
})

describe('DEFAULT_SHORTCUTS scroll defaults', () => {
  const REAL_PLATFORM = process.platform

  afterEach(() => {
    setPlatform(REAL_PLATFORM)
    vi.resetModules()
  })

  it('avoids the Ctrl+Alt+Arrow Intel display-rotation collision on Windows', async () => {
    setPlatform('win32')
    vi.resetModules() // DEFAULT_SHORTCUTS is computed at module load — needs a fresh import to see the flip
    const { DEFAULT_SHORTCUTS } = await import('./ipc')
    expect(DEFAULT_SHORTCUTS['scroll-up']).not.toContain('Alt+Up')
    expect(DEFAULT_SHORTCUTS['scroll-up']).not.toMatch(/Control.*Alt|Alt.*Control/)
  })

  it('keeps CommandOrControl+Alt+Arrow on mac', async () => {
    setPlatform('darwin')
    vi.resetModules()
    const { DEFAULT_SHORTCUTS } = await import('./ipc')
    expect(DEFAULT_SHORTCUTS['scroll-up']).toBe('CommandOrControl+Alt+Up')
    expect(DEFAULT_SHORTCUTS['scroll-down']).toBe('CommandOrControl+Alt+Down')
    expect(DEFAULT_SHORTCUTS['scroll-left']).toBe('CommandOrControl+Alt+Left')
    expect(DEFAULT_SHORTCUTS['scroll-right']).toBe('CommandOrControl+Alt+Right')
  })
})

describe('local AI IPC channel constants', () => {
  it('defines the six exact new channel names without collisions', () => {
    expect(IPC.localAiStatus).toBe('local-ai:status')
    expect(IPC.localTranscriptBegin).toBe('local-ai:transcript:begin')
    expect(IPC.localTranscriptAppend).toBe('local-ai:transcript:append')
    expect(IPC.localTranscriptResync).toBe('local-ai:transcript:resync')
    expect(IPC.localTranscriptEnd).toBe('local-ai:transcript:end')
    expect(IPC.brainAnalyze).toBe('brain:analyze')
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('StreamMetaSchema migration guard', () => {
  it('still parses the current provider-shaped metadata before Task 6', () => {
    const current = { id: 'ask-1', provider: 'anthropic' as const, tier: 'base' as const }
    const parsed = StreamMetaSchema.safeParse(current)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual(current)
  })

  it('still requires a provider and valid provider tier', () => {
    expect(StreamMetaSchema.safeParse({ id: 'ask-1', tier: 'base' }).success).toBe(false)
    expect(StreamMetaSchema.safeParse({ id: 'ask-1', provider: 'anthropic', tier: 'fast' }).success).toBe(false)
  })
})
