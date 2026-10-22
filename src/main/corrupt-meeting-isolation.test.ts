/**
 * GATE-05 / R-14: one bad meeting file never breaks the others.
 *
 * A meetings folder holds good synthetic meetings next to every kind of file that cannot be used: an
 * undecryptable envelope, a truncated envelope, an oversized file, a cloud-only (dataless) placeholder, a
 * directory named like a meeting, an empty file and a text file that was never a meeting. Listing, search,
 * reopen, export and the recap editor must answer for the good files exactly as they would in a clean
 * folder, answer each bad file with its own named outcome, and leave every bad file's bytes untouched.
 * (Brain ingest has its own fixture next to its suite: brain/ingest-corrupt-isolation.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { app } from 'electron'
import { saveMeeting } from './transcripts'
import { deleteMeeting, listMeetings, recallRead, searchMeetings, updateMeetingRecap } from './recall'
import {
  MEETING_NOT_DOWNLOADED_MSG,
  MEETING_NOT_READABLE_MSG,
  exportFailureMessage,
  meetingOpenTarget,
  readSavedMeeting
} from './history-actions'
import { useStorageForTests } from './infra/storage/meetings-storage'
import { installSpeechReadPolicy } from './brain/__fixtures__/speech-read-policy'
import { ALPHA, FRENCH, occurrences } from './__fixtures__/golden-meetings'
import { parseRecapMarkdown, recapMarkdownToHtml } from './transcripts'

vi.mock('electron')

let testSettings: Settings
vi.mock('./store', () => ({ getSettings: () => testSettings }))

const READ_LIMIT_BYTES = 30_000

// Stamped like Métis's own filenames so a stub keeps its date; the slug says what the fixture is.
const NAMES = {
  undecryptable: '2026-01-01_000001-synthetic-undecryptable.md',
  truncated: '2026-01-01_000002-synthetic-truncated.md',
  oversized: '2026-01-01_000003-synthetic-oversized.md',
  dataless: '2026-01-01_000004-synthetic-cloud-only.md',
  directory: '2026-01-01_000005-synthetic-directory.md',
  empty: '2026-01-01_000006-synthetic-empty.md',
  notAMeeting: '2026-01-01_000007-synthetic-plain-notes.md'
} as const

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('one corrupt meeting file never breaks the others (GATE-05, R-14)', () => {
  let folder: string
  let restorePolicy: () => void
  let reads: string[]
  let cloudOnly: Set<string>
  let good: { alpha: string; french: string }
  const bytesBefore = new Map<string, string>()

  beforeEach(async () => {
    restorePolicy = installSpeechReadPolicy({
      maxRecords: 100,
      maxWords: 1000,
      maxFieldBytes: 10_000,
      maxRecordBytes: 20_000,
      maxPayloadBytes: READ_LIMIT_BYTES
    })
    const { readdir, readFile, realpath, stat, lstat } = await import('node:fs/promises')
    reads = []
    cloudOnly = new Set()
    useStorageForTests({
      detector: {
        classify: async (files) =>
          new Map(files.map((f) => [f.path, cloudOnly.has(f.path) ? 'dataless' : 'local'] as const))
      },
      fs: {
        readdir: (p) => readdir(p),
        readFile: async (p) => {
          reads.push(p)
          return readFile(p)
        },
        readFileBounded: async (p, maxBytes) => {
          reads.push(p)
          const size = statSync(p).size
          if (size > maxBytes) throw Object.assign(new Error('file too large'), { code: 'EFBIG' })
          return readFile(p)
        },
        realpath: (p) => realpath(p),
        stat: (p) => stat(p),
        lstat: (p) => lstat(p).then((s) => ({ isSymbolicLink: s.isSymbolicLink() }))
      }
    })
    folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'metis-corrupt-')))
    testSettings = { meetingsFolder: folder, encryptTranscripts: false } as Settings

    const alpha = await saveMeeting(testSettings, ALPHA.meeting)
    const french = await saveMeeting(testSettings, FRENCH.meeting)
    good = { alpha: basename(alpha), french: basename(french) }

    // An envelope this device cannot open (foreign keychain or damaged JSON).
    writeFileSync(
      join(folder, NAMES.undecryptable),
      Buffer.concat([Buffer.from('ATKENC2\n'), Buffer.from('not json{{{')])
    )
    // An envelope cut off mid-write.
    writeFileSync(
      join(folder, NAMES.truncated),
      Buffer.concat([Buffer.from('ATKENC2\n'), Buffer.from('{"v":2,"ct":"AAAA')])
    )
    // A file past the read limit that otherwise looks like a meeting.
    writeFileSync(
      join(folder, NAMES.oversized),
      `---\ntype: meeting-transcript\ntitle: Synthetic oversized\n---\n${'synthetic filler line\n'.repeat(3_000)}`
    )
    // A cloud-only placeholder: stat answers, the bytes are not on this device.
    const dataless = join(folder, NAMES.dataless)
    writeFileSync(dataless, '---\ntype: meeting-transcript\ntitle: Synthetic cloud only\n---\nnot downloaded\n')
    cloudOnly.add(dataless)
    mkdirSync(join(folder, NAMES.directory))
    writeFileSync(join(folder, NAMES.empty), '')
    // A Métis-typed document that is not a meeting (a quick note): present in the folder, never a History row.
    writeFileSync(
      join(folder, NAMES.notAMeeting),
      '---\ntype: note\ntitle: Synthetic shopping\n---\nShopping list.\n- milk\n'
    )

    for (const name of Object.values(NAMES)) {
      if (name !== NAMES.directory) bytesBefore.set(name, sha(join(folder, name)))
    }
    reads.length = 0
  })

  afterEach(() => {
    restorePolicy()
    rmSync(folder, { recursive: true, force: true })
    bytesBefore.clear()
    vi.restoreAllMocks()
  })

  it('lists every good meeting whole, gives each unusable file its own row kind, and drops what was never a meeting', async () => {
    const rows = await listMeetings()
    const byFile = new Map(rows.map((r) => [r.file, r]))

    expect(byFile.get(good.alpha)).toMatchObject({ title: ALPHA.expectedExport.title24, mode: 'meeting' })
    expect(byFile.get(good.french)).toMatchObject({ title: FRENCH.expectedExport.title24, mode: 'meeting' })
    expect(byFile.get(good.alpha)).not.toHaveProperty('locked')
    expect(byFile.get(good.alpha)).not.toHaveProperty('unavailable')

    // Undecryptable and truncated envelopes stay visible as locked rows instead of vanishing.
    expect(byFile.get(NAMES.undecryptable)).toMatchObject({ locked: true })
    expect(byFile.get(NAMES.truncated)).toMatchObject({ locked: true })
    // Oversized, a directory and any read that cannot happen are 'unavailable', not a crash and not a good row.
    expect(byFile.get(NAMES.oversized)).toMatchObject({ unavailable: true })
    expect(byFile.get(NAMES.directory)).toMatchObject({ unavailable: true })
    // A cloud-only file is listed from its name and never read.
    expect(byFile.get(NAMES.dataless)).toMatchObject({ notDownloaded: true })
    expect(reads.some((p) => basename(p) === NAMES.dataless)).toBe(false)
    // Never-a-meeting files do not appear at all.
    expect(byFile.has(NAMES.empty)).toBe(false)
    expect(byFile.has(NAMES.notAMeeting)).toBe(false)

    expect(rows).toHaveLength(2 + 5)
  })

  it('searches the good meetings and finds nothing in, and nothing from, the unusable files', async () => {
    const alpha = await searchMeetings(ALPHA.searchTerm)
    expect(alpha.hits.map((h) => h.file)).toEqual([good.alpha])
    expect(alpha.total).toBe(1)
    const french = await searchMeetings(FRENCH.searchTerm)
    expect(french.hits.map((h) => h.file)).toEqual([good.french])

    // The oversized file's body is never read, so its text cannot match; no search throws on any bad file.
    expect((await searchMeetings('filler')).total).toBe(0)
    expect((await searchMeetings('shopping')).total).toBe(0)
    expect(reads.some((p) => basename(p) === NAMES.dataless)).toBe(false)
  })

  it('reopens and exports every good meeting unchanged while the corrupt files sit beside them', async () => {
    for (const [g, file] of [
      [ALPHA, good.alpha],
      [FRENCH, good.french]
    ] as const) {
      const reopened = await recallRead(file)
      expect(reopened).toMatchObject({ ok: true, recap: g.meeting.recap.trim() })
      const text = await readSavedMeeting(folder, file)
      for (const fact of g.uniqueFacts) expect(occurrences(text, fact)).toBe(1)
      if (!reopened.ok) throw new Error('unreachable')
      expect(parseRecapMarkdown(reopened.recap ?? '')).toEqual({
        ...g.expectedExport,
        markdown: g.meeting.recap.trim()
      })
      expect(recapMarkdownToHtml(reopened.recap ?? '', g.expectedExport.title24)).toContain('<h2>')
    }
  })

  it.each([
    ['undecryptable', NAMES.undecryptable, /could not be decrypted/i, 'Could not export the meeting file.'],
    ['truncated', NAMES.truncated, /could not be decrypted/i, 'Could not export the meeting file.'],
    ['oversized', NAMES.oversized, /could not read/i, 'Could not export the meeting file.'],
    ['dataless', NAMES.dataless, /could not read/i, MEETING_NOT_DOWNLOADED_MSG]
  ])('%s: reopen and export fail with a named, path-free message and never throw past the handler', async (_k, name, reopenError, exportMessage) => {
    const reopened = await recallRead(name)
    expect(reopened.ok).toBe(false)
    if (!reopened.ok) {
      expect(reopened.error).toMatch(reopenError)
      expect(reopened.error).not.toContain(folder)
    }

    // History's "Export copy": either an empty decode (the handler refuses it) or a typed failure.
    const exported = await readSavedMeeting(folder, name).then(
      (text) => ({ text }),
      (error: unknown) => ({ message: exportFailureMessage(error) })
    )
    if ('text' in exported) expect(exported.text).toBe('')
    else {
      expect(exported.message).toBe(exportMessage)
      expect(exported.message).not.toContain(folder)
    }
  })

  describe('History "Open" on an unusable file', () => {
    let tempDir: string
    beforeEach(() => {
      tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'metis-corrupt-temp-')))
      ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'temp' ? tempDir : join(tempDir, name)
      )
    })
    afterEach(() => rmSync(tempDir, { recursive: true, force: true }))

    it.each([NAMES.undecryptable, NAMES.truncated])('%s opens a notice, never the broken bytes', async (name) => {
      const target = await meetingOpenTarget(folder, name)
      expect(target).toMatchObject({ ok: true, encrypted: true })
      if (!target.ok) throw new Error('unreachable')
      const shown = readFileSync(target.path, 'utf8')
      expect(shown).toContain("can't be opened here")
      expect(shown).not.toContain('not json')
      expect(shown.length).toBeGreaterThan(0)
    })

    it.each([
      NAMES.oversized,
      NAMES.dataless,
      NAMES.directory
    ])('%s is refused with the readable-file notice', async (name) => {
      expect(await meetingOpenTarget(folder, name)).toEqual({ ok: false, error: MEETING_NOT_READABLE_MSG })
      expect(reads.some((p) => basename(p) === NAMES.dataless)).toBe(false)
    })
  })

  it('editing, renaming away from or deleting a good meeting leaves the corrupt files and the other good one alone', async () => {
    await expect(updateMeetingRecap(testSettings, good.alpha, '## Overview\nEdited, synthetic.')).resolves.toEqual({
      ok: true
    })
    expect(await recallRead(good.alpha)).toMatchObject({ ok: true, recap: '## Overview\nEdited, synthetic.' })
    expect(await recallRead(good.french)).toMatchObject({ ok: true, recap: FRENCH.meeting.recap.trim() })

    // A recap edit aimed at a corrupt file refuses cleanly and changes nothing.
    for (const name of [NAMES.undecryptable, NAMES.truncated, NAMES.oversized]) {
      const result = await updateMeetingRecap(testSettings, name, '## Overview\nShould not land.')
      expect(result.ok).toBe(false)
    }

    await expect(deleteMeeting(good.alpha)).resolves.toMatchObject({ ok: true })
    const rows = await listMeetings()
    expect(rows.some((r) => r.file === good.alpha)).toBe(false)
    expect(rows.some((r) => r.file === good.french)).toBe(true)
    expect(rows).toHaveLength(1 + 5)
  })

  it('leaves every unusable file byte-identical and creates no quarantine or temp sibling', async () => {
    const before = readdirSync(folder).sort()
    await listMeetings()
    await searchMeetings('synthetic')
    for (const name of Object.values(NAMES)) {
      await recallRead(name)
      await readSavedMeeting(folder, name).catch(() => '')
    }
    await updateMeetingRecap(testSettings, NAMES.undecryptable, '## Overview\nnope').catch(() => undefined)

    for (const [name, digest] of bytesBefore) expect(sha(join(folder, name))).toBe(digest)
    expect(readdirSync(folder).sort()).toEqual(before)
    expect(statSync(join(folder, NAMES.directory)).isDirectory()).toBe(true)
  })

  it('a second listing and search are stable, so a cached verdict for a bad file never hides a good one', async () => {
    const first = (await listMeetings()).map((r) => r.file)
    const second = (await listMeetings()).map((r) => r.file)
    expect(second).toEqual(first)
    expect((await searchMeetings(ALPHA.searchTerm)).hits.map((h) => h.file)).toEqual([good.alpha])
    expect((await searchMeetings(ALPHA.searchTerm)).hits.map((h) => h.file)).toEqual([good.alpha])
  })
})
