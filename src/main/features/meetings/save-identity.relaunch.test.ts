import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveMeeting, Settings } from '@shared/ipc'
import { TranscriptSaveReceiptStore, type TranscriptSaveReceipt } from '../../transcript-save-receipts'
import { useStorageForTests } from '../../infra/storage/meetings-storage'
import { writeMeetingOnce } from './save-identity'

vi.mock('electron')

const STARTED_AT = Date.parse('2026-10-21T15:00:00.000Z')
const GENERATION = 1

let folder: string
let settings: Settings
let store: TranscriptSaveReceiptStore

beforeEach(() => {
  useStorageForTests()
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'save-identity-')))
  settings = { meetingsFolder: folder, autoSaveTranscripts: true } as Settings
  store = new TranscriptSaveReceiptStore()
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

const payload = (recap: string, text = 'we agreed on the plan'): SaveMeeting => ({
  title: 'Planning',
  mode: 'meeting',
  startedAt: STARTED_AT,
  lines: [{ speaker: 'them', text, t: STARTED_AT }],
  recap
})

const meetingFiles = (): string[] => readdirSync(folder).filter((name) => /^\d{4}-.*\.md$/.test(name))

/** What the saveTranscript handler does for one payload: a receipt per fingerprint, one identity per meeting. */
function save(fingerprint: string, meeting: SaveMeeting, after?: (receipt: TranscriptSaveReceipt) => void) {
  return store.run(
    `${GENERATION}:${fingerprint}`,
    { startedAt: STARTED_AT, authGeneration: GENERATION },
    async (receipt) => {
      receipt.normalizedStartedAt = meeting.startedAt
      receipt.settings = settings
      receipt.durablePath = await writeMeetingOnce(receipt, settings, meeting, store, { authGeneration: GENERATION })
      after?.(receipt)
      return receipt.durablePath
    }
  )
}

describe('one meeting identity is one saved file', () => {
  it('a second payload for a meeting whose first save is durable rewrites the same file (no -2 copy)', async () => {
    const first = await save('payload-a', payload('## Overview:\nFirst notes.'), (receipt) => {
      receipt.completed.add('summary-credit')
    })
    // a later stage failed, the renderer gave up and re-created the meeting with a recap: a different fingerprint
    const second = await save('payload-b', payload('## Overview:\nSecond notes, after the recap arrived.', 'we agreed'))
    expect(second).toBe(first)
    expect(meetingFiles()).toHaveLength(1)
    const text = readFileSync(first, 'utf8')
    expect(text).toContain('Second notes, after the recap arrived.')
    expect(text).not.toContain('First notes.')
    expect(text).toContain('we agreed')
  })

  it('the rewritten save inherits the credits the first save recorded, never credits twice', async () => {
    await save('payload-a', payload('## Overview:\nFirst.'), (receipt) => {
      receipt.completed.add('summary-credit')
    })
    let inherited: string[] = []
    await save('payload-b', payload('## Overview:\nSecond.'), (receipt) => {
      inherited = [...receipt.completed]
    })
    expect(inherited).toEqual(['summary-credit'])
  })

  it('a different meeting (another start instant) still gets its own file', async () => {
    await save('payload-a', payload('## Overview:\nFirst.'))
    const other = { ...payload('## Overview:\nOther.'), startedAt: STARTED_AT + 3_600_000 }
    await store.run(
      `${GENERATION}:other`,
      { startedAt: other.startedAt, authGeneration: GENERATION },
      async (receipt) => {
        receipt.normalizedStartedAt = other.startedAt
        receipt.settings = settings
        receipt.durablePath = await writeMeetingOnce(receipt, settings, other, store, { authGeneration: GENERATION })
        return receipt.durablePath
      }
    )
    expect(meetingFiles()).toHaveLength(2)
  })

  it('creates a fresh file when the first file was deleted meanwhile', async () => {
    const first = await save('payload-a', payload('## Overview:\nFirst.'))
    rmSync(first)
    const second = await save('payload-b', payload('## Overview:\nSecond.'))
    expect(meetingFiles()).toHaveLength(1)
    expect(readFileSync(second, 'utf8')).toContain('Second.')
  })
})
