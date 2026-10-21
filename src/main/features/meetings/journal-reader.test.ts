import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, safeStorage } from 'electron'
import { resetSecretKeyCache } from '../../secrets'
import { cloudLine, makeTempDir, OWNER_A, OWNER_B, realKeys, writeJournal } from './__fixtures__/live-journal-fixtures'
import {
  lineIdentityKey,
  listJournalIds,
  openJournal,
  ownerCandidates,
  readJournal,
  readJournalForMeeting,
  readJournalState,
  readVerifiedJournalStart,
  type JournalReaderDeps
} from './journal-reader'
import { liveMeetingJournalDirectory, liveMeetingJournalId } from './live-meeting-journal'

vi.mock('electron')

const STARTED_AT = Date.parse('2026-10-21T15:00:00.000Z')
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>

let temp: ReturnType<typeof makeTempDir>
let userData: string
let allowed: boolean

const deps = (overrides: Partial<JournalReaderDeps> = {}): JournalReaderDeps => ({
  userDataPath: () => userData,
  keys: realKeys,
  readsAllowed: () => allowed,
  ...overrides
})
const idFor = (ownerKey: string | null = OWNER_A, startedAt = STARTED_AT): string =>
  liveMeetingJournalId(startedAt, ownerKey)
const directoryFor = (ownerKey: string | null = OWNER_A, startedAt = STARTED_AT): string =>
  liveMeetingJournalDirectory(userData, idFor(ownerKey, startedAt))

beforeEach(() => {
  temp = makeTempDir('metis-journal-reader-')
  userData = join(temp.path, 'userData')
  mkdirSync(userData, { recursive: true })
  mockGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
  resetSecretKeyCache()
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
  allowed = true
})

afterEach(() => {
  resetSecretKeyCache()
  temp.remove()
  vi.clearAllMocks()
})

describe('readJournal', () => {
  it('reads every durable record in revision order with its identity', async () => {
    const lines = [1, 2, 3].map((n) => cloudLine(STARTED_AT, n))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines })
    const read = await readJournal(deps(), idFor())
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.state).toBe('active')
    expect(read.records.map((r) => r.revision)).toEqual([1, 2, 3])
    expect(read.records.map((r) => r.line)).toEqual(lines)
    expect(read.records.map((r) => r.identityKey)).toEqual(lines.map(lineIdentityKey))
  })

  it('pages past one page of records (more than 128) without losing or reordering any', async () => {
    const lines = Array.from({ length: 131 }, (_, n) => cloudLine(STARTED_AT, n + 1, `short ${n + 1}`))
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines })
    const read = await readJournal(deps(), idFor())
    expect(read.status === 'ok' && read.records.map((r) => r.revision)).toEqual(lines.map((_, n) => n + 1))
  }, 120_000)

  it('is absent when there is no journal root or no journal for the id', async () => {
    await expect(readJournal(deps(), idFor())).resolves.toEqual({ status: 'absent' })
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    await expect(readJournal(deps(), idFor(OWNER_B))).resolves.toEqual({ status: 'absent' })
  })

  it('reads nothing, and unwraps no key, while reads are not allowed', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    allowed = false
    const readFile = vi.fn(realKeys.readFile)
    const unwrap = vi.fn(realKeys.unwrap)
    await expect(readJournal(deps({ keys: { readFile, unwrap } }), idFor())).resolves.toEqual({ status: 'absent' })
    expect(readFile).not.toHaveBeenCalled()
    expect(unwrap).not.toHaveBeenCalled()
  })

  it('never creates a records directory that is missing', async () => {
    mkdirSync(directoryFor(), { recursive: true })
    writeFileSync(join(directoryFor(), 'key.v1'), '{"v":1,"kLocal":"F:AAAA"}')
    await expect(readJournal(deps(), idFor())).resolves.toEqual({ status: 'ignored', reason: 'no-records-dir' })
    expect(existsSync(join(directoryFor(), 'records'))).toBe(false)
  })

  it('refuses a records directory that is a symbolic link', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    const records = join(directoryFor(), 'records')
    const moved = join(temp.path, 'records-moved')
    rmSync(moved, { recursive: true, force: true })
    mkdirSync(moved)
    rmSync(records, { recursive: true })
    symlinkSync(moved, records, 'dir')
    await expect(readJournal(deps(), idFor())).resolves.toEqual({ status: 'ignored', reason: 'unsafe-path' })
  })

  it('refuses a journals root that is a symbolic link', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    const root = join(userData, 'meeting-journal')
    const moved = join(temp.path, 'journals-moved')
    renameSync(root, moved)
    symlinkSync(moved, root, 'dir')
    await expect(readJournal(deps(), idFor())).resolves.toEqual({ status: 'ignored', reason: 'unsafe-path' })
  })

  it('ignores the whole journal when one record fails its integrity check', async () => {
    await writeJournal({
      userData,
      startedAt: STARTED_AT,
      ownerKey: OWNER_A,
      lines: [1, 2, 3].map((n) => cloudLine(STARTED_AT, n))
    })
    const records = join(directoryFor(), 'records')
    const names = readdirSync(records).filter((n) => n.startsWith('record-'))
    const target = join(records, names[names.length - 1])
    const bytes = readFileSync(target)
    bytes[bytes.length - 1] ^= 1
    chmodSync(target, 0o600)
    writeFileSync(target, bytes)
    await expect(readJournal(deps(), idFor())).resolves.toEqual({ status: 'ignored', reason: 'read-failed' })
  })

  it('ignores a journal whose key was written by another device (wrong key fails the manifest check)', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    const other = {
      ...realKeys,
      unwrap: () => ({ ok: true as const, key: Buffer.alloc(32, 9), keychainRecovery: false })
    }
    await expect(readJournal(deps({ keys: other }), idFor())).resolves.toEqual({
      status: 'ignored',
      reason: 'manifest'
    })
  })

  it('refuses a journal larger than the trusted record budget', async () => {
    await writeJournal({
      userData,
      startedAt: STARTED_AT,
      ownerKey: OWNER_A,
      lines: [1, 2, 3].map((n) => cloudLine(STARTED_AT, n))
    })
    const { LIVE_MEETING_JOURNAL_LIMITS } = await import('./live-meeting-journal-policy')
    const tight = { ...LIVE_MEETING_JOURNAL_LIMITS, maxRecords: 2 }
    await expect(readJournal(deps({ limits: tight }), idFor())).resolves.toEqual({
      status: 'ignored',
      reason: 'too-large'
    })
  })

  it('rejects an id that is not a journal id before touching the disk', async () => {
    await expect(openJournal(deps(), '../../etc')).resolves.toEqual({ status: 'ignored', reason: 'unsafe-path' })
  })
})

describe('readJournalForMeeting and readJournalState', () => {
  it('tries the current owner first, then a signed-out journal', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: null, lines: [cloudLine(STARTED_AT, 1)] })
    const read = await readJournalForMeeting(deps(), STARTED_AT, ownerCandidates(OWNER_A))
    expect(read.status === 'ok' && read.ownerKey).toBe(null)
  })

  it('does not find another owner journal', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_B, lines: [cloudLine(STARTED_AT, 1)] })
    await expect(readJournalForMeeting(deps(), STARTED_AT, ownerCandidates(OWNER_A))).resolves.toEqual({
      status: 'absent'
    })
  })

  it('reports the lifecycle state without reading records', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    await expect(readJournalState(deps(), idFor())).resolves.toEqual({ status: 'ok', state: 'active' })
  })
})

describe('readVerifiedJournalStart and listJournalIds', () => {
  it('accepts a start file that reproduces the directory name for a plausible owner', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    await expect(readVerifiedJournalStart(userData, idFor(), ownerCandidates(OWNER_A))).resolves.toEqual({
      startedAt: STARTED_AT,
      ownerKey: OWNER_A
    })
  })

  it('refuses it for another owner, and when the start does not match the directory', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_B, lines: [cloudLine(STARTED_AT, 1)] })
    await expect(readVerifiedJournalStart(userData, idFor(OWNER_B), ownerCandidates(OWNER_A))).resolves.toBeNull()
    writeFileSync(join(directoryFor(OWNER_B), 'meeting.v1'), JSON.stringify({ v: 1, startedAt: STARTED_AT + 1 }))
    await expect(readVerifiedJournalStart(userData, idFor(OWNER_B), ownerCandidates(OWNER_B))).resolves.toBeNull()
  })

  it('refuses a missing, oversized or malformed start file', async () => {
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    const path = join(directoryFor(), 'meeting.v1')
    writeFileSync(path, 'x'.repeat(1000))
    await expect(readVerifiedJournalStart(userData, idFor(), [OWNER_A])).resolves.toBeNull()
    writeFileSync(path, JSON.stringify({ v: 2, startedAt: STARTED_AT }))
    await expect(readVerifiedJournalStart(userData, idFor(), [OWNER_A])).resolves.toBeNull()
    rmSync(path)
    await expect(readVerifiedJournalStart(userData, idFor(), [OWNER_A])).resolves.toBeNull()
  })

  it('lists only journal-shaped directory names', async () => {
    await expect(listJournalIds(userData)).resolves.toEqual([])
    await writeJournal({ userData, startedAt: STARTED_AT, ownerKey: OWNER_A, lines: [cloudLine(STARTED_AT, 1)] })
    mkdirSync(join(userData, 'meeting-journal', 'stray'))
    await expect(listJournalIds(userData)).resolves.toEqual([idFor()])
  })
})
