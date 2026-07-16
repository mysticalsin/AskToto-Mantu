import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { safeStorage } from 'electron'
import { saveMeeting, isEncryptedFile } from './transcripts'
import { listMeetings, deleteMeeting, recallRead, searchMeetings, deleteAllMeetings, sweepExpiredMeetings, updateMeetingRecap, renameMeeting } from './recall'
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
    // basename(), not a POSIX-only '/' split — `file` is a platform-native absolute path (backslashes on
    // Windows), and index.md's row links only ever carry the bare filename (see appendIndexRow).
    expect(readFileSync(indexPath, 'utf8')).toContain(basename(file))

    const r = await deleteMeeting(file)
    expect(r.ok).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(indexPath, 'utf8')).not.toContain(basename(file))

    const after = await listMeetings()
    expect(after.some((m) => file.endsWith(m.file))).toBe(false)
  })

  it('accepts a bare basename (what the renderer sends) as well as a full path', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const bareName = basename(file)
    const r = await deleteMeeting(bareName)
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

  it('surfaces the recap-derived topics from frontmatter in listMeetings', async () => {
    await saveMeeting(testSettings, {
      ...meeting,
      recap: '## Title:\nRoadmap lock-in\n\n## Tags:\nroadmap, Q3, budget\n\n## Overview:\nx'
    })
    const list = await listMeetings()
    expect(list[0].title).toBe('Roadmap lock-in')
    expect(list[0].topics).toEqual(['roadmap', 'Q3', 'budget'])
  })

  it('omits topics when the meeting has no recap tags', async () => {
    await saveMeeting(testSettings, meeting)
    const list = await listMeetings()
    expect(list[0].topics).toBeUndefined()
  })
})

describe('recall — deleteAllMeetings', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-test-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('removes every saved meeting and the index in one call', async () => {
    const base: SaveMeeting = {
      title: 'M',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [],
      recap: 'r'
    }
    const f1 = await saveMeeting(testSettings, { ...base, title: 'One', startedAt: 1_700_000_000_000 })
    const f2 = await saveMeeting(testSettings, { ...base, title: 'Two', startedAt: 1_700_000_100_000 })
    expect((await listMeetings()).length).toBe(2)

    const r = await deleteAllMeetings()
    expect(r.ok).toBe(true)
    expect(r.deleted).toBe(2)
    expect(existsSync(f1)).toBe(false)
    expect(existsSync(f2)).toBe(false)
    expect((await listMeetings()).length).toBe(0)
  })

  it('is a safe no-op when there is nothing to delete', async () => {
    const r = await deleteAllMeetings()
    expect(r.ok).toBe(true)
    expect(r.deleted).toBe(0)
  })
})

describe('recall — sweepExpiredMeetings (retention)', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-test-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('retentionDays <= 0 means off — never deletes anything', async () => {
    await saveMeeting(testSettings, {
      title: 'Ancient',
      mode: 'meeting',
      startedAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
      lines: [],
      recap: 'r'
    })
    const r = await sweepExpiredMeetings(0)
    expect(r.deleted).toBe(0)
    expect((await listMeetings()).length).toBe(1)
  })

  it('deletes only meetings older than the retention window, keeps recent ones', async () => {
    const old = await saveMeeting(testSettings, {
      title: 'Old one',
      mode: 'meeting',
      startedAt: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days ago
      lines: [],
      recap: 'r'
    })
    const recent = await saveMeeting(testSettings, {
      title: 'Recent one',
      mode: 'meeting',
      startedAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // yesterday
      lines: [],
      recap: 'r'
    })

    const r = await sweepExpiredMeetings(30) // 30-day retention
    expect(r.deleted).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)

    const remaining = await listMeetings()
    expect(remaining.length).toBe(1)
    expect(remaining[0].title).toBe('Recent one')
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

// Editable AI recap: after a recap is generated it is read-only in the UI; this backend lets the user fix
// a wrong name / tick an action item / annotate. The load-bearing property is PARSEABILITY — the edited
// "## Notes & follow-ups" section must still start/end exactly where recallRead expects, so reopening the
// meeting (and all CRM/follow-up parsing) keeps working. These drive the real save → edit → read path.
describe('recall — updateMeetingRecap', () => {
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
    lines: [
      { speaker: 'them', text: 'Let us lock the roadmap', t: 1_700_000_000_000 },
      { speaker: 'you', text: 'Agreed, ship Q3', t: 1_700_000_005_000 }
    ],
    // Real-shape recap: its own "## " sub-headings live inside "## Notes & follow-ups".
    recap: '## Overview:\nInitial notes.\n\n## Action items:\n- Send deck (Bob)'
  }

  it('rewrites only the recap section; recallRead returns the edit and the transcript still parses', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const edited = '## Overview:\nAlice (not Bob) owns the deck.\n\n## Action items:\n- Send deck (Alice)'
    const r = await updateMeetingRecap(testSettings, file, edited)
    expect(r.ok).toBe(true)

    const read = await recallRead(file)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.recap).toBe(edited) // round-trips through its own internal "## " headings
      expect(read.lines).toHaveLength(2) // "## Full transcript" boundary intact
      expect(read.lines[1]).toMatchObject({ speaker: 'you', text: 'Agreed, ship Q3' })
      expect(read.title).toBe('Q3 planning sync') // frontmatter untouched by a recap edit
    }
  })

  it('accepts a bare basename (what the renderer sends)', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const base = basename(file)
    const r = await updateMeetingRecap(testSettings, base, 'New notes.')
    expect(r.ok).toBe(true)
    const read = await recallRead(file)
    if (read.ok) expect(read.recap).toBe('New notes.')
  })

  it('inserts a notes section when the meeting was saved without a recap', async () => {
    const file = await saveMeeting(testSettings, { ...meeting, recap: '' })
    let read = await recallRead(file)
    if (read.ok) expect(read.recap).toBe('') // no notes section yet

    const r = await updateMeetingRecap(testSettings, file, 'Added after the fact.')
    expect(r.ok).toBe(true)
    read = await recallRead(file)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.recap).toBe('Added after the fact.')
      expect(read.lines).toHaveLength(2) // transcript preserved
    }
  })

  it('rejects an edit that injects the reserved "## Full transcript" heading, leaving the file untouched', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const before = readFileSync(file, 'utf8')
    const r = await updateMeetingRecap(testSettings, file, 'Notes\n\n## Full transcript\nfake line')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/reserved/i)
    expect(readFileSync(file, 'utf8')).toBe(before) // never written
  })

  it('refuses index.md / README.md / non-.md / empty names', async () => {
    for (const bad of ['index.md', 'README.md', 'notes.txt', '']) {
      const r = await updateMeetingRecap(testSettings, bad, 'x')
      expect(r.ok).toBe(false)
    }
  })

  it('reports a clear error on a missing file', async () => {
    const r = await updateMeetingRecap(testSettings, '2024-01-01_000000-gone.md', 'x')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  it('caps an oversized recap at 20000 chars', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const r = await updateMeetingRecap(testSettings, file, 'A'.repeat(25000))
    expect(r.ok).toBe(true)
    const read = await recallRead(file)
    if (read.ok) expect(read.recap).toBe('A'.repeat(20000))
  })

  it("preserves the file's own encryption state — encrypted stays encrypted, and follows the file, not the live setting", async () => {
    // Real base64 round-trip through a mocked keychain (mirrors transcripts.test.ts's encryption test).
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from('B64:' + Buffer.from(v, 'utf8').toString('base64'))
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
    const enc = { ...testSettings, encryptTranscripts: true } as Settings
    const file = await saveMeeting(enc, meeting)
    expect(isEncryptedFile(file)).toBe(true)

    // Toggle the SETTING off to prove the edit follows the FILE's own encrypted state (isEncryptedFile),
    // not the live encryptTranscripts toggle (which may have changed since the file was saved).
    const settingOff = { ...enc, encryptTranscripts: false } as Settings
    const r = await updateMeetingRecap(settingOff, file, 'Edited while encrypted.')
    expect(r.ok).toBe(true)
    expect(isEncryptedFile(file)).toBe(true) // still encrypted after the edit
    expect(readFileSync(file, 'utf8')).not.toContain('Edited while encrypted.') // ciphertext, not plaintext

    const read = await recallRead(file)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.recap).toBe('Edited while encrypted.')
  })
})

describe('recall — renameMeeting', () => {
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

  // Regression test: a title containing $-replacement patterns ($&, $1, $`, $$) used to corrupt the
  // frontmatter and H1 because renameMeeting fed the title as the REPLACEMENT STRING to String.replace,
  // where $ is special. Fixed by using replacement functions instead, so it must round-trip verbatim.
  it('rewrites the title verbatim when it contains $-replacement patterns, round-tripping through disk', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const title = 'Deal $500 (A&B) $1 win'
    const r = await renameMeeting(testSettings, file, title)
    expect(r.ok).toBe(true)

    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain(`title: "${title}"`)
    expect(raw).toContain(`# ${title}`)
    // The frontmatter block must still be well-formed (single quoted title: line, closed by ---).
    expect(raw.match(/^---\n[\s\S]*?\n---/)?.[0]).toContain(`title: "${title}"`)

    const read = await recallRead(file)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.title).toBe(title)
  })

  it('handles other $-patterns ($$, $`, $\') without corrupting the file', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const title = "cost $$ high $` tail $' end"
    const r = await renameMeeting(testSettings, file, title)
    expect(r.ok).toBe(true)
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain(`title: "${title}"`)
    expect(raw).toContain(`# ${title}`)
  })

  it('still rewrites a plain title with no special characters', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const r = await renameMeeting(testSettings, file, 'Renamed sync')
    expect(r.ok).toBe(true)
    const read = await recallRead(file)
    if (read.ok) expect(read.title).toBe('Renamed sync')
  })
})

// A meeting file can become undecryptable (corrupted bytes, or encrypted under a different device's
// keychain — common when OneDrive syncs an encrypted transcript to another machine). Before, a per-row
// decrypt failure had to degrade gracefully; these lock that in so one bad row never takes down History.
describe('recall — undecryptable rows degrade gracefully', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-test-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const goodMeeting: SaveMeeting = {
    title: 'Readable meeting',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'This one decrypts fine', t: 1_700_000_000_000 }],
    recap: 'All good.'
  }

  /** Write a file with the v2 envelope marker but malformed JSON after it, so the per-file decrypt
   *  throws internally exactly like a corrupted-on-disk or foreign-keychain transcript would. */
  function writeCorruptEncryptedFile(name: string): string {
    const path = join(folder, name)
    writeFileSync(path, Buffer.concat([Buffer.from('ATKENC2\n'), Buffer.from('not valid json{{{')]))
    return path
  }

  it('listMeetings skips a corrupt row instead of throwing, and still returns the good ones', async () => {
    const goodFile = await saveMeeting(testSettings, goodMeeting)
    writeCorruptEncryptedFile('2024-01-01_000000-corrupt.md')

    const list = await listMeetings()
    expect(list.some((m) => goodFile.endsWith(m.file))).toBe(true)
    expect(list.some((m) => m.file === '2024-01-01_000000-corrupt.md')).toBe(false)
    expect(list).toHaveLength(1)
  })

  it('searchMeetings skips a corrupt row instead of throwing, and still finds the good ones', async () => {
    await saveMeeting(testSettings, goodMeeting)
    writeCorruptEncryptedFile('2024-01-01_000000-corrupt.md')

    const hits = await searchMeetings('decrypts')
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Readable meeting')
  })

  it('recallRead reports a clear error instead of throwing on a corrupt/undecryptable file', async () => {
    const corruptFile = writeCorruptEncryptedFile('2024-01-01_000000-corrupt.md')
    const r = await recallRead(corruptFile)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/could not be decrypted/i)
  })
})
