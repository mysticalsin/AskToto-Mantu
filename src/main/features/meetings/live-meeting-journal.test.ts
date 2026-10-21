import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { TranscriptLine } from '@shared/transcript-line'
import { app, safeStorage } from 'electron'
import { resetSecretKeyCache } from '../../secrets'
import {
  generateContentKey,
  readWrappedKeyFile,
  unwrapContentKey,
  wrapContentKey,
  writeWrappedKeyFile
} from '../../infra/security/content-key-wrap'
import { createStorageGateway } from '../../infra/storage/gateway'
import type { ContentPresence, DatalessDetector } from '../../infra/storage/dataless'
import { createIncrementalMeetingJournalFileStorage } from './incremental-meeting-journal-files'
import { withIncrementalMeetingMutation } from './incremental-meeting-mutation-lock'
import {
  createLiveMeetingJournal,
  liveMeetingJournalDirectory,
  liveMeetingJournalId,
  type LiveJournalKeyCustody,
  type LiveMeetingJournalDeps
} from './live-meeting-journal'
import { LIVE_MEETING_JOURNAL_LIMITS, LIVE_MEETING_JOURNAL_STORAGE_BUDGET } from './live-meeting-journal-policy'

vi.mock('electron')

const mockGetPath = app.getPath as ReturnType<typeof vi.fn>
const STARTED_AT = Date.parse('2026-10-21T15:00:00.000Z')
const CAPTURE_ID = '11111111-1111-4111-8111-111111111111'
const FRAME = '7:3'
const OWNER = 'a'.repeat(64)
const SECRET_PHRASE = 'confidential acquisition of Contoso for nine figures'

let userData: string
let bindings: Map<number, { frameOwner: string; ownerKey: string | null }>
let authGeneration: number
let enabled: boolean
let audit: ReturnType<typeof vi.fn>

const realKeys: LiveJournalKeyCustody = {
  generate: generateContentKey,
  wrap: wrapContentKey,
  unwrap: (wrapped) => unwrapContentKey(wrapped),
  writeFile: writeWrappedKeyFile,
  readFile: readWrappedKeyFile
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'metis-live-journal-'))
  mockGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
  resetSecretKeyCache()
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
  bindings = new Map([[STARTED_AT, { frameOwner: FRAME, ownerKey: OWNER }]])
  authGeneration = 1
  enabled = true
  audit = vi.fn()
})

afterEach(() => {
  resetSecretKeyCache()
  rmSync(userData, { recursive: true, force: true })
  vi.clearAllMocks()
})

function journalWith(overrides: Partial<LiveMeetingJournalDeps> = {}) {
  return createLiveMeetingJournal({
    userDataPath: () => userData,
    enabled: () => enabled,
    bindingOf: (startedAt) => bindings.get(startedAt) ?? null,
    authGeneration: () => authGeneration,
    keys: realKeys,
    audit: audit as unknown as LiveMeetingJournalDeps['audit'],
    ...overrides
  })
}

function cloudLine(index: number, text = `line number ${index} said something ordinary`): TranscriptLine {
  const words = text.split(' ').map((word, position) => ({
    text: word,
    language: 'en',
    startMs: index * 5_000 + position * 100,
    endMs: index * 5_000 + position * 100 + 80
  }))
  const speech: Extract<CloudSpeechEvent, { type: 'segment' }> = {
    type: 'segment',
    captureId: CAPTURE_ID,
    captureGeneration: 2,
    sequence: index * 3,
    segment: {
      stream: { generation: 2, track: 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index,
      revision: 1,
      final: true,
      text,
      startMs: index * 5_000,
      endMs: index * 5_000 + 4_900
    },
    languages: ['en'],
    words
  }
  return { speaker: 'them', text, t: STARTED_AT + index * 5_000, lang: 'English', speech }
}

const input = (line: TranscriptLine, frameOwner = FRAME, startedAt = STARTED_AT) => ({ startedAt, frameOwner, line })

function files(dir: string): Array<[string, number]> {
  const out: Array<[string, number]> = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else out.push([relative(dir, full), stat.size])
    }
  }
  walk(dir)
  return out
}

const journalDir = (ownerKey: string | null = OWNER, startedAt = STARTED_AT) =>
  liveMeetingJournalDirectory(userData, liveMeetingJournalId(startedAt, ownerKey))

function detector(): DatalessDetector {
  return { classify: async (list) => new Map(list.map((file): [string, ContentPresence] => [file.path, 'local'])) }
}

/** Reopens the journal read-only the way recovery will: unwrap key.v1, open the records dir, page the records out. */
async function readBack(ownerKey: string | null = OWNER) {
  const directory = journalDir(ownerKey)
  const stored = await readWrappedKeyFile(join(directory, 'key.v1'))
  if (!stored.ok) throw new Error('key file should exist')
  const unwrapped = unwrapContentKey(stored.wrapped)
  if (!unwrapped.ok) throw new Error('key should unwrap on this device')
  const records = join(directory, 'records')
  const storage = createIncrementalMeetingJournalFileStorage({
    root: records,
    meetingId: liveMeetingJournalId(STARTED_AT, ownerKey),
    key: Uint8Array.from(unwrapped.key),
    maxJournalBytes: LIVE_MEETING_JOURNAL_LIMITS.maxJournalBytes,
    ...LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
    isCurrent: () => true,
    gateway: createStorageGateway({ root: () => records, detector: detector() })
  })
  if (!storage) throw new Error('journal should reopen')
  const snapshot = await storage.initialize()
  if (snapshot.status !== 'ok') throw new Error('journal should initialise')
  const lines: Array<{ revision: number; record: { identity: { segmentIndex: number }; line: TranscriptLine } }> = []
  const page = await storage.readPage(
    0,
    snapshot.snapshot.acceptedRevision,
    128,
    (record) => {
      lines.push({
        revision: record.revision,
        record: JSON.parse(Buffer.from(record.canonicalBytes).toString('utf8'))
      })
    },
    () => true
  )
  storage.dispose()
  unwrapped.key.fill(0)
  return { snapshot: snapshot.snapshot, page, lines }
}

describe('liveMeetingJournalId', () => {
  it('is a deterministic, owner-scoped version-8 UUID the journal format accepts', () => {
    const id = liveMeetingJournalId(STARTED_AT, OWNER)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(liveMeetingJournalId(STARTED_AT, OWNER)).toBe(id)
    expect(liveMeetingJournalId(STARTED_AT + 1, OWNER)).not.toBe(id)
    expect(liveMeetingJournalId(STARTED_AT, 'b'.repeat(64))).not.toBe(id)
    expect(liveMeetingJournalId(STARTED_AT, null)).not.toBe(id)
    expect(id).not.toContain(OWNER.slice(0, 8))
  })
})

describe('live meeting journal session', () => {
  it('appends a cloud final durably under the documented layout with key.v1 outside the records root', async () => {
    const journal = journalWith()
    await expect(journal.append(input(cloudLine(1)))).resolves.toEqual({ status: 'durable', duplicate: false })
    const directory = journalDir()
    const tree = files(directory).map(([name]) => name)
    expect(tree).toContain('key.v1')
    expect(tree.filter((name) => !name.startsWith('records/') && name !== 'key.v1')).toEqual([])
    expect(tree.some((name) => name.startsWith('records/record-'))).toBe(true)
    expect(tree).toContain('records/manifest.v1')
    expect(statSync(join(directory, 'key.v1')).mode & 0o777).toBe(0o600)
    await journal.dispose()

    const back = await readBack()
    expect(back.snapshot).toMatchObject({ acceptedRevision: 1, recordCount: 1, wordCount: 6 })
    expect(back.lines[0]?.record.line.text).toBe(cloudLine(1).text)
    expect(back.lines[0]?.record.line.speech?.type).toBe('segment')
  })

  it('stores nothing in the clear: no transcript text, word text or key material in any file under the journal', async () => {
    const journal = journalWith()
    const line = cloudLine(1, SECRET_PHRASE)
    await expect(journal.append(input(line))).resolves.toMatchObject({ status: 'durable' })
    await journal.dispose()

    const directory = journalDir()
    const keyFile = readFileSync(join(directory, 'key.v1'))
    const stored = await readWrappedKeyFile(join(directory, 'key.v1'))
    expect(stored).toMatchObject({ ok: true })
    if (!stored.ok) return
    const unwrapped = unwrapContentKey(stored.wrapped)
    expect(unwrapped).toMatchObject({ ok: true })
    if (!unwrapped.ok) return
    expect(unwrapped.key.byteLength).toBe(32)
    // The key file carries only the wrapped form, never the raw key in any encoding.
    expect(keyFile.includes(unwrapped.key)).toBe(false)
    expect(keyFile.toString('utf8')).not.toContain(unwrapped.key.toString('base64'))
    expect(keyFile.toString('utf8')).not.toContain(unwrapped.key.toString('hex'))
    expect(JSON.parse(keyFile.toString('utf8'))).toEqual({ v: 1, kLocal: expect.stringMatching(/^[SF]:/) })

    const needles = [SECRET_PHRASE, 'Contoso', 'acquisition', 'nine figures', 'deepgram', CAPTURE_ID, 'English']
    for (const [name] of files(directory)) {
      if (name === 'key.v1') continue
      const bytes = readFileSync(join(directory, name))
      for (const needle of needles) expect(bytes.includes(Buffer.from(needle)), `${name} leaks ${needle}`).toBe(false)
      expect(bytes.includes(unwrapped.key), `${name} contains the raw key`).toBe(false)
    }
    unwrapped.key.fill(0)
  })

  it('serialises concurrent appends in arrival order with strictly increasing revisions', async () => {
    const journal = journalWith()
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map((index) => journal.append(input(cloudLine(index)))))
    expect(outcomes.every((outcome) => outcome.status === 'durable')).toBe(true)
    await journal.dispose()
    const back = await readBack()
    expect(back.page).toMatchObject({ status: 'ok', durableRevision: 5, complete: true })
    expect(back.lines.map((entry) => entry.revision)).toEqual([1, 2, 3, 4, 5])
    expect(back.lines.map((entry) => entry.record.identity.segmentIndex)).toEqual([1, 2, 3, 4, 5])
  })

  it('treats an exact retry as a duplicate that does not advance the revision, and refuses a conflicting identity', async () => {
    const journal = journalWith()
    await journal.append(input(cloudLine(1)))
    await expect(journal.append(input(cloudLine(1)))).resolves.toEqual({ status: 'durable', duplicate: true })
    await expect(journal.append(input(cloudLine(2)))).resolves.toEqual({ status: 'durable', duplicate: false })
    // Same segment identity, different content: never overwrites, recorded as a refusal.
    await expect(journal.append(input(cloudLine(2, 'a different transcript for the same segment')))).resolves.toEqual({
      status: 'refused',
      reason: 'CONFLICTING_IDENTITY'
    })
    await journal.dispose()
    const back = await readBack()
    expect(back.snapshot).toMatchObject({ acceptedRevision: 2, recordCount: 2 })
    expect(audit).toHaveBeenCalledWith('meeting.journal.degraded', { reason: 'CONFLICTING_IDENTITY', count: 1 })
  })

  it('reopens an existing journal after the meeting session ends and continues its revisions with the same key', async () => {
    const journal = journalWith()
    await journal.append(input(cloudLine(1)))
    await journal.close(STARTED_AT)
    expect(journal.activeMeetings()).toEqual([])
    const keyBefore = readFileSync(join(journalDir(), 'key.v1'))
    await expect(journal.append(input(cloudLine(2)))).resolves.toEqual({ status: 'durable', duplicate: false })
    expect(readFileSync(join(journalDir(), 'key.v1')).equals(keyBefore)).toBe(true)
    await journal.dispose()
    const back = await readBack()
    expect(back.lines.map((entry) => entry.revision)).toEqual([1, 2])
  })

  describe('ownership and staleness refusals', () => {
    it('refuses a frame that does not own the meeting, an unopened meeting, and a closed one, touching no disk', async () => {
      const journal = journalWith()
      await expect(journal.append(input(cloudLine(1), '9:9'))).resolves.toEqual({
        status: 'refused',
        reason: 'NOT_OWNER'
      })
      await expect(journal.append(input(cloudLine(1), FRAME, STARTED_AT + 5))).resolves.toEqual({
        status: 'refused',
        reason: 'NOT_OWNER'
      })
      bindings.delete(STARTED_AT)
      await expect(journal.append(input(cloudLine(1)))).resolves.toEqual({ status: 'refused', reason: 'NOT_OWNER' })
      expect(readdirSync(userData).filter((name) => name === 'meeting-journal')).toEqual([])
    })

    it('refuses with STALE_OWNER and leaves the files unchanged when the meeting closes before the commit', async () => {
      const journal = journalWith()
      await journal.append(input(cloudLine(1)))
      const before = files(journalDir())
      const pending = journal.append(input(cloudLine(2)))
      bindings.delete(STARTED_AT) // the store closed the meeting while the append was queued
      await expect(pending).resolves.toEqual({ status: 'refused', reason: 'STALE_OWNER' })
      expect(files(journalDir())).toEqual(before)
      await journal.dispose()
    })

    it('refuses with STALE_OWNER when the auth generation changed', async () => {
      const journal = journalWith()
      await journal.append(input(cloudLine(1)))
      authGeneration = 2
      await expect(journal.append(input(cloudLine(2)))).resolves.toMatchObject({
        status: 'refused',
        reason: 'STALE_OWNER'
      })
      await journal.dispose()
    })

    it('maps a busy mutation lock to UNAVAILABLE and stays consistent: the next append lands at the next revision', async () => {
      const journal = journalWith()
      await journal.append(input(cloudLine(1)))
      const key = `${realpathSync(join(journalDir(), 'records'))}\0${liveMeetingJournalId(STARTED_AT, OWNER)}`
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      // One active mutation and one waiter occupy the lock; a third caller is refused `busy`.
      const holders = [
        withIncrementalMeetingMutation(
          key,
          () => true,
          () => gate
        ),
        withIncrementalMeetingMutation(
          key,
          () => true,
          () => gate
        )
      ]
      await Promise.resolve()
      await expect(journal.append(input(cloudLine(2)))).resolves.toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
      release()
      await Promise.all(holders)
      await expect(journal.append(input(cloudLine(3)))).resolves.toEqual({ status: 'durable', duplicate: false })
      await journal.dispose()
      const back = await readBack()
      expect(back.lines.map((entry) => entry.record.identity.segmentIndex)).toEqual([1, 3])
      expect(back.lines.map((entry) => entry.revision)).toEqual([1, 2])
    })
  })

  describe('queue overflow', () => {
    it('refuses the append beyond the per-meeting queue, counts it, audits once, and still persists the queued ones', async () => {
      const journal = journalWith({ queueMax: 2 })
      // The store is not open yet, so nothing drains: the first two wait, the rest overflow immediately.
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map((index) => journal.append(input(cloudLine(index)))))
      expect(results.map((result) => result.status)).toEqual([
        'durable',
        'durable',
        'refused',
        'refused',
        'refused',
        'refused'
      ])
      expect(results.slice(2).every((result) => result.status === 'refused' && result.reason === 'QUEUE_FULL')).toBe(
        true
      )
      expect(
        audit.mock.calls.filter(
          ([event, record]) => event === 'meeting.journal.degraded' && record.reason === 'QUEUE_FULL'
        )
      ).toEqual([['meeting.journal.degraded', { reason: 'QUEUE_FULL', count: 1 }]])
      await journal.dispose()
      const back = await readBack()
      expect(back.lines.map((entry) => entry.record.identity.segmentIndex)).toEqual([1, 2])
    })

    it('uses the owner-approved bound of 64 by default', async () => {
      const journal = journalWith()
      const results = await Promise.all(
        Array.from({ length: 70 }, (_, index) => journal.append(input(cloudLine(index + 1))))
      )
      expect(results.filter((result) => result.status === 'durable')).toHaveLength(64)
      expect(results.filter((result) => result.status === 'refused' && result.reason === 'QUEUE_FULL')).toHaveLength(6)
      await journal.dispose()
    })
  })

  describe('kill switch and gates', () => {
    it('does no journal I/O at all when disabled: no directory, no key custody call, no audit', async () => {
      enabled = false
      const keys: LiveJournalKeyCustody = {
        generate: vi.fn(realKeys.generate),
        wrap: vi.fn(realKeys.wrap),
        unwrap: vi.fn(realKeys.unwrap),
        writeFile: vi.fn(realKeys.writeFile),
        readFile: vi.fn(realKeys.readFile)
      }
      const journal = journalWith({ keys })
      await expect(journal.append(input(cloudLine(1)))).resolves.toEqual({ status: 'refused', reason: 'DISABLED' })
      expect(readdirSync(userData)).toEqual([])
      for (const fn of Object.values(keys)) expect(fn).not.toHaveBeenCalled()
      expect(audit).not.toHaveBeenCalled()
      expect(journal.activeMeetings()).toEqual([])
    })

    it('stops mid-meeting when switched off: the session ends and later appends touch nothing', async () => {
      const journal = journalWith()
      await journal.append(input(cloudLine(1)))
      const before = files(journalDir())
      enabled = false
      await expect(journal.append(input(cloudLine(2)))).resolves.toEqual({ status: 'refused', reason: 'DISABLED' })
      expect(files(journalDir())).toEqual(before)
      await journal.dispose()
      expect(journal.activeMeetings()).toEqual([])
    })

    it('journals only cloud finals: a local line or a provisional line is refused INVALID_RECORD', async () => {
      const journal = journalWith()
      const local: TranscriptLine = { speaker: 'you', text: 'local engine line', t: STARTED_AT + 1 }
      await expect(journal.append(input(local))).resolves.toEqual({ status: 'refused', reason: 'INVALID_RECORD' })
      const provisional: TranscriptLine = { ...local, provisional: true }
      await expect(journal.append(input(provisional))).resolves.toEqual({ status: 'refused', reason: 'INVALID_RECORD' })
      expect(readdirSync(userData)).toEqual([])
    })
  })

  describe('fail closed and never throw into capture', () => {
    it('never writes a plaintext key: a wrap failure refuses and leaves no key file or records', async () => {
      const journal = journalWith({
        keys: { ...realKeys, wrap: () => ({ ok: false, reason: 'unavailable', error: new Error('no keychain') }) }
      })
      await expect(journal.append(input(cloudLine(1)))).resolves.toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
      const tree = files(journalDir()).map(([name]) => name)
      expect(tree).toEqual([])
      await journal.dispose()
    })

    it('refuses instead of starting a new key over records whose key file is missing', async () => {
      const first = journalWith()
      await first.append(input(cloudLine(1)))
      await first.dispose()
      rmSync(join(journalDir(), 'key.v1'))
      const second = journalWith()
      await expect(second.append(input(cloudLine(2)))).resolves.toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
      expect(files(journalDir()).some(([name]) => name === 'key.v1')).toBe(false)
      await second.dispose()
    })

    it('refuses instead of replacing a key file this device cannot unwrap', async () => {
      const first = journalWith()
      await first.append(input(cloudLine(1)))
      await first.dispose()
      writeFileSync(join(journalDir(), 'key.v1'), '{"v":1,"kLocal":"F:AAAA"}')
      const second = journalWith()
      await expect(second.append(input(cloudLine(2)))).resolves.toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
      expect(readFileSync(join(journalDir(), 'key.v1'), 'utf8')).toBe('{"v":1,"kLocal":"F:AAAA"}')
      await second.dispose()
    })

    it('does not retry a failed open on every final', async () => {
      let now = 1_000
      const readFile = vi.fn(async () => ({
        ok: false as const,
        reason: 'unavailable' as const,
        error: new Error('io')
      }))
      const journal = journalWith({ keys: { ...realKeys, readFile }, now: () => now })
      await expect(journal.append(input(cloudLine(1)))).resolves.toMatchObject({ status: 'refused' })
      await expect(journal.append(input(cloudLine(2)))).resolves.toMatchObject({ status: 'refused' })
      expect(readFile).toHaveBeenCalledTimes(1)
      now += 20_000
      await journal.append(input(cloudLine(3)))
      expect(readFile).toHaveBeenCalledTimes(2)
    })

    it('resolves, never rejects, when key custody or the audit sink throws', async () => {
      const journal = journalWith({
        keys: {
          ...realKeys,
          readFile: () => {
            throw new Error('custody exploded')
          }
        },
        audit: () => {
          throw new Error('audit exploded')
        }
      })
      await expect(journal.append(input(cloudLine(1)))).resolves.toEqual({ status: 'refused', reason: 'UNAVAILABLE' })
    })
  })

  describe('session lifecycle', () => {
    it('closeOwnedBy ends only that owner and keeps a signed-out meeting alive', async () => {
      const otherStart = STARTED_AT + 60_000
      const journal = journalWith()
      await journal.append(input(cloudLine(1)))
      expect(journal.activeMeetings()).toEqual([STARTED_AT])
      await journal.closeOwnedBy('c'.repeat(64))
      expect(journal.activeMeetings()).toEqual([STARTED_AT])
      await journal.closeOwnedBy(OWNER)
      expect(journal.activeMeetings()).toEqual([])
      bindings.set(otherStart, { frameOwner: FRAME, ownerKey: null })
      await journal.append(input(cloudLine(1), FRAME, otherStart))
      await journal.closeOwnedBy(OWNER)
      expect(journal.activeMeetings()).toEqual([otherStart])
      await journal.dispose()
    })

    it('sweeps the session of a meeting the store has already closed when the next meeting appends', async () => {
      const next = STARTED_AT + 3_600_000
      const journal = journalWith()
      await journal.append(input(cloudLine(1)))
      bindings.delete(STARTED_AT)
      bindings.set(next, { frameOwner: FRAME, ownerKey: OWNER })
      await journal.append(input(cloudLine(1), FRAME, next))
      expect(journal.activeMeetings()).toEqual([next])
      await journal.dispose()
    })

    it('dispose settles an in-flight append and leaves no session', async () => {
      const journal = journalWith()
      const pending = journal.append(input(cloudLine(1)))
      await journal.dispose()
      await expect(pending).resolves.toMatchObject({ status: 'refused' })
      expect(journal.activeMeetings()).toEqual([])
    })

    it('creates the userData directory tree with owner-only permissions', async () => {
      const journal = journalWith()
      await journal.append(input(cloudLine(1)))
      const root = join(userData, 'meeting-journal')
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(journalDir()).mode & 0o777).toBe(0o700)
      expect(statSync(join(journalDir(), 'records')).mode & 0o777).toBe(0o700)
      await journal.dispose()
    })
  })
})
