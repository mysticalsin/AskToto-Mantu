import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveMeeting } from './transcripts'
import { listMeetings, deleteMeeting, recallRead } from './recall'
import type { Settings, SaveMeeting } from '@shared/ipc'

vi.mock('electron')

// Stub the settings store entirely — recall.ts/transcripts.ts only ever read it via getSettings(), and
// stubbing avoids touching the real userData directory (ensureDir/mkdir), which the test sandbox blocks
// outside its own temp dir. vitest hoists vi.mock() above the static imports above, so this is in effect
// for them regardless of source order.
let testSettings: Settings
vi.mock('./store', () => ({ getSettings: () => testSettings }))

// Tony reported "delete doesn't delete" on a saved meeting in History. This exercises the real file-IO
// path end to end (save → list → delete → list again) against a temp folder, the same way the app does.
describe('recall — deleteMeeting', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-test-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const meeting: SaveMeeting = {
    title: 'Q3 planning sync',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'Let us lock the roadmap', t: 1_700_000_000_000 }],
    recap: 'Decided to ship in Q3.'
  }

  it('removes the file and its index.md row, and the meeting no longer lists', async () => {
    const file = await saveMeeting(testSettings, meeting)
    expect(existsSync(file)).toBe(true)

    const before = await listMeetings()
    expect(before.some((m) => file.endsWith(m.file))).toBe(true)

    const indexPath = join(folder, 'index.md')
    expect(existsSync(indexPath)).toBe(true)
    expect(readFileSync(indexPath, 'utf8')).toContain(file.split('/').pop()!)

    const r = await deleteMeeting(file)
    expect(r.ok).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(indexPath, 'utf8')).not.toContain(file.split('/').pop()!)

    const after = await listMeetings()
    expect(after.some((m) => file.endsWith(m.file))).toBe(false)
  })

  it('accepts a bare basename (what the renderer sends) as well as a full path', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const basename = file.split('/').pop()!
    const r = await deleteMeeting(basename)
    expect(r.ok).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('reports a clear error instead of throwing on a second delete of the same file', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const first = await deleteMeeting(file)
    expect(first.ok).toBe(true)
    const second = await deleteMeeting(file)
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/not found/i)
  })
})

describe('recall — recallRead recap extraction', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-test-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // Regression: RECAP_PROMPT's real output starts with its own "## Overview:" heading, so a saved
  // meeting's file always has a "## " line immediately inside "## Notes & follow-ups". A prior version
  // of the extraction regex stopped at ANY "## " and captured nothing — reopening any past meeting from
  // History showed a permanently empty recap. This reproduces that exact shape end to end (save → read).
  const REAL_SHAPE_RECAP = [
    '## Overview:',
    'We aligned on the Q3 launch and the budget.',
    '',
    '## Topics:',
    '- Launch timeline',
    '',
    '## Action items:',
    '- Send the deck (Alice)'
  ].join('\n')

  it('recovers the full recap even though it contains its own "## " headings', async () => {
    const file = await saveMeeting(testSettings, {
      title: 'Q3 planning sync',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'Let us lock the roadmap', t: 1_700_000_000_000 }],
      recap: REAL_SHAPE_RECAP
    })
    const r = await recallRead(file)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.recap).toBe(REAL_SHAPE_RECAP)
  })

  it('recovers the transcript lines alongside the recap', async () => {
    const file = await saveMeeting(testSettings, {
      title: 'Q3 planning sync',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [
        { speaker: 'them', text: 'Let us lock the roadmap', t: 1_700_000_000_000 },
        { speaker: 'you', text: 'Agreed, ship Q3', t: 1_700_000_005_000 }
      ],
      recap: REAL_SHAPE_RECAP
    })
    const r = await recallRead(file)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lines).toHaveLength(2)
      expect(r.lines[0]).toMatchObject({ speaker: 'them', text: 'Let us lock the roadmap' })
      expect(r.lines[1]).toMatchObject({ speaker: 'you', text: 'Agreed, ship Q3' })
    }
  })

  it('returns an empty recap (not an error) when the meeting had no recap at all', async () => {
    const file = await saveMeeting(testSettings, {
      title: 'No recap meeting',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'Quick chat', t: 1_700_000_000_000 }],
      recap: ''
    })
    const r = await recallRead(file)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.recap).toBe('')
  })
})
