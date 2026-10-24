import { describe, expect, it } from 'vitest'
import { MEETING_RECORD_MAX_ADDED } from '@shared/meeting-record'
import {
  applyRecordEdit,
  readRecordEdits,
  removeRecordEdits,
  sidecarPath,
  type RecordEditsDeps
} from './record-edits-store'

function memoryDeps(): RecordEditsDeps & { files: Map<string, string>; encrypted: boolean[] } {
  const files = new Map<string, string>()
  const encrypted: boolean[] = []
  return {
    files,
    encrypted,
    read: async (p) => (files.has(p) ? Buffer.from(files.get(p)!) : null),
    decode: (b) => b.toString('utf8'),
    write: async (p, c, e) => {
      files.set(p, c)
      encrypted.push(e)
    },
    remove: async (p) => {
      files.delete(p)
    }
  }
}

const FOLDER = '/synthetic/meetings'
const NAME = 'secret-title.md'

describe('record edits store', () => {
  it('round-trips encrypted and plain', async () => {
    const deps = memoryDeps()
    expect(await applyRecordEdit(deps, FOLDER, NAME, { file: NAME, op: 'delete', id: 'decision:a' }, true)).toBe(true)
    expect(
      await applyRecordEdit(deps, FOLDER, NAME, { file: NAME, op: 'set', id: 'action:b', owner: 'Alex' }, false)
    ).toBe(true)
    expect(deps.encrypted).toEqual([true, false])
    const edits = await readRecordEdits(deps, FOLDER, NAME)
    expect(edits.edits['decision:a'].op).toBe('delete')
    expect(edits.edits['action:b']).toMatchObject({ op: 'set', owner: 'Alex' })
  })

  it('invalid JSON reads as empty', async () => {
    const deps = memoryDeps()
    deps.files.set(sidecarPath(FOLDER, NAME), '{not json')
    expect(await readRecordEdits(deps, FOLDER, NAME)).toEqual({ v: 1, edits: {}, added: [] })
    deps.files.set(sidecarPath(FOLDER, NAME), JSON.stringify({ v: 2 }))
    expect((await readRecordEdits(deps, FOLDER, NAME)).added).toEqual([])
  })

  it('file name is a hash of the basename', () => {
    const path = sidecarPath(FOLDER, NAME)
    expect(path).toMatch(/\/\.meeting-records\/[0-9a-f]{32}\.json$/)
    expect(path).not.toContain('secret')
  })

  it('enforces caps', async () => {
    const deps = memoryDeps()
    for (let i = 0; i < MEETING_RECORD_MAX_ADDED; i++) {
      await applyRecordEdit(deps, FOLDER, NAME, { file: NAME, op: 'add', kind: 'decision', text: `item ${i}` }, false)
    }
    expect(
      await applyRecordEdit(deps, FOLDER, NAME, { file: NAME, op: 'add', kind: 'decision', text: 'one more' }, false)
    ).toBe(false)
  })

  it('edits an added item in place', async () => {
    const deps = memoryDeps()
    await applyRecordEdit(deps, FOLDER, NAME, { file: NAME, op: 'add', kind: 'action', text: 'first' }, false)
    const id = (await readRecordEdits(deps, FOLDER, NAME)).added[0].id
    await applyRecordEdit(deps, FOLDER, NAME, { file: NAME, op: 'set', id, text: 'second' }, false)
    const edits = await readRecordEdits(deps, FOLDER, NAME)
    expect(edits.added[0].text).toBe('second')
    expect(edits.edits[id]).toBeUndefined()
  })

  it('remove deletes the sidecar', async () => {
    const deps = memoryDeps()
    await applyRecordEdit(deps, FOLDER, NAME, { file: NAME, op: 'delete', id: 'decision:a' }, false)
    await removeRecordEdits(deps, FOLDER, NAME)
    expect(deps.files.size).toBe(0)
  })
})
