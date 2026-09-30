import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema } from '@shared/brain'
import { resetSecretKeyCache } from '../../secrets'

vi.mock('electron')

const store = await import('../../brain/store')
const ledger = await import('./ingest-ledger')

const marker = Buffer.from('ATKENC2\n', 'utf8')

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

  beforeEach(() => {
    delete process.env.ASKTOTO_LEDGER_USERDATA
    delete process.env.METIS_LEDGER_USERDATA
    delete process.env.ASKTOTO_FEATURE_LEDGER_USERDATA
    resetSecretKeyCache()
    userData = mkdtempSync(join(tmpdir(), 'metis-ledger-userdata-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'metis-ledger-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    settings = { meetingsFolder, encryptTranscripts: false } as Settings
    mkdirSync(store.brainDir(settings), { recursive: true })
    legacyPath = join(store.brainDir(settings), 'index.json')
  })

  afterEach(() => {
    delete process.env.ASKTOTO_LEDGER_USERDATA
    delete process.env.METIS_LEDGER_USERDATA
    delete process.env.ASKTOTO_FEATURE_LEDGER_USERDATA
    resetSecretKeyCache()
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('expand writes the userData ledger alongside the legacy ledger while reads still come from legacy', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'expand'
    const idx = BrainIndexSchema.parse({})
    idx.ingested['legacy-primary.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }

    await store.writeIndex(settings, idx)
    const userDataPath = ledger.userDataIngestLedgerPath()

    expect(JSON.parse(readFileSync(legacyPath, 'utf8')).ingested['legacy-primary.md']?.sourceVersion).toBe('meeting-a:v1')
    expect(JSON.parse(readFileSync(userDataPath, 'utf8')).ingested['legacy-primary.md']?.sourceVersion).toBe('meeting-a:v1')

    const divergent = BrainIndexSchema.parse({})
    divergent.ingested['userdata-only.md'] = { at: 2, ok: true, sourceVersion: 'meeting-b:v1' }
    writeFileSync(userDataPath, JSON.stringify(divergent), 'utf8')

    expect(store.readIndex(settings).ingested['legacy-primary.md']?.sourceVersion).toBe('meeting-a:v1')
    expect(store.readIndex(settings).ingested['userdata-only.md']).toBeUndefined()
  })

  it('switch reads and writes userData without deleting or rewriting the rollback legacy ledger', async () => {
    const legacy = BrainIndexSchema.parse({})
    legacy.ingested['rollback.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }
    writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8')
    const beforeLegacy = readFileSync(legacyPath)

    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'
    const current = BrainIndexSchema.parse({})
    current.ingested['current.md'] = { at: 2, ok: true, sourceVersion: 'meeting-a:v2' }
    mkdirSync(join(userData, 'brain'), { recursive: true })
    writeFileSync(ledger.userDataIngestLedgerPath(), JSON.stringify(current), 'utf8')

    expect(store.readIndex(settings).ingested['current.md']?.sourceVersion).toBe('meeting-a:v2')
    expect(store.readIndex(settings).ingested['rollback.md']).toBeUndefined()

    current.ingested['next.md'] = { at: 3, ok: true, sourceVersion: 'meeting-b:v1' }
    await store.writeIndex(settings, current)

    expect(readFileSync(legacyPath)).toEqual(beforeLegacy)
    process.env.ASKTOTO_LEDGER_USERDATA = 'legacy'
    expect(store.readIndex(settings).ingested['rollback.md']?.sourceVersion).toBe('meeting-a:v1')
  })

  it('switch treats a foreign-key userData ledger as read-only and preserves both ledger files', async () => {
    const legacy = BrainIndexSchema.parse({})
    legacy.ingested['rollback.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }
    writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8')
    const userDataPath = ledger.userDataIngestLedgerPath()
    mkdirSync(join(userData, 'brain'), { recursive: true })
    writeFileSync(userDataPath, foreignKeyIndexBytes())
    const beforeLegacy = readFileSync(legacyPath)
    const beforeUserData = readFileSync(userDataPath)

    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'

    expect(store.indexUnavailable(settings)).toBe('undecryptable')
    await expect(store.writeIndex(settings, BrainIndexSchema.parse({}))).rejects.toMatchObject({ unavailable: 'undecryptable' })
    expect(readFileSync(legacyPath)).toEqual(beforeLegacy)
    expect(readFileSync(userDataPath)).toEqual(beforeUserData)
  })

  it('legacy mode never creates a userData ledger', async () => {
    const idx = BrainIndexSchema.parse({})
    idx.ingested['legacy-only.md'] = { at: 1, ok: true, sourceVersion: 'meeting-a:v1' }

    await store.writeIndex(settings, idx)

    expect(existsSync(legacyPath)).toBe(true)
    expect(existsSync(ledger.userDataIngestLedgerPath())).toBe(false)
  })
})
