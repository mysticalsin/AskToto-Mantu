import { describe, expect, it } from 'vitest'
import { UNAVAILABLE_RECORD } from '@shared/meeting-record'
import { createMeetingRecordService, removeMeetingRecordEdits } from './index'
import { sidecarPath, type RecordEditsDeps } from './record-edits-store'
import { LUMEN_LINES, LUMEN_RECAP } from './__fixtures__/synthetic-meetings'

const FOLDER = '/synthetic/meetings'

function setup(readOk = true) {
  const files = new Map<string, string>()
  const store: RecordEditsDeps = {
    read: async (p) => (files.has(p) ? Buffer.from(files.get(p)!) : null),
    decode: (b) => b.toString('utf8'),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p)
  }
  const service = createMeetingRecordService({
    readMeeting: async () =>
      readOk ? { ok: true, recap: LUMEN_RECAP, lines: LUMEN_LINES, startedAt: 7 } : { ok: false },
    folder: () => FOLDER,
    encrypt: () => false,
    store,
    serialize: (_p, work) => work()
  })
  return { files, store, service }
}

describe('meeting record service', () => {
  it('rejects a file that is not a meeting basename', async () => {
    expect(await setup().service.get('notes.txt')).toEqual(UNAVAILABLE_RECORD)
    expect(await setup().service.edit('../x', { file: '../x', op: 'delete', id: 'a' })).toBe(false)
  })

  it('an unreadable meeting is unavailable and takes no edits', async () => {
    const { service, files } = setup(false)
    expect(await service.get('a.md')).toEqual(UNAVAILABLE_RECORD)
    expect(await service.edit('a.md', { file: 'a.md', op: 'add', kind: 'decision', text: 'x' })).toBe(false)
    expect(files.size).toBe(0)
  })

  it('an edit survives a rebuild and deleting the meeting removes the sidecar', async () => {
    const { service, files, store } = setup()
    const first = await service.get('a.md')
    const target = first.items.find((i) => i.kind === 'decision')!
    expect(await service.edit('a.md', { file: 'a.md', op: 'set', id: target.id, text: 'Launch Lumen later' })).toBe(
      true
    )
    const again = await service.get('a.md')
    expect(again.items.find((i) => i.id === target.id)).toMatchObject({ source: 'user', text: 'Launch Lumen later' })
    expect(again.startedAt).toBe(7)
    expect(files.has(sidecarPath(FOLDER, 'a.md'))).toBe(true)
    await removeMeetingRecordEdits(store, FOLDER, 'a.md')
    expect(files.size).toBe(0)
  })

  it('edits removal failure does not throw', async () => {
    const { store } = setup()
    const failing: RecordEditsDeps = {
      ...store,
      remove: async () => {
        throw new Error('EBUSY')
      }
    }
    await expect(removeMeetingRecordEdits(failing, FOLDER, 'a.md')).resolves.toBeUndefined()
  })
})
