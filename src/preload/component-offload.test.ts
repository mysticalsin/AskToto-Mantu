import { describe, expect, it, vi } from 'vitest'
import { COMPONENT_OFFLOAD_IPC } from '../shared/component-offload'
import { createComponentOffloadPreloadApi } from './component-offload'

const planId = '11111111-1111-4111-8111-111111111111'

describe('component offload preload API (G87)', () => {
  it('exposes preview, confirm and receipts on the declared channels only', async () => {
    const receipt = {
      receiptId: '22222222-2222-4222-8222-222222222222',
      componentId: 'whisper',
      label: 'Whisper (offline speech)',
      removedAt: new Date(0).toISOString(),
      bytesFreed: 10,
      freeBytesBefore: null,
      freeBytesAfter: null,
      verifiedAbsent: true,
      sessionDataTouched: false
    }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === COMPONENT_OFFLOAD_IPC.preview)
        return {
          ok: true,
          plan: {
            planId,
            componentId: 'whisper',
            label: 'Whisper (offline speech)',
            removableBytes: 10,
            degradesTo: 'cloud-speech',
            expiresAt: new Date(1000).toISOString()
          }
        }
      if (channel === COMPONENT_OFFLOAD_IPC.confirm) return { ok: true, receipt }
      return [receipt]
    })
    const api = createComponentOffloadPreloadApi({ invoke } as never)
    expect((await api.componentOffloadPreview('whisper')).ok).toBe(true)
    expect((await api.componentOffloadConfirm(planId)).ok).toBe(true)
    expect(await api.componentOffloadReceipts()).toEqual([receipt])
    expect(invoke.mock.calls).toEqual([
      [COMPONENT_OFFLOAD_IPC.preview, { componentId: 'whisper' }],
      [COMPONENT_OFFLOAD_IPC.confirm, { planId }],
      [COMPONENT_OFFLOAD_IPC.receipts]
    ])
    expect(Object.keys(api).sort()).toEqual([
      'componentOffloadConfirm',
      'componentOffloadPreview',
      'componentOffloadReceipts'
    ])
  })

  it('rejects a malformed response and hides transport errors', async () => {
    const bad = createComponentOffloadPreloadApi({ invoke: vi.fn(async () => ({ ok: true })) } as never)
    await expect(bad.componentOffloadPreview('whisper')).rejects.toThrow(/^Invalid component offload response$/)
    const broken = createComponentOffloadPreloadApi({
      invoke: vi.fn().mockRejectedValue(new Error('/Users/someone/secret'))
    } as never)
    await expect(broken.componentOffloadReceipts()).rejects.toThrow(/^Invalid component offload response$/)
  })
})
