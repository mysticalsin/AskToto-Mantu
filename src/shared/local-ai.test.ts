import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  FutureStreamMetaSchema,
  LocalTranscriptAckSchema,
  LocalTranscriptAppendSchema,
  LocalTranscriptBeginSchema,
  LocalTranscriptEndSchema,
  LocalTranscriptLineSchema,
  LocalTranscriptResyncSchema,
  LocalVisionEvidenceSchema,
  type LocalAiStatus,
  type LocalAiUnavailableReason,
  type LocalPriority,
  type LocalTask
} from './local-ai'

const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000'
const LINE_ID = '9c858901-8a57-4791-81fe-4c455b099bc9'
const SHA256 = 'a'.repeat(64)

const line = (overrides: Record<string, unknown> = {}) => ({
  id: LINE_ID,
  speaker: 'them',
  text: 'Hello',
  t: 1,
  ...overrides
})

const utf8Size = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length

describe('local AI type contracts', () => {
  it('keeps the exact task, priority, reason, and status unions', () => {
    expectTypeOf<LocalTask>().toEqualTypeOf<'suggest' | 'summary' | 'answer' | 'title' | 'classify' | 'cleanup'>()
    expectTypeOf<LocalPriority>().toEqualTypeOf<'visible' | 'automatic' | 'speculative' | 'background'>()
    expectTypeOf<LocalAiUnavailableReason>().toEqualTypeOf<
      'missing-model' | 'hash-mismatch' | 'native-addon' | 'load-failed' | 'unsupported-platform'
    >()
    expectTypeOf<LocalAiStatus>().toMatchTypeOf<{
      ready: boolean
      model: string
      modelSha256: string
      backend?: 'metal' | 'vulkan' | 'cpu'
      reason?: LocalAiUnavailableReason
    }>()
  })
})

describe('LocalTranscriptLineSchema', () => {
  it.each(['them', 'you', 'unknown'])('accepts the existing %s speaker', (speaker) => {
    expect(LocalTranscriptLineSchema.safeParse(line({ speaker })).success).toBe(true)
  })

  it('requires a UUID, nonnegative integer timestamp, 1..4000 text, and no extra keys', () => {
    expect(LocalTranscriptLineSchema.safeParse(line()).success).toBe(true)
    expect(LocalTranscriptLineSchema.safeParse(line({ id: 'bad' })).success).toBe(false)
    expect(LocalTranscriptLineSchema.safeParse(line({ t: -1 })).success).toBe(false)
    expect(LocalTranscriptLineSchema.safeParse(line({ t: 1.5 })).success).toBe(false)
    expect(LocalTranscriptLineSchema.safeParse(line({ text: '' })).success).toBe(false)
    expect(LocalTranscriptLineSchema.safeParse(line({ text: 'x'.repeat(4000) })).success).toBe(true)
    expect(LocalTranscriptLineSchema.safeParse(line({ text: 'x'.repeat(4001) })).success).toBe(false)
    expect(LocalTranscriptLineSchema.safeParse(line({ extra: true })).success).toBe(false)
  })
})

describe('local transcript IPC schemas', () => {
  it('begins at revision zero with the append line/UTF-8 caps', () => {
    expect(LocalTranscriptBeginSchema.safeParse({ sessionId: SESSION_ID, revision: 0, lines: [] }).success).toBe(true)
    expect(LocalTranscriptBeginSchema.safeParse({ sessionId: 'bad', revision: 0, lines: [] }).success).toBe(false)
    expect(LocalTranscriptBeginSchema.safeParse({ sessionId: SESSION_ID, revision: 1, lines: [] }).success).toBe(false)
    expect(
      LocalTranscriptBeginSchema.safeParse({
        sessionId: SESSION_ID,
        revision: 0,
        lines: Array.from({ length: 65 }, (_, t) => line({ t }))
      }).success
    ).toBe(false)
    const oversized = Array.from({ length: 20 }, (_, t) => line({ t, text: 'é'.repeat(4000) }))
    expect(utf8Size(oversized)).toBeGreaterThan(64 * 1024)
    expect(LocalTranscriptBeginSchema.safeParse({ sessionId: SESSION_ID, revision: 0, lines: oversized }).success).toBe(false)
  })

  it('applies the 64 KiB cap to the complete begin payload, not only its lines', () => {
    const lines = Array.from({ length: 17 }, (_, t) =>
      line({ t, text: 'x'.repeat(t === 16 ? 112 : 4000) })
    )
    const payload = { sessionId: SESSION_ID, revision: 0, lines }
    expect(utf8Size(lines)).toBeLessThanOrEqual(64 * 1024)
    expect(utf8Size(payload)).toBeGreaterThan(64 * 1024)
    expect(LocalTranscriptBeginSchema.safeParse(payload).success).toBe(false)
  })

  it('requires append revision = base + 1 and signed 32-bit revisions', () => {
    const valid = { sessionId: SESSION_ID, baseRevision: 0, revision: 1, lines: [line()] }
    expect(LocalTranscriptAppendSchema.safeParse(valid).success).toBe(true)
    expect(LocalTranscriptAppendSchema.safeParse({ ...valid, revision: 2 }).success).toBe(false)
    expect(LocalTranscriptAppendSchema.safeParse({ ...valid, baseRevision: -1, revision: 0 }).success).toBe(false)
    expect(LocalTranscriptAppendSchema.safeParse({ ...valid, baseRevision: 1.5, revision: 2.5 }).success).toBe(false)
    expect(
      LocalTranscriptAppendSchema.safeParse({ ...valid, baseRevision: 2_147_483_647, revision: 2_147_483_648 }).success
    ).toBe(false)
  })

  it('enforces append line and UTF-8 caps', () => {
    const sixtyFour = Array.from({ length: 64 }, (_, t) => line({ t }))
    expect(
      LocalTranscriptAppendSchema.safeParse({ sessionId: SESSION_ID, baseRevision: 0, revision: 1, lines: sixtyFour })
        .success
    ).toBe(true)
    expect(
      LocalTranscriptAppendSchema.safeParse({
        sessionId: SESSION_ID,
        baseRevision: 0,
        revision: 1,
        lines: [...sixtyFour, line({ t: 65 })]
      }).success
    ).toBe(false)
    const oversized = Array.from({ length: 20 }, (_, t) => line({ t, text: 'é'.repeat(4000) }))
    expect(
      LocalTranscriptAppendSchema.safeParse({ sessionId: SESSION_ID, baseRevision: 0, revision: 1, lines: oversized })
        .success
    ).toBe(false)
  })

  it('accepts the signed-32-bit resync boundary and rejects line/UTF-8 overflow', () => {
    expect(
      LocalTranscriptResyncSchema.safeParse({ sessionId: SESSION_ID, revision: 2_147_483_647, lines: [] }).success
    ).toBe(true)
    expect(LocalTranscriptResyncSchema.safeParse({ sessionId: SESSION_ID, revision: -1, lines: [] }).success).toBe(false)
    expect(
      LocalTranscriptResyncSchema.safeParse({
        sessionId: SESSION_ID,
        revision: 1,
        lines: Array.from({ length: 20_001 }, (_, t) => line({ t, text: 'x' }))
      }).success
    ).toBe(false)
    const oversized = Array.from({ length: 600 }, (_, t) => line({ t, text: 'é'.repeat(4000) }))
    expect(utf8Size(oversized)).toBeGreaterThan(2 * 1024 * 1024)
    expect(LocalTranscriptResyncSchema.safeParse({ sessionId: SESSION_ID, revision: 1, lines: oversized }).success).toBe(false)
  })

  it('keeps end and acknowledgement branches strict', () => {
    expect(LocalTranscriptEndSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(true)
    expect(LocalTranscriptEndSchema.safeParse({ sessionId: SESSION_ID, extra: true }).success).toBe(false)
    expect(LocalTranscriptAckSchema.safeParse({ revision: 5, resyncRequired: false }).success).toBe(true)
    expect(LocalTranscriptAckSchema.safeParse({ revision: 5, resyncRequired: true, expectedRevision: 6 }).success).toBe(true)
    expect(LocalTranscriptAckSchema.safeParse({ revision: 5, resyncRequired: true }).success).toBe(false)
    expect(LocalTranscriptAckSchema.safeParse({ revision: 5, resyncRequired: false, expectedRevision: 6 }).success).toBe(false)
  })
})

const visionEvidence = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  modelId: 'smolvlm-256m-instruct',
  modelSha256: SHA256,
  capturedAt: 1,
  backend: 'wasm',
  capabilities: ['caption'],
  caption: 'A roadmap',
  text: 'Q3',
  regions: [{ text: 'Q3', box: [0.1, 0.1, 0.5, 0.4] }],
  ...overrides
})

describe('LocalVisionEvidenceSchema', () => {
  it('accepts the bounded strict version-1 contract', () => {
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence()).success).toBe(true)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ version: 2 })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ modelId: '' })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ modelId: 'x'.repeat(129) })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ modelSha256: 'g'.repeat(64) })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ capturedAt: -1 })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ backend: 'cuda' })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ capabilities: [] })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ capabilities: ['caption', 'caption'] })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ caption: 'x'.repeat(8001) })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ text: 'x'.repeat(32001) })).success).toBe(false)
    expect(LocalVisionEvidenceSchema.safeParse(visionEvidence({ extra: true })).success).toBe(false)
  })

  it('enforces bounded, normalized, ordered regions and complete UTF-8 size', () => {
    expect(
      LocalVisionEvidenceSchema.safeParse(visionEvidence({ regions: [{ text: '', box: [0, 0, 1, 1] }] })).success
    ).toBe(false)
    expect(
      LocalVisionEvidenceSchema.safeParse(visionEvidence({ regions: [{ text: 'x', box: [0.8, 0, 0.2, 1] }] })).success
    ).toBe(false)
    expect(
      LocalVisionEvidenceSchema.safeParse(visionEvidence({
        regions: Array.from({ length: 201 }, () => ({ text: 'x', box: [0, 0, 1, 1] }))
      })).success
    ).toBe(false)
    const oversized = visionEvidence({
      regions: Array.from({ length: 200 }, () => ({ text: 'é'.repeat(400), box: [0, 0, 1, 1] }))
    })
    expect(utf8Size(oversized)).toBeGreaterThan(64 * 1024)
    expect(LocalVisionEvidenceSchema.safeParse(oversized).success).toBe(false)
  })
})

describe('FutureStreamMetaSchema', () => {
  it('accepts strict local and provider branches', () => {
    expect(
      FutureStreamMetaSchema.safeParse({ id: '1', executor: 'local', tier: 'base', model: 'qwen3-1.7b' }).success
    ).toBe(true)
    expect(
      FutureStreamMetaSchema.safeParse({ id: '1', executor: 'provider', tier: 'deep', provider: 'anthropic' }).success
    ).toBe(true)
    expect(
      FutureStreamMetaSchema.safeParse({ id: '1', executor: 'local', tier: 'think', model: 'qwen3-1.7b' }).success
    ).toBe(false)
    expect(
      FutureStreamMetaSchema.safeParse({ id: '1', executor: 'local', tier: 'base', model: 'qwen3', provider: 'openai' })
        .success
    ).toBe(false)
    expect(
      FutureStreamMetaSchema.safeParse({ id: '1', executor: 'provider', tier: 'base', provider: 'openai', model: 'x' })
        .success
    ).toBe(false)
  })
})
