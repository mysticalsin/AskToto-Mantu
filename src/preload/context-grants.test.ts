import { describe, expect, it, vi } from 'vitest'
import { createContextGrantsPreloadApi } from './context-grants'

describe('context grants preload API', () => {
  it('maps each call onto its own channel with a strict payload', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    const api = createContextGrantsPreloadApi({ invoke } as never)
    await api.requestContextSnapshot('typed-screen-intent')
    await api.grantWholeDocument('s1', 'capture-button')
    await api.revokeDocumentGrant('g1')
    await api.deleteContextSnapshot('s1')
    await api.getHeldContext()
    await api.getTurnContextManifest('t1')
    expect(invoke.mock.calls).toEqual([
      ['context:snapshotRequest', { gesture: 'typed-screen-intent', kind: 'screen' }],
      ['context:grantDocument', { snapshotId: 's1', gesture: 'capture-button' }],
      ['context:revokeGrant', { grantId: 'g1' }],
      ['context:snapshotDelete', { snapshotId: 's1' }],
      ['context:held'],
      ['context:turnManifest', { turnId: 't1' }]
    ])
  })

  it('exposes no ambient capture entry point', () => {
    const api = createContextGrantsPreloadApi({ invoke: vi.fn() } as never)
    expect(Object.keys(api).sort()).toEqual([
      'deleteContextSnapshot',
      'getHeldContext',
      'getTurnContextManifest',
      'grantWholeDocument',
      'requestContextSnapshot',
      'revokeDocumentGrant'
    ])
  })
})
