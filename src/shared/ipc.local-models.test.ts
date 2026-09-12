import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, IPC, LocalModelSummarySchema, SettingsSchema } from './ipc'

describe('bundled local-model IPC contract', () => {
  const valid = {
    id: 'qwen3.5-0.8b',
    label: 'Qwen3.5 0.8B',
    minTotalRamGB: 8,
    ready: true,
    unavailableReason: null,
    downloadProgress: 0
  }

  it('exposes the list channel plus start/retry, and no cancel/delete/progress push', () => {
    expect(IPC.localModelsList).toBe('localModels:list')
    expect(IPC.localModelsEnsure).toBe('localModels:ensure')
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

  it('distinguishes installed-model repair from optional download failure without exposing paths', () => {
    expect(LocalModelSummarySchema.parse({ ...valid, source: 'bundled' }).source).toBe('bundled')
    expect(LocalModelSummarySchema.parse({ ...valid, source: 'download' }).source).toBe('download')
    expect(LocalModelSummarySchema.safeParse({ ...valid, source: 'other' }).success).toBe(false)
    const broken = { ...valid, source: 'bundled', ready: false, unavailableReason: 'invalid-bundle', downloadError: 'Repair or reinstall Métis.' }
    expect(LocalModelSummarySchema.safeParse(broken).success).toBe(true)
    expect(LocalModelSummarySchema.safeParse({ ...broken, resourcesPath: '/private/app/resources' }).success).toBe(false)
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

  it('MQA-187/191 — carries the first-run download state, so "not ready" is never just "missing files"', () => {
    // The weights are fetched on first run, so the renderer must be able to tell an in-flight or blocked
    // download apart from a machine that will never be eligible. Reinstalling fixes none of them.
    for (const reason of ['downloading', 'download-failed', 'not-downloaded', 'insufficient-disk']) {
      expect(LocalModelSummarySchema.safeParse({ ...valid, ready: false, unavailableReason: reason }).success).toBe(true)
    }
    // 'missing-files' framed a normal first-run state as a damaged install; it is gone, not aliased.
    expect(LocalModelSummarySchema.safeParse({ ...valid, unavailableReason: 'missing-files' }).success).toBe(false)
    expect(LocalModelSummarySchema.safeParse({ ...valid, downloadProgress: 0.5 }).success).toBe(true)
    expect(LocalModelSummarySchema.safeParse({ ...valid, downloadProgress: 1.5 }).success).toBe(false)
    const { downloadProgress: _p, ...withoutProgress } = valid
    expect(LocalModelSummarySchema.safeParse(withoutProgress).success).toBe(false)
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
      fallback: false
    })
  })

  it('defaults Local AI to off for routing: Cloudflare / API keys stay primary until the user opts in', () => {
    // Weights download whenever the app opens (separate from this flag). enabled:false means no
    // on-device routing and no sidecar warm until the user turns Local on. useFor must stay false —
    // with sparse settings persistence, a true default would silently reroute upgrading cloud users
    // onto the small on-device model (local-first preemption).
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS)
    expect(parsed.localLlm.enabled).toBe(false)
    expect(parsed.localLlm.useFor).toEqual({ suggest: false, summary: false, vision: false })
    expect(parsed.localLlm.fallback).toBe(false)
    // An absent localLlm key (a settings.json from a user who never touched Local AI) gets the same shape.
    const { localLlm: _omitted, ...withoutLocal } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(withoutLocal).localLlm).toEqual({
      enabled: false,
      modelId: 'qwen3.5-0.8b',
      useFor: { suggest: false, summary: false, vision: false },
      fallback: false
    })
  })

  it('keeps a persisted pre-rename localLlm object parseable (indexFallback key is dropped, fallback defaults off)', () => {
    const parsed = SettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      localLlm: {
        enabled: false,
        modelId: 'qwen3.5-0.8b',
        useFor: { suggest: true, summary: true, vision: true },
        indexFallback: true
      }
    })
    expect(parsed.localLlm.enabled).toBe(false) // explicit user choice survives the default flip
    expect(parsed.localLlm.fallback).toBe(false)
    expect(parsed.localLlm).not.toHaveProperty('indexFallback')
  })

  it('rejects unknown model ids instead of persisting an unusable runtime target', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      localLlm: { ...DEFAULT_SETTINGS.localLlm, modelId: 'unknown-model' }
    })
    expect(parsed.success).toBe(false)
  })
})
