import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { safeStorage } from 'electron'
import { saveMeeting, isEncryptedFile } from './transcripts'
import { listMeetings, deleteMeeting, recallRead, searchMeetings, deleteAllMeetings, sweepExpiredMeetings, updateMeetingRecap, renameMeeting, setMeetingCrmPushed, setMeetingConfidential, isMeetingConfidentialOnDisk } from './recall'
import type { Settings, SaveMeeting } from '@shared/ipc'

/**
 * The lines a successful read must have.
 *
 * `lines` is optional on the result type, so indexing it is a type error — correctly, because a read that
 * parsed nothing returns none. The tests were reaching straight into it behind an `if (r.ok)` that does
 * not narrow it. This makes the assumption an ASSERTION: an absent lines[] is a failure of the thing under
 * test, and it now says so instead of surfacing as "possibly undefined" or being cast away.
 */
function linesOf(r: { lines?: { t: number; speaker: string; text: string; lang?: string }[] }): { t: number; speaker: string; text: string; lang?: string }[] {
  if (!r.lines) throw new Error('read returned no lines — the transcript did not parse')
  return r.lines
}

vi.mock('electron')

// Stub the settings store entirely — recall.ts/transcripts.ts only ever read it via getSettings(), and
// stubbing avoids touching the real userData directory (ensureDir/mkdir), which the test sandbox blocks
// outside its own temp dir. vitest hoists vi.mock() above the static imports above, so this is in effect
// for them regardless of source order.
let testSettings: Settings
vi.mock('./store', () => ({ getSettings: () => testSettings }))

// MQA-033: the field trigger is an unhydrated OneDrive Files-On-Demand placeholder (or an AV/EDR
// share-lock) where stat() still succeeds and readFile() throws — not something Node can be made to
// reproduce deterministically on every platform. So the read is failed at the fs boundary for the paths
// in this set, leaving stat() (the readCache key) genuinely untouched, exactly as on a placeholder.
const { unreadablePaths } = vi.hoisted(() => ({ unreadablePaths: new Set<string>() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = (async (path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && unreadablePaths.has(path)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: 'EBUSY' })
    }
    return (actual.readFile as (...a: never[]) => Promise<unknown>)(path as never, ...(rest as never[]))
  }) as unknown as typeof actual.readFile
  return { ...actual, default: { ...actual, readFile }, readFile }
})

// Language-switch markers must survive the save → reparse → rewrite round trip: recall's line regex
// rightly skips marker PROSE, so lang tags are re-derived per line via detectLanguage — without that,
// a Speaker Intelligence backfill (updateMeetingNames → formatTranscript over reparsed lines) silently
// stripped every marker, and a retroactive recap saw no switches (4-agent review, regression hunter).
describe('recall — language tags round-trip through save → recallRead', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-lang-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('MQA-310 round-trips measured duration instead of deriving it from line starts', async () => {
    const saved = await saveMeeting(testSettings, {
      title: 'Synthetic duration check', mode: 'meeting', startedAt: 1_700_000_000_000,
      durationMs: 28_840, recap: '',
      lines: [{ t: 1_700_000_000_000, speaker: 'unknown', text: 'Synthetic speech.' }]
    })
    expect(readFileSync(saved, 'utf8')).toContain('duration_ms: 28840')
    expect((await recallRead(basename(saved))).durationMs).toBe(28_840)
    expect((await listMeetings())[0].durationMin).toBe(1)
  })

  it.each(['-1', 'NaN', 'Infinity', 'not-a-number'])('MQA-310 ignores invalid persisted duration %s', async (duration) => {
    const file = 'invalid-duration.md'
    writeFileSync(join(folder, file), `---\ntype: meeting-transcript\ndate: 2026-09-12T10:00:00Z\nduration_ms: ${duration}\n---\n## Full transcript\n\n**[10:00:00] Speaker:** Synthetic speech.\n`)
    expect((await recallRead(file)).durationMs).toBeUndefined()
  })

  it('re-derives lang on reparse so formatTranscript re-emits the same switch markers', async () => {
    const t0 = 1_700_000_000_000
    const meeting: SaveMeeting = {
      title: 'WUM Brazil',
      mode: 'meeting',
      startedAt: t0,
      lines: [
        { speaker: 'them', text: 'Então vamos ver isso com você, não é, para o contrato.', t: t0, lang: 'Portuguese' },
        { speaker: 'you', text: 'So we are going to talk about the budget and the plan for the team.', t: t0 + 60_000, lang: 'English' }
      ],
      recap: ''
    }
    const file = await saveMeeting(testSettings, meeting)
    const saved = readFileSync(file, 'utf8')
    expect(saved).toContain('_[conversation switches to English]_')

    const r = await recallRead(basename(file))
    expect(r.ok).toBe(true)
    expect(r.lines?.map((l) => l.lang)).toEqual(['Portuguese', 'English'])

    // The exact rewrite the Speaker Intelligence backfill performs: formatTranscript over reparsed lines.
    const { formatTranscript } = await import('./transcripts')
    expect(formatTranscript(r.lines ?? [])).toContain('_[conversation switches to English]_')
  })
})

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
      expect(linesOf(r)[0]).toMatchObject({ speaker: 'them', text: 'Let us lock the roadmap' })
      expect(linesOf(r)[1]).toMatchObject({ speaker: 'you', text: 'Agreed, ship Q3' })
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
      expect(linesOf(read)[1]).toMatchObject({ speaker: 'you', text: 'Agreed, ship Q3' })
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

  it('listMeetings surfaces an undecryptable meeting as a locked stub instead of dropping it', async () => {
    const goodFile = await saveMeeting(testSettings, goodMeeting)
    writeCorruptEncryptedFile('2024-01-01_000000-corrupt.md')

    const list = await listMeetings()
    // The readable meeting is present, and the encrypted-but-undecryptable file is now visible as a
    // locked stub (was silently dropped before — hiding real meetings the user couldn't decrypt).
    expect(list.some((m) => goodFile.endsWith(m.file))).toBe(true)
    const locked = list.find((m) => m.file === '2024-01-01_000000-corrupt.md')
    expect(locked).toBeDefined()
    expect(locked?.locked).toBe(true)
    expect(list).toHaveLength(2)
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

// MQA-032 — the meetings folder is an arbitrary user-chosen directory (Settings → Change folder), so
// "Delete all Métis data" matching on the .md extension alone permanently unlinked the user's own
// unrelated markdown alongside Métis's files: no backup, no undo, and a confirmation that never
// promised anything but transcripts, notes and the graph. See docs/qa/BUG-LEDGER.md → MQA-032.
describe("recall — deleteAllMeetings erases only Métis's own files (MQA-032)", () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-own-'))
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

  it("MQA-032: leaves the user's own markdown on disk and reports it as skipped", async () => {
    const saved = await saveMeeting(testSettings, meeting)
    // The user's own notes, sitting in the directory they pointed Métis at.
    const foreign = ['ideas.md', 'todo.md', '2026-budget.md']
    writeFileSync(join(folder, 'ideas.md'), '# Ideas\n\n- Pitch the pilot\n', 'utf8')
    writeFileSync(join(folder, 'todo.md'), '- [ ] Renew the contract\n', 'utf8')
    // Carries a `type:` key of its own (Obsidian/Dataview style) — the exact shape listMeetings drops,
    // so the confirm dialog never counted it either.
    writeFileSync(join(folder, '2026-budget.md'), '---\ntype: book\n---\n\n# Budget\n', 'utf8')

    const r = await deleteAllMeetings()

    expect(existsSync(saved)).toBe(false)
    for (const f of foreign) expect(existsSync(join(folder, f))).toBe(true)
    expect(r.deleted).toBe(1)
    expect([...r.skipped].sort()).toEqual([...foreign].sort())
    expect(r.ok).toBe(true)
  })

  it('MQA-032: still erases every shape Métis owns — meeting, note, draft, renamed and undecryptable', async () => {
    const saved = await saveMeeting(testSettings, meeting)
    // A quick note (saveNote's filename shape) and an in-progress autosave (saveDraftTranscript's).
    writeFileSync(join(folder, '2024-01-01_000000-note-idea.md'), '---\ntype: note\n---\n\n# Idea\n', 'utf8')
    writeFileSync(join(folder, '.autosave-draft-2024-01-01_000000-123.md'), '---\ntype: meeting-transcript-draft\n---\n', 'utf8')
    // A transcript the user renamed by hand: the filename no longer identifies it, the frontmatter does.
    writeFileSync(join(folder, 'renault-kickoff.md'), '---\ntype: meeting-transcript\n---\n\n# Renault\n', 'utf8')
    // An encrypted save this device cannot decrypt — still ours, and a GDPR wipe must still remove it.
    writeFileSync(join(folder, 'export.md'), Buffer.concat([Buffer.from('ATKENC2\n'), Buffer.from('not valid json{{{')]))

    const r = await deleteAllMeetings()

    expect(r.skipped).toEqual([])
    expect(r.deleted).toBe(5)
    expect(existsSync(saved)).toBe(false)
    for (const f of ['2024-01-01_000000-note-idea.md', '.autosave-draft-2024-01-01_000000-123.md', 'renault-kickoff.md', 'export.md']) {
      expect(existsSync(join(folder, f))).toBe(false)
    }
  })

  // MQA-103 (docs/qa/BUG-LEDGER.md): a hand-renamed transcript whose ownership READ throws transiently
  // (an EBUSY/EPERM lock, or an unhydrated OneDrive placeholder — routine on this folder) must be
  // reported as FAILED, never silently folded into `skipped` as if it were the user's own foreign file.
  // An erasure request that reports success while a real transcript survives is a GDPR/CCPA violation.
  it('MQA-103: an unreadable hand-renamed transcript is FAILED, not silently skipped, and ok is false', async () => {
    const saved = await saveMeeting(testSettings, meeting)
    // A transcript the user renamed by hand — its filename no longer identifies it, so ownership can only
    // be decided by reading the frontmatter.
    const renamed = 'acme-renewal.md'
    writeFileSync(join(folder, renamed), '---\ntype: meeting-transcript\n---\n\n# Acme\n', 'utf8')
    // The read of exactly that file throws (a transient lock); every other read passes through untouched.
    const fsp = await import('node:fs/promises')
    const realReadFile = fsp.readFile
    vi.spyOn(fsp, 'readFile').mockImplementation((async (p: Parameters<typeof realReadFile>[0], ...rest: unknown[]) => {
      if (String(p).endsWith(renamed)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return (realReadFile as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof realReadFile)

    const r = await deleteAllMeetings()

    expect(r.failed).toContain(renamed) // surfaced so the user can retry
    expect(r.skipped).not.toContain(renamed) // NOT quietly treated as a foreign file
    expect(r.ok).toBe(false) // the wipe cannot report success while a real transcript may remain
    expect(existsSync(join(folder, renamed))).toBe(true) // and it was NOT deleted — we could not confirm it ours
    expect(existsSync(saved)).toBe(false) // the readable meeting still got erased
  })
})

// MQA-033 — a transient read error (unhydrated OneDrive Files-On-Demand placeholder, AV/EDR share-lock)
// was indistinguishable from "not a meeting file": the meeting vanished from History AND search with no
// signal, and the null was cached against a stat() that hydration never changes, so it stayed invisible
// for the rest of the session. See docs/qa/BUG-LEDGER.md → MQA-033.
describe('recall — a transient read failure never hides a meeting (MQA-033)', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-unreadable-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    unreadablePaths.clear()
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const meeting: SaveMeeting = {
    title: 'Renault kickoff',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'Renault wants the pilot live in March', t: 1_700_000_000_000 }],
    recap: 'Pilot in March.'
  }

  it('MQA-033: lists it as an unavailable stub while the read fails, and recovers once it succeeds', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const name = basename(file)
    const before = statSync(file)

    unreadablePaths.add(file)
    const during = await listMeetings()
    const row = during.find((m) => m.file === name)
    expect(row).toBeDefined() // the row must survive the failed read, not silently disappear
    expect(row?.locked).toBe(true)
    expect(row?.title).toContain('Unavailable')

    // Hydration / lock release changes neither mtimeMs nor size — the readCache key — so a cached null
    // would keep the meeting invisible until the app restarts.
    unreadablePaths.delete(file)
    const after = statSync(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)

    const recovered = await listMeetings()
    expect(recovered.find((m) => m.file === name)?.title).toBe('Renault kickoff')
  })

  it('MQA-033: search finds the meeting again as soon as the file reads, without an app restart', async () => {
    const file = await saveMeeting(testSettings, meeting)

    unreadablePaths.add(file)
    expect(await searchMeetings('march')).toHaveLength(0) // nothing to match on while it can't be read

    unreadablePaths.delete(file)
    const hits = await searchMeetings('march')
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Renault kickoff')
  })

  it('MQA-033: a genuinely non-meeting file is still dropped, and still cached as such', async () => {
    await saveMeeting(testSettings, meeting)
    writeFileSync(join(folder, '2024-01-01_000000-other.md'), '---\ntype: book\n---\n\n# Not a meeting\n', 'utf8')

    const list = await listMeetings()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Renault kickoff')
  })
})

// MQA-078 — the writers escape a title for YAML (`\` → `\\`, `"` → `\"`: transcripts.ts's yamlSafeTitle
// and this module's yamlSafeRenameTitle), but the single reader never unescaped. History showed the raw
// escapes, and the rename box — pre-filled from that same value — re-escaped what was already escaped on
// every commit, doubling the backslashes without bound. See docs/qa/BUG-LEDGER.md → MQA-078.
describe('recall — quote/backslash titles round-trip through the reader (MQA-078)', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-quote-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const meeting: SaveMeeting = {
    title: 'Renault "Phase 2" renewal',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'Phase 2 starts in March', t: 1_700_000_000_000 }],
    recap: 'Phase 2 agreed.'
  }

  /** The single level of escaping the writers put in the quoted frontmatter scalar — never more. */
  const onDisk = (s: string): string => `title: "${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

  it('MQA-078: a saved title keeps its quotes in History and on reopen', async () => {
    const file = await saveMeeting(testSettings, meeting)
    expect(readFileSync(file, 'utf8')).toContain(onDisk(meeting.title))

    const read = await recallRead(file)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.title).toBe(meeting.title)
    expect((await listMeetings()).find((m) => m.file === basename(file))?.title).toBe(meeting.title)
  })

  it('MQA-078: two consecutive renames never double the escaping', async () => {
    const file = await saveMeeting(testSettings, meeting)

    const first = 'Renault "Phase 3" renewal'
    expect((await renameMeeting(testSettings, file, first)).ok).toBe(true)
    const afterFirst = await recallRead(file)
    expect(afterFirst.ok).toBe(true)
    if (afterFirst.ok) expect(afterFirst.title).toBe(first)

    // RecallView pre-fills the rename input with the value it just displayed, so the second commit sends
    // back whatever the reader returned — the exact path that escalated \" → \\\" → \\\\\\\" on disk.
    const second = `${afterFirst.ok ? afterFirst.title : ''} \\ Q4`
    expect((await renameMeeting(testSettings, file, second)).ok).toBe(true)

    const expected = 'Renault "Phase 3" renewal \\ Q4'
    const afterSecond = await recallRead(file)
    expect(afterSecond.ok).toBe(true)
    if (afterSecond.ok) expect(afterSecond.title).toBe(expected)
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain(onDisk(expected))
    expect(raw).toContain(`# ${expected}`)
  })
})

// MQA-097 — the midnight-crossing guard seeded prevT with the millisecond-precision frontmatter start
// while every reconstructed line time is floored to the whole second, so a first line inside the start's
// own second looked like a crossing and pushed the whole transcript a day forward. Imported recordings
// (startedAt = raw file mtime, line 0 exactly on it) hit it every time. See docs/qa/BUG-LEDGER.md → MQA-097.
describe('recall — sub-second start times do not shift the transcript a day (MQA-097)', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-midnight-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('MQA-097: an imported meeting whose start carries milliseconds stays on its own calendar day', async () => {
    // What import-jobs.ts produces: startedAt is the source file's raw mtime (a whole second essentially
    // never), and the first chunk's timestamp is that same value.
    const started = new Date(2026, 7, 1, 12, 34, 56, 437).getTime()
    const file = await saveMeeting(testSettings, {
      title: 'Imported call',
      mode: 'meeting',
      startedAt: started,
      lines: [
        { speaker: 'unknown', text: 'So the renewal is agreed for March', t: started },
        { speaker: 'unknown', text: 'And we will confirm the numbers on Friday', t: started + 30_000 },
        { speaker: 'unknown', text: 'Good, I will send the summary over', t: started + 60_000 }
      ],
      recap: 'Renewal agreed.'
    })

    const read = await recallRead(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.lines).toHaveLength(3)
    // The lines are rendered as HH:MM:SS, so the reconstruction is the start floored to the second —
    // not that second plus 24 hours.
    expect(linesOf(read)[0].t).toBe(Math.floor(started / 1000) * 1000)
    expect(new Date(linesOf(read)[0].t).toDateString()).toBe(new Date(started).toDateString())
    // Backfill derives endedAt from the last line (index.ts) — a day-shifted span widens the calendar
    // lookup to ~24.5h and guarantees named: 0.
    expect(linesOf(read)[2].t - linesOf(read)[0].t).toBe(60_000)
  })

  it('MQA-097: a genuine midnight crossing still pushes the later lines to the next day', async () => {
    const started = new Date(2026, 7, 1, 23, 59, 30, 250).getTime()
    const file = await saveMeeting(testSettings, {
      title: 'Late night sync',
      mode: 'meeting',
      startedAt: started,
      lines: [
        { speaker: 'them', text: 'We are almost out of time for today', t: started },
        { speaker: 'you', text: 'One more point before we close this out', t: started + 40_000 }
      ],
      recap: 'Ran late.'
    })

    const read = await recallRead(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.lines).toHaveLength(2)
    expect(new Date(linesOf(read)[0].t).toDateString()).toBe(new Date(started).toDateString())
    expect(linesOf(read)[1].t - linesOf(read)[0].t).toBe(40_000) // 00:00:10 the next day, not 23 hours back
  })
})

// MQA-092 — Review's session Set stops the in-session re-arm; this marker is what survives a relaunch.
// Without it, pushing a recap, quitting, relaunching and reopening the meeting re-arms "Push to CRM" and
// a second Confirm files a byte-identical duplicate record in the user's CRM.
describe('setMeetingCrmPushed — the durable "already pushed to the CRM" marker', () => {
  let folder: string
  const meeting: SaveMeeting = {
    title: 'Acme renewal',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'Send the revised pricing', t: 1_700_000_000_000 }],
    recap: 'Agreed to revise pricing.'
  }

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-crm-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('writes the fingerprint into frontmatter and reads it back through recallRead', async () => {
    const file = await saveMeeting(testSettings, meeting)
    expect((await recallRead(basename(file))).crmPushedKey).toBeUndefined()

    expect(await setMeetingCrmPushed(testSettings, basename(file), 'a1b2c3')).toEqual({ ok: true })
    expect(readFileSync(file, 'utf8')).toMatch(/^crm_pushed: a1b2c3$/m)
    expect((await recallRead(basename(file))).crmPushedKey).toBe('a1b2c3')
  })

  it('leaves the H1, notes and transcript untouched — only the frontmatter block is rewritten', async () => {
    const file = await saveMeeting(testSettings, meeting)
    const before = readFileSync(file, 'utf8')
    await setMeetingCrmPushed(testSettings, basename(file), 'zz9')
    const after = readFileSync(file, 'utf8')
    expect(after.slice(after.indexOf('\n---', 4))).toBe(before.slice(before.indexOf('\n---', 4)))
  })

  it('replaces an earlier fingerprint rather than appending a second line', async () => {
    const file = await saveMeeting(testSettings, meeting)
    await setMeetingCrmPushed(testSettings, basename(file), 'first')
    await setMeetingCrmPushed(testSettings, basename(file), 'second') // the recap was edited and re-pushed
    const text = readFileSync(file, 'utf8')
    expect(text.match(/^crm_pushed:/gm)).toHaveLength(1)
    expect((await recallRead(basename(file))).crmPushedKey).toBe('second')
  })

  // The key is interpolated into a YAML scalar, so a value carrying a newline or a colon could forge
  // frontmatter (e.g. `confidential: true`, or a bogus `type:`). Refused, not escaped.
  it('refuses any key that could break out of the YAML scalar', async () => {
    const file = await saveMeeting(testSettings, meeting)
    for (const bad of ['a\nconfidential: true', 'has: colon', 'UPPER', 'has space', '', 'x'.repeat(33), '../../etc']) {
      expect(await setMeetingCrmPushed(testSettings, basename(file), bad)).toEqual({
        ok: false,
        error: 'Invalid CRM push key.'
      })
    }
    expect(readFileSync(file, 'utf8')).not.toMatch(/crm_pushed/)
  })

  it('refuses a traversing or non-meeting file name, like every other recall write', async () => {
    for (const bad of ['../../secrets.md', 'index.md', 'README.md', 'notes.txt', '']) {
      expect((await setMeetingCrmPushed(testSettings, bad, 'a1')).ok).toBe(false)
    }
  })

  it('reports a missing meeting instead of creating one', async () => {
    expect(await setMeetingCrmPushed(testSettings, 'never-existed.md', 'a1')).toEqual({
      ok: false,
      error: 'Meeting file not found.'
    })
  })

  it('preserves encryption exactly as found', async () => {
    testSettings = { meetingsFolder: folder, encryptTranscripts: true } as Settings
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const file = await saveMeeting(testSettings, meeting)
    expect(isEncryptedFile(file)).toBe(true)

    expect(await setMeetingCrmPushed(testSettings, basename(file), 'enc1')).toEqual({ ok: true })
    expect(isEncryptedFile(file)).toBe(true) // still encrypted — never silently downgraded to cleartext
    expect((await recallRead(basename(file))).crmPushedKey).toBe('enc1')
  })
})

describe('isMeetingConfidentialOnDisk — MCP push defense-in-depth', () => {
  let folder: string
  const meeting: SaveMeeting = {
    title: 'Secret pricing',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'Keep this internal', t: 1_700_000_000_000 }],
    recap: 'Internal only.'
  }

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-recall-conf-'))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('is false for a normal meeting and true after setMeetingConfidential', async () => {
    const file = await saveMeeting(testSettings, meeting)
    expect(isMeetingConfidentialOnDisk(testSettings, basename(file))).toBe(false)
    expect(await setMeetingConfidential(testSettings, basename(file), true)).toEqual({ ok: true })
    expect(isMeetingConfidentialOnDisk(testSettings, basename(file))).toBe(true)
  })

  it('fails closed on a missing or path-traversal file name', () => {
    expect(isMeetingConfidentialOnDisk(testSettings, 'no-such-meeting.md')).toBe(true)
    expect(isMeetingConfidentialOnDisk(testSettings, '../escape.md')).toBe(true)
  })
})
