import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { BRAIN_SCHEMA_VERSION, BrainIndexSchema } from '@shared/brain'
import type { Settings } from '@shared/ipc'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
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
import { brainDir, BrainIndexRebuildError, purgeBrain } from './store'

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

describe('rebuild preserves unreadable indexes', () => {
  let userData: string
  let meetingsFolder: string
  let settings: Settings
  let primary: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-preserve-ud-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-rebuild-preserve-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    ;(app as typeof app & { isPackaged?: boolean }).isPackaged = false
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    resetSecretKeyCache()
    settings = { meetingsFolder } as Settings
    setSettings({ meetingsFolder })
    mkdirSync(brainDir(settings), { recursive: true })
    primary = join(brainDir(settings), 'index.json')
  })

  afterEach(() => {
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    resetSecretKeyCache()
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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
    const realCopyFileSync = vi.mocked(fs.copyFileSync).getMockImplementation() ?? fs.copyFileSync
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      realCopyFileSync(from, to, mode)
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
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)

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
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)

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
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)
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
    const realRmSync = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (path === brainDir(settings)) throw new Error('simulated crash')
      return realRmSync(path, options)
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

  it('automatic paths never rebuild an unavailable index', () => {
    const bytes = foreignFileEnvelope()
    writeFileSync(primary, bytes)
    const expected = sha256(bytes)

    expect(startBackfill().queued).toBe(0)

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
