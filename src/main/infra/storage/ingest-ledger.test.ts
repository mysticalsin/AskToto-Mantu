import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app } from 'electron'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema } from '@shared/brain'
import { resetSecretKeyCache } from '../../secrets'
import { readSavedFile } from '../../transcripts'
import type { IngestLedgerMode } from './ingest-ledger'

vi.mock('electron')

const store = await import('../../brain/store')
const ledger = await import('./ingest-ledger')

const marker = Buffer.from('ATKENC2\n', 'utf8')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readBytes(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path)
}

function readIndexJson(path: string): unknown {
  return JSON.parse(readSavedFile(path))
}

async function writeBrainIndex(path: string, ingested: Record<string, { at: number; ok: boolean; sourceVersion?: string }>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(BrainIndexSchema.parse({ ingested })), 'utf8')
}

function foreignKeyIndexBytes(): Buffer {
  const env = {
    v: 2,
    iv: randomBytes(12).toString('base64'),
    tag: randomBytes(16).toString('base64'),
    ct: randomBytes(64).toString('base64'),
    kLocal: 'F:' + randomBytes(72).toString('base64')
  }
  return Buffer.concat([marker, Buffer.from(JSON.stringify(env), 'utf8')])
}

describe('ingest ledger userData rollout', () => {
  let userData: string
  let meetingsFolder: string
  let settings: Settings
  let legacyPath: string

  beforeEach(async () => {
    delete process.env.ASKTOTO_LEDGER_USERDATA
    delete process.env.METIS_LEDGER_USERDATA
    delete process.env.ASKTOTO_FEATURE_LEDGER_USERDATA
    resetSecretKeyCache()
    userData = await mkdtemp(join(tmpdir(), 'metis-ledger-userdata-'))
    meetingsFolder = await mkdtemp(join(tmpdir(), 'metis-ledger-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    settings = { meetingsFolder, encryptTranscripts: false } as Settings
    await mkdir(store.brainDir(settings), { recursive: true })
    legacyPath = join(store.brainDir(settings), 'index.json')
  })

  afterEach(async () => {
    delete process.env.ASKTOTO_LEDGER_USERDATA
    delete process.env.METIS_LEDGER_USERDATA
    delete process.env.ASKTOTO_FEATURE_LEDGER_USERDATA
    resetSecretKeyCache()
    vi.restoreAllMocks()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await rm(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('expand writes the userData ledger alongside the legacy ledger while reads still come from legacy', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'expand'
    const idx = BrainIndexSchema.parse({})
    idx.ingested['legacy-primary.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }

    await store.writeIndex(settings, idx)
    const userDataPath = ledger.userDataIngestLedgerPath(settings)

    expect(BrainIndexSchema.parse(readIndexJson(legacyPath)).ingested['legacy-primary.md']?.sourceVersion).toBe('meeting-a:v1')
    expect(BrainIndexSchema.parse(readIndexJson(userDataPath)).ingested['legacy-primary.md']?.sourceVersion).toBe('meeting-a:v1')

    const divergent = BrainIndexSchema.parse({})
    divergent.ingested['userdata-only.md'] = { at: 2, ok: true, sourceVersion: 'meeting-b:v1' }
    await writeFile(userDataPath, JSON.stringify(divergent), 'utf8')

    expect(store.readIndex(settings).ingested['legacy-primary.md']?.sourceVersion).toBe('meeting-a:v1')
    expect(store.readIndex(settings).ingested['userdata-only.md']).toBeUndefined()
  })

  it('switch reads and writes userData without deleting or rewriting the rollback legacy ledger', async () => {
    const legacy = BrainIndexSchema.parse({})
    legacy.ingested['rollback.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }
    await writeFile(legacyPath, JSON.stringify(legacy), 'utf8')
    const beforeLegacy = await readBytes(legacyPath)

    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'
    const current = BrainIndexSchema.parse({})
    current.ingested['current.md'] = { at: 2, ok: true, sourceVersion: 'meeting-a:v2' }
    await mkdir(join(userData, 'brain'), { recursive: true })
    await writeFile(ledger.userDataIngestLedgerPath(settings), JSON.stringify(current), 'utf8')

    expect(store.readIndex(settings).ingested['current.md']?.sourceVersion).toBe('meeting-a:v2')
    expect(store.readIndex(settings).ingested['rollback.md']).toBeUndefined()

    current.ingested['next.md'] = { at: 3, ok: true, sourceVersion: 'meeting-b:v1' }
    await store.writeIndex(settings, current)

    expect(await readBytes(legacyPath)).toEqual(beforeLegacy)
    process.env.ASKTOTO_LEDGER_USERDATA = 'legacy'
    expect(store.readIndex(settings).ingested['rollback.md']?.sourceVersion).toBe('meeting-a:v1')
  })

  it('switch treats a foreign-key userData ledger as read-only and preserves both ledger files', async () => {
    const legacy = BrainIndexSchema.parse({})
    legacy.ingested['rollback.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }
    await writeFile(legacyPath, JSON.stringify(legacy), 'utf8')
    const userDataPath = ledger.userDataIngestLedgerPath(settings)
    await mkdir(join(userData, 'brain'), { recursive: true })
    await writeFile(userDataPath, foreignKeyIndexBytes())
    const beforeLegacy = await readBytes(legacyPath)
    const beforeUserData = await readBytes(userDataPath)

    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'

    expect(store.indexUnavailable(settings)).toBe('undecryptable')
    await expect(store.writeIndex(settings, BrainIndexSchema.parse({}))).rejects.toMatchObject({ unavailable: 'undecryptable' })
    expect(await readBytes(legacyPath)).toEqual(beforeLegacy)
    expect(await readBytes(userDataPath)).toEqual(beforeUserData)
  })

  it('legacy mode never creates a userData ledger', async () => {
    const idx = BrainIndexSchema.parse({})
    idx.ingested['legacy-only.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }

    await store.writeIndex(settings, idx)

    expect(await exists(legacyPath)).toBe(true)
    expect(await exists(ledger.userDataIngestLedgerPath(settings))).toBe(false)
  })

  it('keys the userData ledger by resolved meetings folder', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'
    const otherMeetingsFolder = await mkdtemp(join(tmpdir(), 'metis-ledger-other-meetings-'))
    const otherSettings = { ...settings, meetingsFolder: otherMeetingsFolder } as Settings
    await mkdir(store.brainDir(otherSettings), { recursive: true })
    try {
      const firstPath = ledger.userDataIngestLedgerPath(settings)
      const secondPath = ledger.userDataIngestLedgerPath(otherSettings)
      expect(firstPath).not.toBe(secondPath)

      await writeBrainIndex(firstPath, { 'first-folder.md': { at: 1, ok: true, sourceVersion: 'same-name:v1' } })
      await writeBrainIndex(secondPath, { 'second-folder.md': { at: 2, ok: true, sourceVersion: 'same-name:v1' } })

      expect(store.readIndex(settings).ingested['first-folder.md']?.ok).toBe(true)
      expect(store.readIndex(settings).ingested['second-folder.md']).toBeUndefined()
      expect(store.readIndex(otherSettings).ingested['second-folder.md']?.ok).toBe(true)
      expect(store.readIndex(otherSettings).ingested['first-folder.md']).toBeUndefined()
    } finally {
      await rm(otherMeetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('switch seeds a missing userData ledger from a readable legacy ledger without rewriting legacy', async () => {
    await writeBrainIndex(legacyPath, { 'legacy-seeded.md': { at: 1, ok: true, sourceVersion: 'meeting-a:v1' } })
    const beforeLegacy = await readBytes(legacyPath)
    const userDataPath = ledger.userDataIngestLedgerPath(settings)
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'

    expect((await store.readIndexAsync(settings)).ingested['legacy-seeded.md']?.sourceVersion).toBe('meeting-a:v1')

    expect(await readBytes(legacyPath)).toEqual(beforeLegacy)
    expect(BrainIndexSchema.parse(readIndexJson(userDataPath)).ingested['legacy-seeded.md']?.sourceVersion).toBe('meeting-a:v1')
  })

  it('switch refuses to seed from an unreadable legacy ledger when the userData ledger is missing', async () => {
    await writeFile(legacyPath, foreignKeyIndexBytes())
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'

    expect(store.indexUnavailable(settings)).toBe('undecryptable')
    expect(await exists(ledger.userDataIngestLedgerPath(settings))).toBe(false)
  })

  it('switch treats a corrupt legacy fallback as read-only when the userData ledger is missing', async () => {
    await writeFile(legacyPath, '{not-json', 'utf8')
    const beforeLegacy = await readBytes(legacyPath)
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'

    expect(store.indexUnavailable(settings)).toBe('corrupt-kept')
    expect(await exists(ledger.userDataIngestLedgerPath(settings))).toBe(false)
    expect(await readBytes(legacyPath)).toEqual(beforeLegacy)
  })

  it('purge clears the userData mirror in expand mode and every userData ledger in erase mode', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'expand'
    await store.writeIndex(settings, BrainIndexSchema.parse({ ingested: { 'expand.md': { at: 1, ok: true } } }))
    const expandMirror = ledger.userDataIngestLedgerPath(settings)
    expect(await exists(expandMirror)).toBe(true)

    expect(store.purgeBrain(settings, { mode: 'rebuild', preserveCorrections: false }).ok).toBe(true)
    expect(await exists(expandMirror)).toBe(false)

    await mkdir(store.brainDir(settings), { recursive: true })
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'
    await store.writeIndex(settings, BrainIndexSchema.parse({ ingested: { 'switch.md': { at: 2, ok: true } } }))
    const switchLedger = ledger.userDataIngestLedgerPath(settings)
    const staleLedger = join(dirname(switchLedger), 'index-0123456789abcdef.json')
    await writeFile(staleLedger, JSON.stringify(BrainIndexSchema.parse({ ingested: { stale: { at: 3, ok: true } } })), 'utf8')
    expect(await exists(switchLedger)).toBe(true)
    expect(await exists(staleLedger)).toBe(true)

    expect(store.purgeBrain(settings, { mode: 'erase' }).ok).toBe(true)
    expect(await exists(switchLedger)).toBe(false)
    expect(await exists(staleLedger)).toBe(false)
  })

  it('restores rollback truth table: legacy file remains the only 1.9.6 ledger across rollout modes', async () => {
    const cases: Array<{
      mode: IngestLedgerMode
      legacy: 'ready' | 'missing' | 'unreadable'
      rollbackReady: boolean
    }> = [
      { mode: 'legacy', legacy: 'ready', rollbackReady: true },
      { mode: 'legacy', legacy: 'missing', rollbackReady: false },
      { mode: 'legacy', legacy: 'unreadable', rollbackReady: false },
      { mode: 'expand', legacy: 'ready', rollbackReady: true },
      { mode: 'expand', legacy: 'missing', rollbackReady: true },
      { mode: 'expand', legacy: 'unreadable', rollbackReady: false },
      { mode: 'switch', legacy: 'ready', rollbackReady: true },
      { mode: 'switch', legacy: 'missing', rollbackReady: false },
      { mode: 'switch', legacy: 'unreadable', rollbackReady: false }
    ]

    for (const row of cases) {
      await rm(store.brainDir(settings), { recursive: true, force: true })
      await rm(ledger.userDataIngestLedgerPath(settings), { force: true })
      await mkdir(store.brainDir(settings), { recursive: true })
      if (row.legacy === 'ready') await writeBrainIndex(legacyPath, { 'rollback.md': { at: 1, ok: true, sourceVersion: `${row.mode}:v1` } })
      if (row.legacy === 'unreadable') await writeFile(legacyPath, foreignKeyIndexBytes())
      process.env.ASKTOTO_LEDGER_USERDATA = row.mode
      if (row.mode === 'expand' || row.mode === 'switch') {
        const rollout = BrainIndexSchema.parse({ ingested: { 'rollout-write.md': { at: 2, ok: true, sourceVersion: `${row.mode}:v2` } } })
        try {
          await store.writeIndex(settings, rollout)
        } catch (e) {
          expect(row.legacy).toBe('unreadable')
          expect(e).toBeTruthy()
        }
      }

      process.env.ASKTOTO_LEDGER_USERDATA = 'legacy'
      expect(store.indexUnavailable(settings) === null && !!store.readIndex(settings).ingested['rollback.md']).toBe(row.rollbackReady)
    }
  })

  it('two device userData ledgers over one shared brain skip the same sourceVersion after legacy seeding', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'expand'
    await store.writeIndex(settings, BrainIndexSchema.parse({
      ingested: { 'same-meeting.md': { at: 1, ok: true, sourceVersion: 'meeting-123:v1' } }
    }))
    const deviceOnePath = ledger.userDataIngestLedgerPath(settings)
    const deviceOneBytes = await readBytes(deviceOnePath)

    const deviceTwoUserData = await mkdtemp(join(tmpdir(), 'metis-ledger-device-two-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return deviceTwoUserData
      return join(deviceTwoUserData, name)
    })
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'
    try {
      expect((await store.readIndexAsync(settings)).ingested['same-meeting.md']?.sourceVersion).toBe('meeting-123:v1')
      const deviceTwoPath = ledger.userDataIngestLedgerPath(settings)
      expect(deviceTwoPath).not.toBe(deviceOnePath)
      expect(BrainIndexSchema.parse(readIndexJson(deviceTwoPath)).ingested['same-meeting.md']?.sourceVersion).toBe('meeting-123:v1')
      expect(await readBytes(deviceOnePath)).toEqual(deviceOneBytes)
    } finally {
      await rm(deviceTwoUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'userData') return userData
        return join(userData, name)
      })
    }
  })

  it('expand refuses to overwrite a foreign-key userData mirror', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'expand'
    const userDataPath = ledger.userDataIngestLedgerPath(settings)
    await mkdir(dirname(userDataPath), { recursive: true })
    await writeFile(userDataPath, foreignKeyIndexBytes())
    const beforeMirror = await readBytes(userDataPath)

    await expect(store.writeIndex(settings, BrainIndexSchema.parse({}))).rejects.toThrow('userData ingest ledger is read-only')
    expect(await exists(legacyPath)).toBe(false)
    expect(await readBytes(userDataPath)).toEqual(beforeMirror)
  })
})
