import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, IPC, LocalModelSummarySchema, SettingsSchema } from './ipc'

describe('bundled local-model IPC contract', () => {
  const valid = {
    id: 'qwen3.5-0.8b',
    label: 'Qwen3.5 0.8B',
    minTotalRamGB: 8,
    ready: true,
    unavailableReason: null
  }

  it('exposes only the read-only model list channel', () => {
    expect(IPC.localModelsList).toBe('localModels:list')
    expect(IPC).not.toHaveProperty('localModelsDownload')
    expect(IPC).not.toHaveProperty('localModelsCancel')
    expect(IPC).not.toHaveProperty('localModelsDelete')
    expect(IPC).not.toHaveProperty('localModelsProgress')
  })

  it('accepts renderer-safe readiness metadata and rejects leaked fields', () => {
    expect(LocalModelSummarySchema.safeParse(valid).success).toBe(true)
    expect(LocalModelSummarySchema.safeParse({ ...valid, path: '/private/model.gguf' }).success).toBe(false)
    expect(LocalModelSummarySchema.safeParse({ ...valid, port: 60657 }).success).toBe(false)
    expect(LocalModelSummarySchema.safeParse({ ...valid, apiKey: 'secret' }).success).toBe(false)
  })

  it('requires every readiness field with the correct type', () => {
    const { ready: _ready, ...withoutReady } = valid
    expect(LocalModelSummarySchema.safeParse(withoutReady).success).toBe(false)
    expect(LocalModelSummarySchema.safeParse({ ...valid, ready: 'yes' }).success).toBe(false)
    expect(
      LocalModelSummarySchema.safeParse({ ...valid, ready: false, unavailableReason: 'insufficient-ram' }).success
    ).toBe(true)
    expect(LocalModelSummarySchema.safeParse({ ...valid, unavailableReason: 'network' }).success).toBe(false)
    expect(LocalModelSummarySchema.safeParse(null).success).toBe(false)
  })
})

describe('bundled local-model settings migration', () => {
  it('defaults new settings to the only bundled model', () => {
    expect(DEFAULT_SETTINGS.localLlm.modelId).toBe('qwen3.5-0.8b')
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).localLlm.modelId).toBe('qwen3.5-0.8b')
  })

  it('migrates the removed Qwen3.5 2B id to 0.8B without disabling local AI', () => {
    const parsed = SettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-2b',
        useFor: { suggest: true, summary: false, vision: true }
      }
    })

    expect(parsed.localLlm).toEqual({
      enabled: true,
      modelId: 'qwen3.5-0.8b',
      useFor: { suggest: true, summary: false, vision: true },
      indexFallback: true
    })
  })

  it('rejects unknown model ids instead of persisting an unusable runtime target', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      localLlm: { ...DEFAULT_SETTINGS.localLlm, modelId: 'unknown-model' }
    })
    expect(parsed.success).toBe(false)
  })
})
