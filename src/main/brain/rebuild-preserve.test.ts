import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { BRAIN_SCHEMA_VERSION, BrainIndexSchema } from '@shared/brain'
import type { Settings } from '@shared/ipc'

const actualFs = vi.hoisted(() => ({
  copyFileSync: undefined as undefined | typeof import('node:fs').copyFileSync,
  rmSync: undefined as undefined | typeof import('node:fs').rmSync
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.copyFileSync = actual.copyFileSync
  actualFs.rmSync = actual.rmSync
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    rmSync: vi.fn(actual.rmSync)
  }
})
vi.mock('electron')

import { resetSecretKeyCache } from '../secrets'
import { setSettings } from '../store'
import { envelopeKeyKind, writeSaved } from '../transcripts'
import { startBackfill } from './ingest'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { userDataIngestLedgerPath } from '../infra/storage/ingest-ledger'
import {
  brainDir,
  BrainIndexRebuildError,
  currentBrainIndexIsReadable,
  deletePreservedBrainIndex,
  listPreservedBrainIndexes,
  purgeBrain,
  restorePreservedBrainIndex
} from './store'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function expectBytesUnchanged(path: string, expectedSha256: string): void {
  expect(sha256(readFileSync(path))).toBe(expectedSha256)
}

function indexJson(): string {
  return JSON.stringify(BrainIndexSchema.parse({}))
}

function futureSchemaIndexBytes(): Buffer {
  return Buffer.from(JSON.stringify({ ...BrainIndexSchema.parse({}), schema_version: BRAIN_SCHEMA_VERSION + 1 }), 'utf8')
}

function foreignFileEnvelope(): Buffer {
  const env = {
    v: 2,
    iv: randomBytes(12).toString('base64'),
    tag: randomBytes(16).toString('base64'),
    ct: randomBytes(32).toString('base64'),
    kLocal: 'F:' + randomBytes(72).toString('base64')
  }
  return Buffer.concat([Buffer.from('ATKENC2\n', 'utf8'), Buffer.from(JSON.stringify(env), 'utf8')])
}

function legacyKeychainEnvelope(json: string): Buffer {
  return Buffer.concat([Buffer.from('ATKENC1\n', 'utf8'), safeStorage.encryptString(json)])
}

function expectRebuildError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(BrainIndexRebuildError)
  if (!(error instanceof BrainIndexRebuildError)) throw error
  expect(error.code).toBe(code)
}

function decryptElectronMockBuffer(buf: Buffer): string {
  const text = buf.toString('utf8')
  return text.startsWith('enc:') ? text.slice(4) : text
}

function restoreFsMocks(): void {
  if (!actualFs.copyFileSync || !actualFs.rmSync) throw new Error('node:fs mock was not initialised')
  vi.mocked(fs.copyFileSync).mockImplementation(actualFs.copyFileSync)
  vi.mocked(fs.rmSync).mockImplementation(actualFs.rmSync)
}

function restoreElectronMocks(userData: string): void {
  ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
    if (name === 'userData') return userData
    return join(userData, name)
  })
  ;(app as typeof app & { isPackaged?: boolean }).isPackaged = false
  ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
  ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation((value: string) => Buffer.from(`enc:${value}`))
  ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation(decryptElectronMockBuffer)
}

function makeKeychainUnavailable(): void {
  ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)
  ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation(() => {
    throw new Error('keychain unavailable')
  })
  ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation(() => {
    throw new Error('keychain unavailable')
  })
}

describe('rebuild preserves unreadable indexes', () => {
  let userData: string
  let meetingsFolder: string
  let settings: Settings
  let primary: string

  beforeEach(() => {
    restoreFsMocks()
    delete process.env.ASKTOTO_LEDGER_USERDATA
    useStorageForTests()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-preserve-ud-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-preserve-meetings-'))
    restoreElectronMocks(userData)
    resetSecretKeyCache()
    settings = { meetingsFolder } as Settings
    setSettings({ meetingsFolder })
    mkdirSync(brainDir(settings), { recursive: true })
    primary = join(brainDir(settings), 'index.json')
  })

  afterEach(async () => {
    // Tests may leave fs spies throwing; cleanup must run through the real implementations first.
    restoreFsMocks()
    await settleBrainWritesForTests()
    delete process.env.ASKTOTO_LEDGER_USERDATA
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    resetSecretKeyCache()
    restoreElectronMocks(userData)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.restoreAllMocks()
  })

  it('preserves an undecryptable index before rebuild', () => {
    const bytes = foreignFileEnvelope()
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)

    expect(purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(true)

    const preserved = join(meetingsFolder, '.brain-preserved')
    expect(fs.readdirSync(preserved)).toHaveLength(1)
    expectBytesUnchanged(join(preserved, fs.readdirSync(preserved)[0]), expected)
  })

  it('aborts rebuild without deleting when preserving fails', () => {
    const bytes = foreignFileEnvelope()
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('copy failed')
    })

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-preserve-failed')
    expectBytesUnchanged(primary, expected)
  })

  it('aborts rebuild when the index changes before purge', () => {
    const bytes = foreignFileEnvelope()
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      actualFs.copyFileSync!(from, to, mode)
      writeFileSync(primary, foreignFileEnvelope())
    })

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-changed-during-rebuild')
    expectBytesUnchanged(join(meetingsFolder, '.brain-preserved', fs.readdirSync(join(meetingsFolder, '.brain-preserved'))[0]), expected)
  })

  it('aborts rebuild when the index decrypts again', async () => {
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = true
    await writeSaved(primary, indexJson(), true)
    const expected = sha256(readFileSync(primary))
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => {
        throw new Error('key unavailable')
      })
      .mockImplementation((buf: Buffer) => {
        const text = buf.toString('utf8')
        return text.startsWith('enc:') ? text.slice(4) : text
      })

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-readable-again')
    expectBytesUnchanged(primary, expected)
  })

  it('refuses rebuild of a keychain-wrapped index while the keychain is unavailable', async () => {
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = true
    await writeSaved(primary, indexJson(), true)
    const expected = sha256(readFileSync(primary))
    makeKeychainUnavailable()

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-keystore-unavailable')
    expectBytesUnchanged(primary, expected)
  })

  it('refuses rebuild of a legacy keychain index while the keychain is unavailable', () => {
    const bytes = legacyKeychainEnvelope(indexJson())
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)
    makeKeychainUnavailable()

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-keystore-unavailable')
    expectBytesUnchanged(primary, expected)
  })

  it('refuses rebuild of a keychain-wrapped index while the local keystore is forced', async () => {
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = true
    await writeSaved(primary, indexJson(), true)
    const expected = sha256(readFileSync(primary))
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-keystore-unavailable')
    expectBytesUnchanged(primary, expected)
  })

  it('refuses rebuild of a file-key index while the file key is locked', async () => {
    await writeSaved(primary, indexJson(), true)
    writeFileSync(join(userData, 'secret-key.bin'), Buffer.from('enc:not-a-local-file-key'))
    resetSecretKeyCache()
    makeKeychainUnavailable()
    const expected = sha256(readFileSync(primary))

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-keystore-unavailable')
    expectBytesUnchanged(primary, expected)
  })

  it('preserves a file-key index this install has no key for before rebuild', async () => {
    await writeSaved(primary, indexJson(), true)
    const expected = sha256(readFileSync(primary))
    rmSync(join(userData, 'secret-key.bin'), { force: true })
    resetSecretKeyCache()

    expect(purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(true)
    expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)

    const preserved = join(meetingsFolder, '.brain-preserved', fs.readdirSync(join(meetingsFolder, '.brain-preserved'))[0])
    expectBytesUnchanged(preserved, expected)
  })

  it('refuses rebuild while the index cannot be read', () => {
    rmSync(primary, { force: true })
    mkdirSync(primary)

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-keystore-unavailable')
  })

  it('refuses rebuild of a future-schema index', () => {
    const bytes = futureSchemaIndexBytes()
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)

    const error = (() => {
      try {
        purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true })
      } catch (e) {
        return e
      }
    })()

    expectRebuildError(error, 'brain-index-unsupported-version')
    expectBytesUnchanged(primary, expected)
  })

  it('a crash between preserve and purge leaves the primary index in place', () => {
    const bytes = foreignFileEnvelope()
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (path === brainDir(settings)) throw new Error('simulated crash')
      return actualFs.rmSync!(path, options)
    })

    expect(purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(false)

    expectBytesUnchanged(primary, expected)
    const preserved = join(meetingsFolder, '.brain-preserved', fs.readdirSync(join(meetingsFolder, '.brain-preserved'))[0])
    expectBytesUnchanged(preserved, expected)
  })

  it('rebuild keeps the corrections journal', () => {
    const bytes = foreignFileEnvelope()
    writeFileSync(primary, bytes)
    const corrections = join(brainDir(settings), 'corrections.json')
    writeFileSync(corrections, JSON.stringify({ entries: [] }), 'utf8')
    const expected = sha256(readFileSync(corrections))

    expect(purgeBrain(settings, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(true)

    expectBytesUnchanged(corrections, expected)
  })

  it('delete-all erases preserved indexes', () => {
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    writeFileSync(join(preserved, 'index.unreadable-sample.json'), foreignFileEnvelope())

    expect(purgeBrain(settings, { mode: 'erase' }).ok).toBe(true)

    expect(existsSync(preserved)).toBe(false)
  })

  it('delete-all reports failure when preserved indexes remain after the erase attempt', () => {
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    writeFileSync(join(preserved, 'index.unreadable-sample.json'), foreignFileEnvelope())
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (path === preserved) return
      return actualFs.rmSync!(path, options)
    })

    expect(purgeBrain(settings, { mode: 'erase' }).ok).toBe(false)

    expect(existsSync(brainDir(settings))).toBe(false)
    expect(existsSync(preserved)).toBe(true)
  })

  it('lists preserved indexes with size, date, and restore availability only after they decrypt', async () => {
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    const locked = join(preserved, 'index.unreadable-locked.json')
    const readable = join(preserved, 'index.unreadable-readable.json')
    writeFileSync(locked, foreignFileEnvelope())
    await writeSaved(readable, indexJson(), true)

    const copies = listPreservedBrainIndexes(settings)

    expect(copies.map((c) => c.id).sort()).toEqual(['index.unreadable-locked.json', 'index.unreadable-readable.json'])
    expect(copies.find((c) => c.id === 'index.unreadable-locked.json')).toMatchObject({
      size: readFileSync(locked).byteLength,
      restorable: false
    })
    expect(copies.find((c) => c.id === 'index.unreadable-readable.json')).toMatchObject({
      size: readFileSync(readable).byteLength,
      restorable: true
    })
    expect(copies.every((c) => c.createdAt > 0)).toBe(true)
  })

  it('restores a decrypting preserved index only after readable-current confirmation and preserves the current index', async () => {
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    await writeSaved(primary, indexJson(), false)
    const currentBefore = sha256(readFileSync(primary))
    const copy = join(preserved, 'index.unreadable-readable.json')
    await writeSaved(copy, JSON.stringify(BrainIndexSchema.parse({ ingested: { 'restored.md': { at: 1, ok: true } } })), true)
    const restoredBytes = sha256(readFileSync(copy))

    expect(currentBrainIndexIsReadable(settings)).toBe(true)
    expect(restorePreservedBrainIndex(settings, 'index.unreadable-readable.json', { allowReplaceReadable: false })).toEqual({
      ok: false,
      error: 'current-readable'
    })
    expectBytesUnchanged(primary, currentBefore)

    expect(restorePreservedBrainIndex(settings, 'index.unreadable-readable.json', { allowReplaceReadable: true })).toEqual({ ok: true })

    expectBytesUnchanged(primary, restoredBytes)
    const beforeRestore = fs.readdirSync(preserved).filter((f) => f.startsWith('index.before-restore-'))
    expect(beforeRestore).toHaveLength(1)
    expectBytesUnchanged(join(preserved, beforeRestore[0]), currentBefore)
  })

  it('restores the bytes it verified even if the preserved source changes before replacement', async () => {
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    await writeSaved(primary, indexJson(), false)
    const copy = join(preserved, 'index.unreadable-readable.json')
    await writeSaved(copy, JSON.stringify(BrainIndexSchema.parse({ ingested: { 'verified.md': { at: 1, ok: true } } })), true)
    const verifiedBytes = sha256(readFileSync(copy))
    const changedBytes = Buffer.from(JSON.stringify(BrainIndexSchema.parse({ ingested: { 'changed.md': { at: 2, ok: true } } })), 'utf8')
    const changedSha = sha256(changedBytes)
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      actualFs.copyFileSync!(from, to, mode)
      if (from === primary) writeFileSync(copy, changedBytes)
    })

    expect(restorePreservedBrainIndex(settings, 'index.unreadable-readable.json', { allowReplaceReadable: true })).toEqual({ ok: true })

    expectBytesUnchanged(primary, verifiedBytes)
    expect(sha256(readFileSync(primary))).not.toBe(changedSha)
  })

  it('restores into the active userData ledger in switch mode without rewriting the legacy rollback ledger', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'
    writeFileSync(primary, JSON.stringify(BrainIndexSchema.parse({ ingested: { 'rollback.md': { at: 1, ok: true } } })))
    const legacyBefore = sha256(readFileSync(primary))
    const active = userDataIngestLedgerPath(settings)
    mkdirSync(join(userData, 'brain'), { recursive: true })
    await writeSaved(active, JSON.stringify(BrainIndexSchema.parse({ ingested: { 'active.md': { at: 2, ok: true } } })), false)
    const activeBefore = sha256(readFileSync(active))
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    const copy = join(preserved, 'index.unreadable-readable.json')
    await writeSaved(copy, JSON.stringify(BrainIndexSchema.parse({ ingested: { 'restored-switch.md': { at: 3, ok: true } } })), true)
    const restoredBytes = sha256(readFileSync(copy))

    expect(currentBrainIndexIsReadable(settings)).toBe(true)
    expect(restorePreservedBrainIndex(settings, 'index.unreadable-readable.json', { allowReplaceReadable: true })).toEqual({ ok: true })

    expectBytesUnchanged(primary, legacyBefore)
    expectBytesUnchanged(active, restoredBytes)
    const beforeRestore = fs.readdirSync(preserved).filter((f) => f.startsWith('index.before-restore-'))
    expect(beforeRestore).toHaveLength(1)
    expectBytesUnchanged(join(preserved, beforeRestore[0]), activeBefore)
  })

  it('refuses to restore a preserved index that still cannot decrypt', () => {
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    const locked = join(preserved, 'index.unreadable-locked.json')
    writeFileSync(locked, foreignFileEnvelope())
    writeFileSync(primary, indexJson())
    const currentBefore = sha256(readFileSync(primary))

    expect(restorePreservedBrainIndex(settings, 'index.unreadable-locked.json', { allowReplaceReadable: true })).toEqual({
      ok: false,
      error: 'not-restorable'
    })

    expectBytesUnchanged(primary, currentBefore)
  })

  it('deletes one preserved index copy without touching the others', () => {
    const preserved = join(meetingsFolder, '.brain-preserved')
    mkdirSync(preserved, { recursive: true })
    writeFileSync(join(preserved, 'index.unreadable-a.json'), foreignFileEnvelope())
    writeFileSync(join(preserved, 'index.unreadable-b.json'), foreignFileEnvelope())

    expect(deletePreservedBrainIndex(settings, 'index.unreadable-a.json')).toEqual({ ok: true })

    expect(existsSync(join(preserved, 'index.unreadable-a.json'))).toBe(false)
    expect(existsSync(join(preserved, 'index.unreadable-b.json'))).toBe(true)
  })

  it('automatic paths never rebuild an unavailable index', async () => {
    const bytes = foreignFileEnvelope()
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)

    expect((await startBackfill()).queued).toBe(0)

    expectBytesUnchanged(primary, expected)
    expect(existsSync(join(meetingsFolder, '.brain-preserved'))).toBe(false)
  })

  it('classifies envelope key kinds without decrypting', async () => {
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = true
    await writeSaved(primary, indexJson(), true)
    const keychain = readFileSync(primary)
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = false
    resetSecretKeyCache()
    await writeSaved(primary, indexJson(), true)
    const file = readFileSync(primary)
    const legacy = legacyKeychainEnvelope(indexJson())
    const decryptCalls = (safeStorage.decryptString as ReturnType<typeof vi.fn>).mock.calls.length

    expect(envelopeKeyKind(Buffer.from(indexJson(), 'utf8'))).toBe('plain')
    expect(envelopeKeyKind(keychain)).toBe('keychain')
    expect(envelopeKeyKind(file)).toBe('file')
    expect(envelopeKeyKind(legacy)).toBe('keychain')
    expect(envelopeKeyKind(Buffer.from('ATKENC2\n{', 'utf8'))).toBe('malformed')
    expect(safeStorage.decryptString).toHaveBeenCalledTimes(decryptCalls)
  })
})
