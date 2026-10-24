import { describe, expect, it, vi } from 'vitest'
import { MEETING_RECORD_IPC, UNAVAILABLE_RECORD } from '../shared/meeting-record'
import { createMeetingRecordPreloadApi } from './meeting-record'

describe('meeting record preload bridge', () => {
  it('malformed reply → content-free fallback', async () => {
    const api = createMeetingRecordPreloadApi({ invoke: vi.fn(async () => ({ status: 'ok', items: 'nope' })) })
    expect(await api.meetingRecord.get('a.md')).toEqual(UNAVAILABLE_RECORD)
    expect(await api.meetingRecord.edit({ file: 'a.md', op: 'delete', id: 'x' })).toEqual({ ok: false })
  })

  it('invoke throw → fallback', async () => {
    const api = createMeetingRecordPreloadApi({
      invoke: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    expect(await api.meetingRecord.get('a.md')).toEqual(UNAVAILABLE_RECORD)
    expect(await api.meetingRecord.edit({ file: 'a.md', op: 'delete', id: 'x' })).toEqual({ ok: false })
  })

  it('sends only the file name for get', async () => {
    const invoke = vi.fn(async () => UNAVAILABLE_RECORD)
    await createMeetingRecordPreloadApi({ invoke }).meetingRecord.get('a.md')
    expect(invoke).toHaveBeenCalledWith(MEETING_RECORD_IPC.get, { file: 'a.md' })
  })
})
