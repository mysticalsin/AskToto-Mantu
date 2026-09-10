import { describe, expect, it, vi } from 'vitest'
import { provisionLocalModel } from './local-model-provisioning'

describe('optional local-model provisioning', () => {
  it('does not fetch disabled local AI on automatic boot or setup checks', async () => {
    const ensure = vi.fn(async () => true)
    expect(await provisionLocalModel({ enabled: false, modelId: 'qwen3.5-4b' }, null, ensure)).toBe(false)
    expect(ensure).not.toHaveBeenCalled()
  })

  it.each(['automatic', 'explicit'] as const)('respects organization restrictions for %s requests', async (trigger) => {
    const ensure = vi.fn(async () => true)
    expect(await provisionLocalModel({ enabled: true, modelId: 'qwen3.5-4b' }, ['cloudflare'], ensure, trigger)).toBe(false)
    expect(ensure).not.toHaveBeenCalled()
  })

  it.each(['qwen3.5-0.8b', 'qwen3.5-4b'])('keeps the selected %s model on an automatic request', async (modelId) => {
    const ensure = vi.fn(async () => true)
    expect(await provisionLocalModel({ enabled: true, modelId }, ['local'], ensure)).toBe(true)
    expect(ensure).toHaveBeenCalledExactlyOnceWith(modelId)
  })

  it('allows an explicit download without enabling local inference', async () => {
    const local = { enabled: false, modelId: 'qwen3.5-0.8b' }
    const ensure = vi.fn(async () => true)
    expect(await provisionLocalModel(local, null, ensure, 'explicit')).toBe(true)
    expect(ensure).toHaveBeenCalledExactlyOnceWith('qwen3.5-0.8b')
    expect(local.enabled).toBe(false)
  })

  it('preserves a failed provisioning verdict', async () => {
    expect(await provisionLocalModel({ enabled: true, modelId: 'qwen3.5-4b' }, null, async () => false)).toBe(false)
  })

  it('propagates an unexpected downloader failure to its caller', async () => {
    await expect(provisionLocalModel({ enabled: true, modelId: 'qwen3.5-4b' }, null, async () => {
      throw new Error('synthetic disk failure')
    })).rejects.toThrow('synthetic disk failure')
  })
})
