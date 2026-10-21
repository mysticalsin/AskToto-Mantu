import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MEETING_JOURNAL_ID, purgeMeetingJournalDirectory, resolveMeetingJournalRoot } from './meeting-journal-purge'

const ID = 'aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb'

let base: string
let userData: string
let outside: string

function seed(id: string): string {
  const dir = join(userData, 'meeting-journal', id)
  mkdirSync(join(dir, 'records'), { recursive: true })
  writeFileSync(join(dir, 'key.v1'), '{"v":1}')
  writeFileSync(join(dir, 'records', 'manifest.v1'), 'm')
  writeFileSync(join(dir, 'records', 'record-x.v1'), 'r')
  return dir
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'metis-journal-purge-')))
  userData = join(base, 'userData')
  outside = join(base, 'outside')
  mkdirSync(userData, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'precious.md'), 'keep me')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('purgeMeetingJournalDirectory', () => {
  it('removes one journal directory with its records and wrapped key, and only that one', async () => {
    const dir = seed(ID)
    const other = seed(OTHER)
    await expect(purgeMeetingJournalDirectory(userData, ID)).resolves.toEqual({ status: 'purged', removedFiles: 3 })
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(join(userData, 'meeting-journal'))).toBe(true)
  })

  it('is idempotent and reports an absent journal or an absent journals root', async () => {
    await expect(purgeMeetingJournalDirectory(userData, ID)).resolves.toEqual({ status: 'absent' })
    seed(ID)
    await purgeMeetingJournalDirectory(userData, ID)
    await expect(purgeMeetingJournalDirectory(userData, ID)).resolves.toEqual({ status: 'absent' })
  })

  it.each(['', '..', '../x', ID + '/..', 'not-a-uuid', ID.slice(1)])('refuses the invalid id %j', async (bad) => {
    seed(ID)
    await expect(purgeMeetingJournalDirectory(userData, bad)).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-id'
    })
    expect(existsSync(join(userData, 'meeting-journal', ID))).toBe(true)
  })

  it('refuses a journal directory that is a symbolic link and never touches its target', async () => {
    mkdirSync(join(userData, 'meeting-journal'), { recursive: true })
    symlinkSync(outside, join(userData, 'meeting-journal', ID), 'dir')
    await expect(purgeMeetingJournalDirectory(userData, ID)).resolves.toEqual({
      status: 'refused',
      reason: 'unsafe-path'
    })
    expect(readFileSync(join(outside, 'precious.md'), 'utf8')).toBe('keep me')
  })

  it('refuses a journals root that is a symbolic link out of userData and never touches its target', async () => {
    mkdirSync(join(outside, ID), { recursive: true })
    writeFileSync(join(outside, ID, 'precious.md'), 'keep me too')
    symlinkSync(outside, join(userData, 'meeting-journal'), 'dir')
    await expect(resolveMeetingJournalRoot(userData)).resolves.toBe('unsafe')
    await expect(purgeMeetingJournalDirectory(userData, ID)).resolves.toEqual({
      status: 'refused',
      reason: 'unsafe-path'
    })
    expect(readFileSync(join(outside, ID, 'precious.md'), 'utf8')).toBe('keep me too')
  })

  it('refuses a userData whose journals root is a regular file', async () => {
    writeFileSync(join(userData, 'meeting-journal'), 'not a directory')
    await expect(purgeMeetingJournalDirectory(userData, ID)).resolves.toEqual({
      status: 'refused',
      reason: 'unsafe-path'
    })
  })

  it('removes a symbolic link planted inside a journal as a link, never following it', async () => {
    const dir = seed(ID)
    symlinkSync(outside, join(dir, 'records', 'escape'), 'dir')
    symlinkSync(join(outside, 'precious.md'), join(dir, 'records', 'escape-file'))
    const result = await purgeMeetingJournalDirectory(userData, ID)
    expect(result.status).toBe('purged')
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(outside, 'precious.md'), 'utf8')).toBe('keep me')
  })

  it('refuses a journal id that is a regular file', async () => {
    mkdirSync(join(userData, 'meeting-journal'), { recursive: true })
    writeFileSync(join(userData, 'meeting-journal', ID), 'file')
    await expect(purgeMeetingJournalDirectory(userData, ID)).resolves.toEqual({
      status: 'refused',
      reason: 'unsafe-path'
    })
  })

  it('accepts the same id shape the journal format does', () => {
    expect(MEETING_JOURNAL_ID.test(ID)).toBe(true)
    expect(MEETING_JOURNAL_ID.test('aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa')).toBe(false)
  })
})
