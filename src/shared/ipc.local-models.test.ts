import { describe, it, expect } from 'vitest'
import {
  LocalModelSummarySchema,
  LocalModelIdPayloadSchema,
  LocalModelProgressEventSchema
} from './ipc'

describe('LocalModelSummarySchema', () => {
  const valid = {
    id: 'qwen3.5-2b',
    label: 'Qwen3.5 2B — Default',
    minTotalRamGB: 8,
    ggufBytes: 1339752704,
    mmprojBytes: 668227264,
    totalBytes: 1339752704 + 668227264,
    downloaded: true
  }

  it('round-trips a valid manifest summary', () => {
    const r = LocalModelSummarySchema.safeParse(valid)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual(valid)
  })

  it('rejects a missing field', () => {
    const { downloaded: _downloaded, ...rest } = valid
    expect(LocalModelSummarySchema.safeParse(rest).success).toBe(false)
  })

  it('rejects wrong-typed fields (e.g. bytes as a string)', () => {
    expect(LocalModelSummarySchema.safeParse({ ...valid, ggufBytes: '1339752704' }).success).toBe(false)
  })

  it('rejects a non-object payload', () => {
    expect(LocalModelSummarySchema.safeParse(null).success).toBe(false)
    expect(LocalModelSummarySchema.safeParse('qwen3.5-2b').success).toBe(false)
    expect(LocalModelSummarySchema.safeParse(undefined).success).toBe(false)
  })

  // No-leak proof: this schema is .strict() specifically so a stray path/port/key field crossing this
  // boundary fails loud here, instead of a manual diff read being the only thing standing between
  // main-process internals (userData paths, the sidecar's ephemeral port, its per-session api key — see
  // local-models.ts/local-runtime.ts's doc comments on why those never leave main) and the renderer.
  it('rejects a payload carrying a leaked absolute path field', () => {
    const leaked = { ...valid, path: '/Users/tony/Library/Application Support/Métis/local-llm/models/qwen3.5-2b/model.gguf' }
    const r = LocalModelSummarySchema.safeParse(leaked)
    expect(r.success).toBe(false)
  })

  it('rejects a payload carrying a leaked port field', () => {
    const r = LocalModelSummarySchema.safeParse({ ...valid, port: 60657 })
    expect(r.success).toBe(false)
  })

  it('rejects a payload carrying a leaked api key field', () => {
    const r = LocalModelSummarySchema.safeParse({ ...valid, apiKey: 'a'.repeat(64) })
    expect(r.success).toBe(false)
  })
})

describe('LocalModelIdPayloadSchema', () => {
  it('accepts a valid model id', () => {
    expect(LocalModelIdPayloadSchema.safeParse({ modelId: 'qwen3.5-0.8b' }).success).toBe(true)
  })

  it('rejects an empty model id', () => {
    expect(LocalModelIdPayloadSchema.safeParse({ modelId: '' }).success).toBe(false)
  })

  it('rejects an oversized model id', () => {
    expect(LocalModelIdPayloadSchema.safeParse({ modelId: 'x'.repeat(101) }).success).toBe(false)
  })

  it('rejects a missing modelId field', () => {
    expect(LocalModelIdPayloadSchema.safeParse({}).success).toBe(false)
  })

  it('rejects a non-object payload (e.g. a compromised/malformed renderer message)', () => {
    expect(LocalModelIdPayloadSchema.safeParse(null).success).toBe(false)
    expect(LocalModelIdPayloadSchema.safeParse('qwen3.5-0.8b').success).toBe(false)
    expect(LocalModelIdPayloadSchema.safeParse(undefined).success).toBe(false)
  })
})

describe('LocalModelProgressEventSchema', () => {
  it('accepts a progress tick (gguf)', () => {
    const r = LocalModelProgressEventSchema.safeParse({
      modelId: 'qwen3.5-0.8b',
      file: 'gguf',
      received: 1024,
      total: 558772480
    })
    expect(r.success).toBe(true)
  })

  it('accepts a progress tick (mmproj)', () => {
    const r = LocalModelProgressEventSchema.safeParse({
      modelId: 'qwen3.5-0.8b',
      file: 'mmproj',
      received: 0,
      total: 204987232
    })
    expect(r.success).toBe(true)
  })

  it('accepts a terminal done event', () => {
    const r = LocalModelProgressEventSchema.safeParse({ modelId: 'qwen3.5-0.8b', done: true })
    expect(r.success).toBe(true)
  })

  it('accepts a terminal error event carrying the (already user-friendly) main-process message', () => {
    const r = LocalModelProgressEventSchema.safeParse({
      modelId: 'qwen3.5-0.8b',
      error: 'Download corrupted for qwen3.5-0.8b (gguf): checksum mismatch. Please retry the download.'
    })
    expect(r.success).toBe(true)
  })

  it('rejects an invalid file discriminant', () => {
    const r = LocalModelProgressEventSchema.safeParse({
      modelId: 'qwen3.5-0.8b',
      file: 'weights',
      received: 0,
      total: 100
    })
    expect(r.success).toBe(false)
  })

  it('rejects a tick with negative received bytes', () => {
    const r = LocalModelProgressEventSchema.safeParse({
      modelId: 'qwen3.5-0.8b',
      file: 'gguf',
      received: -1,
      total: 100
    })
    expect(r.success).toBe(false)
  })

  it('rejects a tick with a non-positive total', () => {
    const r = LocalModelProgressEventSchema.safeParse({
      modelId: 'qwen3.5-0.8b',
      file: 'gguf',
      received: 0,
      total: 0
    })
    expect(r.success).toBe(false)
  })

  it('rejects done: false (the only valid literal is true)', () => {
    const r = LocalModelProgressEventSchema.safeParse({ modelId: 'qwen3.5-0.8b', done: false })
    expect(r.success).toBe(false)
  })

  it('rejects an empty error string', () => {
    const r = LocalModelProgressEventSchema.safeParse({ modelId: 'qwen3.5-0.8b', error: '' })
    expect(r.success).toBe(false)
  })

  it('rejects a payload matching none of the three shapes', () => {
    expect(LocalModelProgressEventSchema.safeParse({ modelId: 'qwen3.5-0.8b' }).success).toBe(false)
    expect(LocalModelProgressEventSchema.safeParse({}).success).toBe(false)
    expect(LocalModelProgressEventSchema.safeParse(null).success).toBe(false)
  })

  // No-leak proof (see LocalModelSummarySchema's equivalent case above): the progress push channel is the
  // OTHER main→renderer surface this rock adds, so it gets the same .strict() guard.
  it('rejects a done event carrying a leaked extra field', () => {
    const r = LocalModelProgressEventSchema.safeParse({
      modelId: 'qwen3.5-0.8b',
      done: true,
      apiKey: 'leaked'
    })
    expect(r.success).toBe(false)
  })
})
