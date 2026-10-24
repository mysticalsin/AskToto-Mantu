import { describe, expect, it } from 'vitest'
import { DATA_RIGHTS_IPC } from '../shared/data-rights'
import { createDataRightsPreloadApi } from './data-rights'

describe('data rights preload bridge (G82)', () => {
  it('malformed reply becomes a content-free refusal', async () => {
    const api = createDataRightsPreloadApi({
      invoke: async () => ({ ok: true, receipt: { receiptId: 'x', path: '/Users/someone/meetings' } })
    } as never)
    expect(await api.dataRights.confirm('a'.repeat(32), 'b'.repeat(64))).toEqual({ ok: false, reason: 'unavailable' })
    expect(await api.dataRights.preview()).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('a thrown invoke is a refusal, and the confirm payload carries only the proposal id and hash', async () => {
    const seen: Array<[string, unknown]> = []
    const api = createDataRightsPreloadApi({
      invoke: async (channel: string, payload: unknown) => {
        seen.push([channel, payload])
        throw new Error('/Users/someone/secret')
      }
    } as never)
    expect(await api.dataRights.confirm('a'.repeat(32), 'b'.repeat(64))).toEqual({ ok: false, reason: 'unavailable' })
    expect(seen).toEqual([[DATA_RIGHTS_IPC.confirm, { proposalId: 'a'.repeat(32), previewHash: 'b'.repeat(64) }]])
  })

  it('passes a well-formed refusal through', async () => {
    const api = createDataRightsPreloadApi({
      invoke: async () => ({ ok: false, reason: 'meeting-recording' })
    } as never)
    expect(await api.dataRights.preview()).toEqual({ ok: false, reason: 'meeting-recording' })
  })
})
