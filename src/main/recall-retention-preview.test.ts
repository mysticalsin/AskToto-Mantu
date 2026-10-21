import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { saveMeeting } from './transcripts'
import { countExpiredMeetings, listMeetings } from './recall'
import { useStorageForTests } from './infra/storage/meetings-storage'

vi.mock('electron')

let testSettings: Settings
vi.mock('./store', () => ({ getSettings: () => testSettings }))

const DAY = 24 * 60 * 60 * 1000

describe('recall — countExpiredMeetings (Settings asks before a shorter retention window)', () => {
  let folder: string

  beforeEach(() => {
    useStorageForTests()
    folder = mkdtempSync(join(tmpdir(), 'asktoto-retention-preview-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('counts exactly the meetings the same window would sweep, and deletes nothing', async () => {
    for (const [title, age] of [
      ['Old', 100],
      ['Older', 400],
      ['Recent', 1]
    ] as const) {
      await saveMeeting(testSettings, {
        title,
        mode: 'meeting',
        startedAt: Date.now() - age * DAY,
        lines: [],
        recap: 'r'
      })
    }
    expect(await countExpiredMeetings(30)).toBe(2)
    expect(await countExpiredMeetings(365)).toBe(1)
    expect(await countExpiredMeetings(0)).toBe(0)
    expect((await listMeetings()).length).toBe(3)
  })
})
