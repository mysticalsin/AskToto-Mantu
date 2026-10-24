import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { eraseLegacyOwnedMeetings } from './legacy-meetings'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('legacy "AskToto Meetings" folder erasure (G82)', () => {
  it('deletes only the owner files, keeps bookkeeping, other files and symlinks, and reports counts', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-legacy-')))
    roots.push(root)
    const legacy = join(root, 'AskToto Meetings')
    mkdirSync(legacy)
    for (const name of [
      '2026-01-01_100000-a.md',
      '2026-01-02_100000-b.md',
      'notes-not-owned.md',
      'README.md',
      'index.md'
    ])
      writeFileSync(join(legacy, name), 'synthetic')
    symlinkSync(join(root, 'elsewhere.md'), join(legacy, '2026-01-03_100000-link.md'))

    const result = await eraseLegacyOwnedMeetings({
      folder: legacy,
      isOwned: async (_folder, file) => file.startsWith('2026-')
    })

    expect(result).toEqual({ deleted: 2, failed: 0 })
    expect(readdirSync(legacy).sort()).toEqual([
      '2026-01-03_100000-link.md',
      'README.md',
      'index.md',
      'notes-not-owned.md'
    ])
  })

  it('a missing folder is nothing to erase', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-legacy-')))
    roots.push(root)
    const folder = join(root, 'AskToto Meetings')
    expect(await eraseLegacyOwnedMeetings({ folder, isOwned: async () => true })).toEqual({ deleted: 0, failed: 0 })
    expect(existsSync(folder)).toBe(false)
  })

  it('an unreadable ownership check counts as failed and leaves the file', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-legacy-')))
    roots.push(root)
    const legacy = join(root, 'AskToto Meetings')
    mkdirSync(legacy)
    writeFileSync(join(legacy, '2026-01-01_100000-a.md'), 'synthetic')
    const result = await eraseLegacyOwnedMeetings({ folder: legacy, isOwned: async () => 'unreadable' })
    expect(result).toEqual({ deleted: 0, failed: 1 })
    expect(readdirSync(legacy)).toEqual(['2026-01-01_100000-a.md'])
  })
})
