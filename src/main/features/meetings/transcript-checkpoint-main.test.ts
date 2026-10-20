import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevisionEvent } from '@shared/contracts/speech/transcript-revision'
import type { SaveMeeting, Settings } from '@shared/ipc'
import { useStorageForTests } from '../../infra/storage/meetings-storage'
import {
  clearDraftTranscript,
  isEncryptedFile,
  readSavedFile,
  saveDraftTranscript,
  saveMeeting
} from '../../transcripts'
import { readMeetingFields, stripMeetingFrontmatter } from './meeting-document'
import { readRevisionCheckpoint } from './transcript-checkpoint'
import { bindTranscriptCheckpointStore, checkpointAfterDraftSave } from './transcript-checkpoint-binding'
import { writeTranscriptCheckpoint } from './transcript-checkpoint-main'
import { createTranscriptRevisionStore, type TranscriptStoreBinding } from './transcript-revision-store'

vi.mock('electron')

let nextStartedAt = 1_700_000_100_000

const final = (seq: number, language: string, text: string): RevisionEvent => ({
  kind: 'provider-final',
  relaySessionId: 'cap/1/1',
  providerSeq: seq,
  channel: 'system',
  text,
  language,
  startMs: seq * 1000,
  endMs: seq * 1000 + 900
})

describe('transcript checkpoint (production IO against real meeting files)', () => {
  let folder: string
  let settings: Settings
  let meeting: SaveMeeting
  let binding: TranscriptStoreBinding
  let unbind: (() => void) | undefined

  beforeEach(() => {
    useStorageForTests()
    folder = mkdtempSync(join(tmpdir(), 'metis-checkpoint-test-'))
    settings = { meetingsFolder: folder, autoSaveTranscripts: true } as Settings
    const startedAt = nextStartedAt
    nextStartedAt += 1_000
    meeting = {
      title: 'Standup',
      mode: 'meeting',
      startedAt,
      lines: [{ speaker: 'them', text: 'Where are we on the migration?', t: startedAt }],
      recap: ''
    }
    binding = { meetingStartedAt: startedAt, frameOwner: '12:3', owner: null }
  })

  afterEach(() => {
    unbind?.()
    unbind = undefined
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const make = () => {
    const store = createTranscriptRevisionStore({ checkpointWriter: writeTranscriptCheckpoint })
    unbind = bindTranscriptCheckpointStore(store)
    return store
  }
  /** What the draft IPC handler does: the autosave, then one checkpoint after a saved receipt. */
  const autosave = async () => {
    const result = await saveDraftTranscript(settings, meeting)
    if (result.status === 'saved') await checkpointAfterDraftSave(meeting.startedAt)
    return result
  }
  const draftPath = (): string => {
    const drafts = readdirSync(folder).filter((name) => name.startsWith('.autosave-draft-'))
    expect(drafts).toHaveLength(1)
    return join(folder, drafts[0])
  }
  const drafts = (): string[] => readdirSync(folder).filter((name) => name.startsWith('.autosave-draft-'))

  it('stamps each draft autosave with the store revision and keeps the draft body and status', async () => {
    const store = make()
    expect(store.open(binding)).toEqual({ ok: true })
    expect(store.apply(binding, final(0, 'en-US', 'hello')).ok).toBe(true)
    expect(store.apply(binding, final(1, 'fr', 'bonjour')).ok).toBe(true)
    await expect(saveDraftTranscript(settings, meeting)).resolves.toEqual({ status: 'saved' })
    const unstamped = readFileSync(draftPath(), 'utf8')

    await expect(autosave()).resolves.toEqual({ status: 'saved' })
    const text = readFileSync(draftPath(), 'utf8')
    const fields = readMeetingFields(text)
    expect(fields.type).toBe('meeting-transcript-draft')
    expect(fields.status).toBe('interrupted')
    expect(fields.transcriptRevision).toBe(String(store.snapshot(meeting.startedAt)?.revision))
    expect(fields.revisionSchema).toBe('1')
    expect(fields.segmentLanguages).toBe('en-US@0 fr@1')
    expect(stripMeetingFrontmatter(text)).toBe(stripMeetingFrontmatter(unstamped))

    // A later autosave rewrites the draft; the checkpoint stamps the newer revision onto it.
    expect(store.apply(binding, final(2, 'fr', 'merci')).ok).toBe(true)
    await autosave()
    const later = readRevisionCheckpoint(readFileSync(draftPath(), 'utf8'))
    expect(later?.revision).toBe(store.snapshot(meeting.startedAt)?.revision)
    expect(later?.languages).toEqual([
      { language: 'en-US', from: 0, to: 0 },
      { language: 'fr', from: 1, to: 2 }
    ])
  })

  it('writes the revision and per-segment languages into the saved meeting in the same write', async () => {
    const store = make()
    store.open(binding)
    store.apply(binding, final(0, 'en-US', 'hello'))
    store.apply(binding, final(1, 'pt-BR', 'oi'))
    const file = await saveMeeting(settings, meeting)
    const text = readFileSync(file, 'utf8')
    expect(readMeetingFields(text).type).toBe('meeting-transcript')
    expect(readMeetingFields(text).status).toBe('ready-for-followup')
    expect(readRevisionCheckpoint(text)).toEqual({
      revision: store.snapshot(meeting.startedAt)?.revision,
      schema: 1,
      languages: [
        { language: 'en-US', from: 0, to: 0 },
        { language: 'pt-BR', from: 1, to: 1 }
      ]
    })
    expect(text).toContain('Where are we on the migration?')
  })

  it('keeps the revision in an encrypted saved meeting', async () => {
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from(`B64:${Buffer.from(v, 'utf8').toString('base64')}`)
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
    const store = make()
    store.open(binding)
    store.apply(binding, final(0, 'en-US', 'hello'))
    const file = await saveMeeting({ ...settings, encryptTranscripts: true } as Settings, meeting)
    expect(isEncryptedFile(file)).toBe(true)
    expect(readFileSync(file).toString('utf8')).not.toContain('segmentLanguages')
    expect(readRevisionCheckpoint(readSavedFile(file))?.languages).toEqual([{ language: 'en-US', from: 0, to: 0 }])
  })

  it('keeps an encrypted draft encrypted when it is stamped', async () => {
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from(`B64:${Buffer.from(v, 'utf8').toString('base64')}`)
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
    settings = { ...settings, encryptTranscripts: true } as Settings
    const store = make()
    store.open(binding)
    store.apply(binding, final(0, 'en-US', 'hello'))
    await autosave()
    expect(isEncryptedFile(draftPath())).toBe(true)
    expect(readFileSync(draftPath()).toString('utf8')).not.toContain('Where are we on the migration?')
    expect(readRevisionCheckpoint(readSavedFile(draftPath()))?.revision).toBe(
      store.snapshot(meeting.startedAt)?.revision
    )
  })

  it('a summary-only save carries the revision but no per-segment language map', async () => {
    const store = make()
    store.open(binding)
    store.apply(binding, final(0, 'en-US', 'hello'))
    const managed = { ...settings, enterpriseLive: { managed: true, summaryOnly: true } } as unknown as Settings
    const file = await saveMeeting(managed, meeting)
    const text = readFileSync(file, 'utf8')
    expect(readMeetingFields(text).type).toBe('meeting-summary')
    expect(text).not.toContain('Where are we on the migration?')
    expect(readRevisionCheckpoint(text)).toEqual({
      revision: store.snapshot(meeting.startedAt)?.revision,
      schema: 1,
      languages: null
    })
  })

  it('never rewrites a draft once its meeting is sealed by the completed save', async () => {
    const store = make()
    store.open(binding)
    store.apply(binding, final(0, 'en-US', 'hello'))
    await saveDraftTranscript(settings, meeting)
    const file = await saveMeeting(settings, meeting)
    await clearDraftTranscript(settings, meeting.startedAt, file)
    await expect(store.checkpoint(meeting.startedAt)).resolves.toEqual({ ok: false, error: 'sealed' })
    expect(drafts()).toEqual([])
  })

  it('never creates a draft that was not autosaved', async () => {
    const store = make()
    store.open(binding)
    store.apply(binding, final(0, 'en-US', 'hello'))
    await expect(store.checkpoint(meeting.startedAt)).resolves.toEqual({ ok: false, error: 'absent' })
    expect(drafts()).toEqual([])
  })

  it('reports a tracked draft that disappeared as absent and does not recreate it', async () => {
    const store = make()
    store.open(binding)
    store.apply(binding, final(0, 'en-US', 'hello'))
    await saveDraftTranscript(settings, meeting)
    rmSync(draftPath())
    await expect(store.checkpoint(meeting.startedAt)).resolves.toEqual({ ok: false, error: 'absent' })
    expect(drafts()).toEqual([])
  })

  it('leaves a meeting with no open store entry unstamped (legacy revision 0)', async () => {
    make()
    const file = await saveMeeting(settings, meeting)
    expect(readRevisionCheckpoint(readFileSync(file, 'utf8'))).toBeNull()
    await autosave()
    expect(readRevisionCheckpoint(readFileSync(draftPath(), 'utf8'))).toBeNull()
  })

  it('a stale disposer never unbinds a newer store', async () => {
    const first = createTranscriptRevisionStore({ checkpointWriter: writeTranscriptCheckpoint })
    const disposeFirst = bindTranscriptCheckpointStore(first)
    const second = make()
    disposeFirst()
    second.open(binding)
    second.apply(binding, final(0, 'en-US', 'hello'))
    const file = await saveMeeting(settings, meeting)
    expect(readRevisionCheckpoint(readFileSync(file, 'utf8'))?.revision).toBe(
      second.snapshot(meeting.startedAt)?.revision
    )
  })

  it('a meeting saved with no store bound is unstamped', async () => {
    const file = await saveMeeting(settings, meeting)
    expect(readRevisionCheckpoint(readFileSync(file, 'utf8'))).toBeNull()
    await expect(checkpointAfterDraftSave(meeting.startedAt)).resolves.toBeNull()
  })
})
