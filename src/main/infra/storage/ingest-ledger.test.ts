import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app } from 'electron'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema } from '@shared/brain'
import { resetSecretKeyCache } from '../../secrets'
import { readSavedFile } from '../../transcripts'

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
    const userDataPath = ledger.userDataIngestLedgerPath()

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
    await writeFile(ledger.userDataIngestLedgerPath(), JSON.stringify(current), 'utf8')

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
    const userDataPath = ledger.userDataIngestLedgerPath()
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
    expect(await exists(ledger.userDataIngestLedgerPath())).toBe(false)
  })
})
