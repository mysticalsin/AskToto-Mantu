import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveMeeting, Settings } from '@shared/ipc'
import type { TranscriptLine } from '@shared/transcript-line'
import { app, safeStorage } from 'electron'
import { resetSecretKeyCache } from '../../secrets'
import { draftFilename } from '../../infra/storage/draft-transcript-write-state'
import { useStorageForTests } from '../../infra/storage/meetings-storage'
import {
  clearDraftTranscript,
  discardDraftTranscript,
  isEncryptedFile,
  readSavedFile,
  saveDraftTranscript
} from '../../transcripts'
import { cloudLine, makeTempDir, OWNER_A, OWNER_B, realKeys, writeJournal } from './__fixtures__/live-journal-fixtures'
import { recoverOrphanDrafts } from './draft-recovery'
import { createJournalRecovery, type JournalRecoveryAuditRecord } from './journal-recovery'
import { bindLiveJournalLifecycle, type LiveJournalLifecycle } from './live-journal-lifecycle'
import { liveMeetingJournalDirectory, liveMeetingJournalId, type LiveJournalKeyCustody } from './live-meeting-journal'
import { readMeetingFields } from './meeting-document'
import { decodeStoredMeetingSpeech } from './meeting-speech'
import { installMeetingSpeechPolicy } from './meeting-speech-policy'
import { promoteDraftTranscript } from './draft-transcript-document'
import { stamp } from './transcript-document-format'

vi.mock('electron')

// Lets one test simulate a locked draft (Windows AV / OneDrive EPERM) without touching the real unlink retry
// helper's behaviour for every other test in this file.
const unlinkControl = vi.hoisted(() => ({ fail: false }))
vi.mock('../../infra/storage/draft-file-unlink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/storage/draft-file-unlink')>()
  return {
    ...actual,
    unlinkDraftFiles: async (files: readonly string[], isCurrent?: () => boolean) =>
      unlinkControl.fail ? { failed: [...files], pending: [] } : actual.unlinkDraftFiles(files, isCurrent)
  }
})

/** Unique per test: a cleared or discarded meeting identity stays sealed for the life of the module. */
let STARTED_AT = Date.parse('2026-10-21T15:00:00.000Z')
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>

let temp: ReturnType<typeof makeTempDir>
let userData: string
let folder: string
let settings: Settings
let owner: string | null
let allowed: boolean
let audits: JournalRecoveryAuditRecord[]
let unbind: (() => void) | undefined
let lifecycle: LiveJournalLifecycle

beforeEach(() => {
  STARTED_AT += 7_200_000
  temp = makeTempDir('metis-journal-relaunch-')
  userData = join(temp.path, 'userData')
  folder = join(temp.path, 'meetings')
  mkdirSync(userData, { recursive: true })
  mkdirSync(folder, { recursive: true })
  mockGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
  resetSecretKeyCache()
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
  useStorageForTests()
  installMeetingSpeechPolicy()
  settings = { meetingsFolder: folder, autoSaveTranscripts: true } as Settings
  owner = OWNER_A
  allowed = true
  audits = []
  unlinkControl.fail = false
})

afterEach(() => {
  unbind?.()
  unbind = undefined
  resetSecretKeyCache()
  temp.remove()
  vi.clearAllMocks()
})

function bind(overrides: Partial<Parameters<typeof createJournalRecovery>[0]> = {}): LiveJournalLifecycle {
  lifecycle = createJournalRecovery({
    userDataPath: () => userData,
    keys: realKeys,
    readsAllowed: () => allowed,
    currentOwnerKey: () => owner,
    closeSession: async () => undefined,
    journalIdsFor: () => [],
    liveJournalIds: () => [],
    audit: (record) => audits.push(record),
    ...overrides
  })
  unbind = bindLiveJournalLifecycle(lifecycle)
  return lifecycle
}

const lines = (from: number, to: number, startedAt = STARTED_AT): TranscriptLine[] =>
  Array.from({ length: to - from + 1 }, (_, i) => cloudLine(startedAt, from + i))

function meeting(meetingLines: TranscriptLine[], startedAt = STARTED_AT): SaveMeeting {
  return { title: 'Planning', mode: 'meeting', startedAt, lines: meetingLines, recap: '' } as SaveMeeting
}

async function writeDraft(meetingLines: TranscriptLine[], startedAt = STARTED_AT): Promise<string> {
  const result = await saveDraftTranscript(settings, meeting(meetingLines, startedAt))
  expect(result.status).toBe('saved')
  return readdirSync(folder).find((name) => name.startsWith('.autosave-draft-'))!
}

const recovered = (): string[] => readdirSync(folder).filter((name) => /-recovered(-\d+)?\.md$/.test(name))
const drafts = (): string[] => readdirSync(folder).filter((name) => name.startsWith('.autosave-draft-'))
const journalDirectory = (ownerKey: string | null = OWNER_A, startedAt = STARTED_AT): string =>
  liveMeetingJournalDirectory(userData, liveMeetingJournalId(startedAt, ownerKey))

function recoveredLines(name: string): TranscriptLine[] {
  const decoded = decodeStoredMeetingSpeech(readSavedFile(join(folder, name)))
  if (!decoded.ok || decoded.status !== 'valid') throw new Error('recovered meeting should carry a valid speech frame')
  return decoded.lines
}

describe('launch recovery merges the live meeting journal into an orphaned draft', () => {
  it('crash between autosaves: the draft plus the journal records it missed, ordered, with provenance intact', async () => {
    const draft = await writeDraft(lines(1, 2))
    await writeJournal({
      userData,
      startedAt: STARTED_AT,
      ownerKey: OWNER_A,
      lines: [...lines(1, 4), cloudLine(STARTED_AT, 120)]
    })
    bind()
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 1 })
    const [name] = recovered()
    const merged = recoveredLines(name)
    expect(merged.map((l) => l.speech?.type === 'segment' && l.speech.segment.index)).toEqual([1, 2, 3, 4, 120])
    expect(merged.map((l) => l.t)).toEqual([...merged.map((l) => l.t)].sort((a, b) => a - b))
    expect(merged[4]).toEqual(cloudLine(STARTED_AT, 120))
    const fields = readMeetingFields(readSavedFile(join(folder, name)))
    expect(fields.type).toBe('meeting-transcript')
    expect(fields.status).toBe('recovered')
    expect(fields.date).toBe(new Date(STARTED_AT).toISOString())
    // duration and participants describe the merged lines, not the stale draft
    expect(fields.duration_min).toBe('10')
    expect(fields.participants).toBe('Them')
    expect(drafts()).toEqual([])
    expect(existsSync(join(folder, draft))).toBe(false)
    expect(audits).toContainEqual({ outcome: 'merged', added: 3 })
    // the journal's records now live in the recovered file: its directory and key are gone
    expect(existsSync(journalDirectory())).toBe(false)
  })

  it('a second launch changes nothing (idempotent)', async () => {
    await writeDraft(lines(1, 2))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 4) })
    bind()
    await recoverOrphanDrafts(settings)
    const [name] = recovered()
    const before = readFileSync(join(folder, name))
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
    expect(recovered()).toEqual([name])
    expect(readFileSync(join(folder, name)).equals(before)).toBe(true)
  })

  it('draft newer than the journal: the recovered file is exactly what the draft alone produces', async () => {
    const name = await writeDraft(lines(1, 5))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 3) })
    bind()
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 1 })
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(existsSync(journalDirectory())).toBe(false)
  })

  it('the draft is authoritative: an edited speaker name survives and a line deleted earlier is not resurrected', async () => {
    const edited = lines(1, 4).filter((l) => l.speech?.type === 'segment' && l.speech.segment.index !== 2)
    edited[0] = { ...edited[0], name: 'Alice' }
    await writeDraft(edited)
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 6) })
    bind()
    await recoverOrphanDrafts(settings)
    const merged = recoveredLines(recovered()[0])
    expect(merged.map((l) => l.speech?.type === 'segment' && l.speech.segment.index)).toEqual([1, 3, 4, 5, 6])
    expect(merged[0].name).toBe('Alice')
  })

  it('a draft written before any final was committed takes the whole journal', async () => {
    await writeDraft([])
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 3) })
    bind()
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 1 })
    expect(recoveredLines(recovered()[0])).toHaveLength(3)
  })

  it('spoken text that looks like a replacement pattern is kept verbatim', async () => {
    await writeDraft([])
    const tricky = cloudLine(STARTED_AT, 1, 'it costs $& and $1 and $$ dollars')
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [tricky] })
    bind()
    await recoverOrphanDrafts(settings)
    expect(recoveredLines(recovered()[0])[0].text).toBe('it costs $& and $1 and $$ dollars')
  })

  it('a plain (unframed) draft is left exactly as it is and its journal is kept, never purged', async () => {
    const plain: TranscriptLine[] = [{ speaker: 'you', text: 'A local engine line.', t: STARTED_AT + 1_000 }]
    const name = await writeDraft(plain)
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 2) })
    bind()
    await recoverOrphanDrafts(settings)
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(existsSync(journalDirectory())).toBe(true)
    expect(audits).toContainEqual({ outcome: 'ignored', reason: 'unmergeable' })
  })

  it('a signed-out meeting journal is used when the current owner has none', async () => {
    await writeDraft(lines(1, 1))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: null, lines: lines(1, 3) })
    bind()
    await recoverOrphanDrafts(settings)
    expect(recoveredLines(recovered()[0])).toHaveLength(3)
    expect(existsSync(journalDirectory(null))).toBe(false)
  })
})

describe('what the journal is never trusted for', () => {
  it('another owner journal id is not used, not promoted and not touched', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_B, lines: lines(1, 6) })
    bind() // the current owner is OWNER_A
    await recoverOrphanDrafts(settings)
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(existsSync(journalDirectory(OWNER_B))).toBe(true)
  })

  it('another owner journal with no draft is not promoted either', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_B, lines: lines(1, 3) })
    bind()
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
    expect(recovered()).toEqual([])
    expect(existsSync(journalDirectory(OWNER_B))).toBe(true)
  })

  it('a corrupted record ignores the journal with an audit and leaves the draft path unchanged', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 5) })
    const records = join(journalDirectory(), 'records')
    const record = readdirSync(records).find((f) => f.startsWith('record-'))!
    const bytes = readFileSync(join(records, record))
    bytes[bytes.length - 3] ^= 0xff
    writeFileSync(join(records, record), bytes)
    bind()
    await recoverOrphanDrafts(settings)
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(audits).toEqual([{ outcome: 'ignored', reason: 'read-failed' }])
    expect(existsSync(journalDirectory())).toBe(true) // kept for the retention window
  })

  it('a tampered manifest ignores the journal', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 5) })
    const manifest = join(journalDirectory(), 'records', 'manifest.v1')
    const bytes = readFileSync(manifest)
    bytes[10] ^= 0xff
    writeFileSync(manifest, bytes)
    bind()
    await recoverOrphanDrafts(settings)
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(audits).toEqual([{ outcome: 'ignored', reason: 'manifest' }])
  })

  it('a key this device cannot unwrap ignores the journal with an audit', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 5) })
    const unwrap = vi.fn(() => ({
      ok: false as const,
      reason: 'unavailable' as const,
      error: new Error('foreign keychain')
    }))
    bind({ keys: { readFile: realKeys.readFile, unwrap } })
    await recoverOrphanDrafts(settings)
    expect(unwrap).toHaveBeenCalled()
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(audits).toEqual([{ outcome: 'ignored', reason: 'key-unwrap' }])
    expect(existsSync(journalDirectory())).toBe(true)
  })

  it('a missing or corrupt key file ignores the journal', async () => {
    await writeDraft(lines(1, 2))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 3) })
    writeFileSync(join(journalDirectory(), 'key.v1'), 'not json')
    bind()
    await recoverOrphanDrafts(settings)
    expect(recoveredLines(recovered()[0])).toHaveLength(2)
    expect(audits).toEqual([{ outcome: 'ignored', reason: 'key-unreadable' }])
  })

  it('a journal that is a symbolic link is refused and its target never read', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 4) })
    const real = journalDirectory()
    const moved = join(temp.path, 'moved')
    renameSync(real, moved)
    symlinkSync(moved, real, 'dir')
    bind()
    await recoverOrphanDrafts(settings)
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(audits).toEqual([{ outcome: 'ignored', reason: 'unsafe-path' }])
  })

  it('a finalized journal next to a leftover draft adds nothing', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 5) })
    bind()
    await lifecycle.end(STARTED_AT, 'finalized')
    await recoverOrphanDrafts(settings)
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(audits).toContainEqual({ outcome: 'ignored', reason: 'not-active' })
  })

  it('kill switch off: no key is read, no record is read, and the draft path is untouched', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 5) })
    allowed = false
    const readFile = vi.fn(realKeys.readFile)
    const unwrap = vi.fn(realKeys.unwrap)
    bind({ keys: { readFile, unwrap } as Pick<LiveJournalKeyCustody, 'readFile' | 'unwrap'> })
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 1 })
    expect(readFile).not.toHaveBeenCalled()
    expect(unwrap).not.toHaveBeenCalled()
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
    expect(audits).toEqual([])
    expect(existsSync(journalDirectory())).toBe(true)
  })

  it('with no journal bound at all, recovery is exactly the existing path', async () => {
    const name = await writeDraft(lines(1, 2))
    const expected = promoteDraftTranscript(readFileSync(join(folder, name), 'utf8'))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 5) })
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 1 })
    expect(readFileSync(join(folder, recovered()[0]), 'utf8')).toBe(expected)
  })
})

describe('journal-only promotion (the crash came before the first autosave)', () => {
  it('promotes a journal that has no draft into a recovered meeting and removes it', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 3) })
    bind()
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 1 })
    const [name] = recovered()
    expect(name).toMatch(/-000-recovered\.md$/)
    const text = readSavedFile(join(folder, name))
    const fields = readMeetingFields(text)
    expect(fields).toMatchObject({
      type: 'meeting-transcript',
      status: 'recovered',
      date: new Date(STARTED_AT).toISOString()
    })
    expect(text).toContain('Recovered meeting')
    expect(recoveredLines(name)).toEqual(lines(1, 3))
    expect(isEncryptedFile(join(folder, name))).toBe(false)
    expect(readFileSync(join(folder, 'index.md'), 'utf8')).toContain(name)
    expect(existsSync(journalDirectory())).toBe(false)
    expect(audits).toContainEqual({ outcome: 'promoted', records: 3 })
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
    expect(recovered()).toEqual([name])
  })

  it('is encrypted at rest when the user encrypts transcripts', async () => {
    settings = { ...settings, encryptTranscripts: true } as Settings
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 2) })
    bind()
    await recoverOrphanDrafts(settings)
    const [name] = recovered()
    expect(isEncryptedFile(join(folder, name))).toBe(true)
    expect(readFileSync(join(folder, name)).toString('utf8')).not.toContain('synthetic line')
    expect(recoveredLines(name)).toHaveLength(2)
  })

  it('does not duplicate a meeting that was already saved (the save finished, the purge did not)', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 3) })
    const iso = new Date(STARTED_AT).toISOString()
    writeFileSync(
      join(folder, `${stamp(STARTED_AT)}-planning.md`),
      `---\ntype: meeting-transcript\ndate: ${iso}\n---\n\nA saved meeting.\n`
    )
    bind()
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
    expect(recovered()).toEqual([])
  })

  it('a journal already sealed as finalized is never promoted, even when the save left no trace', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 3) })
    bind()
    await lifecycle.end(STARTED_AT, 'finalized') // the crash came after the seal and before the purge
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
    expect(recovered()).toEqual([])
    // the retention sweep removes a sealed journal at once, not after 14 days
    expect(existsSync(journalDirectory())).toBe(false)
  })

  it('kill switch off: nothing is promoted', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 3) })
    allowed = false
    bind()
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
    expect(recovered()).toEqual([])
    expect(existsSync(journalDirectory())).toBe(true)
  })
})

describe('purge on clear and discard (T7)', () => {
  it('clearDraftTranscript after a verified save seals then purges the journal and the draft', async () => {
    const name = await writeDraft(lines(1, 2))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 4) })
    const order: string[] = []
    const real = bind()
    bindLiveJournalLifecycle({
      ...real,
      end: async (startedAt, state) => {
        order.push(`end:${state}:${existsSync(journalDirectory())}:${existsSync(join(folder, name))}`)
        await real.end(startedAt, state)
      },
      purge: async (startedAt) => {
        order.push(`purge:${existsSync(join(folder, name))}`)
        await real.purge(startedAt)
      }
    })
    await clearDraftTranscript(settings, STARTED_AT, join(folder, 'saved.md'))
    // sealed while the journal and draft still exist; purged after the draft is unlinked
    expect(order).toEqual(['end:finalized:true:true', 'purge:false'])
    expect(existsSync(journalDirectory())).toBe(false)
    expect(drafts()).toEqual([])
  })

  it('a crash between the seal and the purge leaves a sealed journal that cannot be promoted', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 4) })
    bind()
    await lifecycle.end(STARTED_AT, 'finalized')
    expect(existsSync(journalDirectory())).toBe(true)
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
  })

  it('discardDraftTranscript purges the journal with the draft', async () => {
    await writeDraft(lines(1, 2))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 4) })
    bind()
    await expect(discardDraftTranscript(settings, STARTED_AT)).resolves.toEqual({ ok: true })
    expect(existsSync(journalDirectory())).toBe(false)
    expect(drafts()).toEqual([])
  })

  it('a Disregard whose draft unlink fails is not promoted on relaunch', async () => {
    const name = await writeDraft(lines(1, 2))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 4) })
    bind()
    unlinkControl.fail = true
    await expect(discardDraftTranscript(settings, STARTED_AT)).resolves.toEqual({
      ok: false,
      error: 'Some autosaved draft files could not be removed. Try Disregard again.'
    })
    // the draft survived, so its journal must too: it is the only durable record that the meeting was discarded
    expect(drafts()).toEqual([name])
    expect(existsSync(journalDirectory())).toBe(true)
    expect(existsSync(join(userData, 'meeting-journal'))).toBe(true)

    // relaunch: the lock is gone, recovery must retry the unlink and never promote the discarded speech
    unlinkControl.fail = false
    await expect(recoverOrphanDrafts(settings)).resolves.toEqual({ recovered: 0 })
    expect(recovered()).toEqual([])
    expect(drafts()).toEqual([])
    expect(existsSync(journalDirectory())).toBe(false)
  })

  it('a failing purge never fails the save cleanup or a Disregard', async () => {
    await writeDraft(lines(1, 2))
    const real = bind()
    bindLiveJournalLifecycle({
      ...real,
      end: async () => {
        throw new Error('seal failed')
      },
      purge: async () => {
        throw new Error('purge failed')
      }
    })
    await expect(discardDraftTranscript(settings, STARTED_AT)).resolves.toEqual({ ok: true })
    await expect(clearDraftTranscript(settings, STARTED_AT)).resolves.toBeUndefined()
    expect(drafts()).toEqual([])
  })

  it('purges with the kill switch off without reading any key', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 2) })
    allowed = false
    const readFile = vi.fn(realKeys.readFile)
    bind({ keys: { readFile, unwrap: realKeys.unwrap } })
    await clearDraftTranscript(settings, STARTED_AT)
    expect(readFile).not.toHaveBeenCalled()
    expect(existsSync(journalDirectory())).toBe(false)
  })

  it('a clear or discard with no journal bound is exactly the existing behaviour', async () => {
    await writeDraft(lines(1, 2))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: lines(1, 2) })
    await expect(discardDraftTranscript(settings, STARTED_AT)).resolves.toEqual({ ok: true })
    expect(existsSync(journalDirectory())).toBe(true)
  })
})

describe('retention sweep (T7)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-11-30T00:00:00.000Z')
  const startOf = (n: number): number => STARTED_AT + n * 60_000

  async function seed(n: number, ageDays: number, ownerKey: string | null = OWNER_A): Promise<string> {
    const startedAt = startOf(n)
    await writeJournal({ userData, startedAt, ownerKey, lines: lines(1, 1, startedAt) })
    const directory = journalDirectory(ownerKey, startedAt)
    const when = new Date(NOW - ageDays * DAY)
    for (const path of [directory, join(directory, 'records')]) utimesSync(path, when, when)
    return directory
  }

  const context = (overrides: { draftNames?: string[] } = {}) => ({
    draftNames: overrides.draftNames ?? [],
    meetingExists: async () => true, // keep the sweep tests about retention, not promotion
    promote: async () => false
  })

  it('removes journals older than 14 days and keeps younger ones, oldest first', async () => {
    const old = await seed(1, 15)
    const recent = await seed(2, 13)
    bind({ now: () => NOW })
    await lifecycle.recoverRemaining(context())
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(audits).toContainEqual({ outcome: 'swept', removed: 1, kept: 1 })
  })

  it('keeps only the newest 10 journals', async () => {
    const directories: string[] = []
    for (let n = 0; n < 12; n++) directories.push(await seed(n, 12 - n * 0.5)) // n=0 oldest ... n=11 newest
    bind({ now: () => NOW })
    await lifecycle.recoverRemaining(context())
    expect(directories.map((d) => existsSync(d))).toEqual([false, false, ...Array.from({ length: 10 }, () => true)])
  })

  it('never removes a journal whose meeting still has a draft, however old', async () => {
    const protectedDirectory = await seed(1, 40)
    const draftName = draftFilename(startOf(1), stamp(startOf(1)))
    const orphan = await seed(2, 40)
    bind({ now: () => NOW })
    await lifecycle.recoverRemaining(context({ draftNames: [draftName] }))
    expect(existsSync(protectedDirectory)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it('never removes a journal whose meeting is live', async () => {
    const live = await seed(1, 40)
    bind({ now: () => NOW, liveJournalIds: () => [liveMeetingJournalId(startOf(1), OWNER_A)] })
    await lifecycle.recoverRemaining(context())
    expect(existsSync(live)).toBe(true)
  })

  it('removes a sealed (finalized or discarded) journal regardless of age', async () => {
    const sealed = await seed(1, 1)
    const open = await seed(2, 1)
    const discarded = await seed(3, 1)
    bind({ now: () => NOW })
    await lifecycle.end(startOf(1), 'finalized')
    await lifecycle.end(startOf(3), 'discarded')
    await lifecycle.recoverRemaining(context())
    expect(existsSync(sealed)).toBe(false)
    expect(existsSync(discarded)).toBe(false)
    expect(existsSync(open)).toBe(true)
  })

  it('never removes an unpromoted active journal by the count rule', async () => {
    const directories: string[] = []
    for (let n = 0; n < 12; n++) directories.push(await seed(n, 12 - n * 0.5))
    bind({ now: () => NOW })
    // no meeting exists for any of them and promotion keeps failing: the journal is the only copy of the speech
    await lifecycle.recoverRemaining({ draftNames: [], meetingExists: async () => false, promote: async () => false })
    expect(directories.map((d) => existsSync(d))).toEqual(Array.from({ length: 12 }, () => true))
  })

  it('still applies the 14-day age rule to an unpromoted active journal', async () => {
    const old = await seed(1, 20)
    const recent = await seed(2, 2)
    bind({ now: () => NOW })
    await lifecycle.recoverRemaining({ draftNames: [], meetingExists: async () => false, promote: async () => false })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it('never follows a symbolic link planted as a journal directory', async () => {
    const outside = join(temp.path, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.md'), 'keep me')
    const planted = liveMeetingJournalDirectory(userData, liveMeetingJournalId(startOf(9), OWNER_A))
    mkdirSync(join(userData, 'meeting-journal'), { recursive: true })
    symlinkSync(outside, planted, 'dir')
    // an ancient link is a candidate for the age rule, so the purge's own refusal is what protects the target
    bind({ now: () => NOW })
    await lifecycle.recoverRemaining(context())
    expect(readFileSync(join(outside, 'precious.md'), 'utf8')).toBe('keep me')
    expect(existsSync(planted)).toBe(true)
  })

  it('audit records carry enums and counts only, never content, keys or paths', async () => {
    await seed(1, 20)
    bind({ now: () => NOW })
    await lifecycle.recoverRemaining(context())
    const serialized = JSON.stringify(audits)
    expect(serialized).not.toContain('synthetic line')
    expect(serialized).not.toContain(userData)
    expect(serialized).not.toContain(OWNER_A)
    for (const record of audits) {
      for (const value of Object.values(record)) expect(['string', 'number']).toContain(typeof value)
    }
  })
})
