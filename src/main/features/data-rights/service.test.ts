import { describe, expect, it } from 'vitest'
import { DATA_RIGHTS_PROPOSAL_TTL_MS, type ErasureReceipt } from '@shared/data-rights'
import { createDataRightsService, type DataRightsServiceDeps } from './service'

const RECEIPT: ErasureReceipt = {
  receiptId: 'c'.repeat(32),
  startedAt: 1,
  finishedAt: 2,
  stores: [{ store: 'meetings', outcome: 'erased', count: 2 }],
  exceptions: [],
  failed: 0
}

function harness(over: Partial<DataRightsServiceDeps> = {}) {
  const state = {
    scope: { partitionId: 'a1'.repeat(12) } as { partitionId: string } | null,
    now: 1_000,
    recording: false
  }
  const log = { erased: 0, receipts: [] as ErasureReceipt[] }
  let n = 0
  const service = createDataRightsService({
    scope: () => state.scope,
    now: () => state.now,
    newId: () => (n++).toString(16).padStart(32, '0'),
    hasOpenSession: () => state.recording,
    counts: async () => ({ meetings: 2 }),
    erase: async () => {
      log.erased += 1
      return RECEIPT
    },
    appendReceipt: async (receipt) => void log.receipts.push(receipt),
    readLastReceipt: async () => log.receipts.at(-1) ?? null,
    exportData: async () => ({ ok: true, records: 0, skipped: 0 }),
    ...over
  })
  return { service, state, log }
}

describe('data rights service (G82)', () => {
  it('confirm without propose refused', async () => {
    const { service, log } = harness()
    expect(await service.confirm({ proposalId: 'd'.repeat(32), previewHash: 'e'.repeat(64) })).toEqual({
      ok: false,
      reason: 'unknown-proposal'
    })
    expect(log.erased).toBe(0)
  })

  it('preview-mismatch', async () => {
    const { service, log } = harness()
    const p = await service.preview()
    if (!p.ok) throw new Error('preview refused')
    expect(await service.confirm({ proposalId: p.proposalId, previewHash: 'f'.repeat(64) })).toEqual({
      ok: false,
      reason: 'preview-mismatch'
    })
    expect(log.erased).toBe(0)
  })

  it('previews labels and counts and erases once on a matching confirm, logging the receipt', async () => {
    const { service, log } = harness()
    const p = await service.preview()
    if (!p.ok) throw new Error('preview refused')
    expect(p.items.find((i) => i.store === 'meetings')).toMatchObject({ count: 2, policy: 'delete' })
    expect(JSON.stringify(p)).not.toMatch(/\.md|\/Users/)
    const done = await service.confirm({ proposalId: p.proposalId, previewHash: p.previewHash })
    expect(done).toEqual({ ok: true, receipt: RECEIPT })
    expect(log.receipts).toEqual([RECEIPT])
    expect(await service.confirm({ proposalId: p.proposalId, previewHash: p.previewHash })).toMatchObject({
      reason: 'unknown-proposal'
    })
    expect(await service.lastReceipt()).toEqual({ ok: true, receipt: RECEIPT })
  })

  it('expired', async () => {
    const { service, state, log } = harness()
    const p = await service.preview()
    if (!p.ok) throw new Error('preview refused')
    state.now += DATA_RIGHTS_PROPOSAL_TTL_MS
    expect(await service.confirm({ proposalId: p.proposalId, previewHash: p.previewHash })).toEqual({
      ok: false,
      reason: 'expired'
    })
    expect(log.erased).toBe(0)
  })

  it('meeting-recording at propose and confirm', async () => {
    const { service, state, log } = harness()
    state.recording = true
    expect(await service.preview()).toEqual({ ok: false, reason: 'meeting-recording' })
    state.recording = false
    const p = await service.preview()
    if (!p.ok) throw new Error('preview refused')
    state.recording = true
    expect(await service.confirm({ proposalId: p.proposalId, previewHash: p.previewHash })).toEqual({
      ok: false,
      reason: 'meeting-recording'
    })
    expect(log.erased).toBe(0)
  })

  it('owner revoke drops proposal', async () => {
    const { service, log } = harness()
    const p = await service.preview()
    if (!p.ok) throw new Error('preview refused')
    service.onOwnerChange()
    expect(await service.confirm({ proposalId: p.proposalId, previewHash: p.previewHash })).toMatchObject({
      reason: 'unknown-proposal'
    })
    expect(log.erased).toBe(0)
  })

  it('a partition change between propose and confirm is refused', async () => {
    const { service, state, log } = harness()
    const p = await service.preview()
    if (!p.ok) throw new Error('preview refused')
    state.scope = { partitionId: 'b2'.repeat(12) }
    expect(await service.confirm({ proposalId: p.proposalId, previewHash: p.previewHash })).toMatchObject({
      reason: 'unknown-proposal'
    })
    expect(log.erased).toBe(0)
  })

  it('signed out refused everywhere', async () => {
    const { service, state } = harness()
    state.scope = null
    expect(await service.preview()).toEqual({ ok: false, reason: 'signed-out' })
    expect(await service.lastReceipt()).toEqual({ ok: false, reason: 'signed-out' })
    expect(await service.exportData()).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('concurrent confirm busy', async () => {
    let release: () => void = () => undefined
    const { service } = harness({
      erase: () =>
        new Promise<ErasureReceipt>((resolve) => {
          release = () => resolve(RECEIPT)
        })
    })
    const p = await service.preview()
    if (!p.ok) throw new Error('preview refused')
    const first = service.confirm({ proposalId: p.proposalId, previewHash: p.previewHash })
    const p2 = await service.preview()
    if (!p2.ok) throw new Error('preview refused')
    expect(await service.confirm({ proposalId: p2.proposalId, previewHash: p2.previewHash })).toEqual({
      ok: false,
      reason: 'busy'
    })
    release()
    expect(await first).toMatchObject({ ok: true })
  })
})
