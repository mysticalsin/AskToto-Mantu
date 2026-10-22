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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_VERSION_KEY, type SettingsMigration } from '@shared/settings-migrations'
import { migrateSettingsFile, type SettingsFileCodec } from './settings-migration-runner'

// A transparent stand-in codec: "ENC\n" + JSON is encrypted, bare JSON is legacy plaintext, anything else is unreadable.
const MARK = Buffer.from('ENC\n')
const codec: SettingsFileCodec = {
  decode: (buf) => {
    const encrypted = buf.subarray(0, MARK.length).equals(MARK)
    try {
      const raw = JSON.parse((encrypted ? buf.subarray(MARK.length) : buf).toString('utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? { raw, encrypted } : null
    } catch {
      return null
    }
  },
  encode: (raw) => Buffer.concat([MARK, Buffer.from(JSON.stringify(raw))])
}
const enc = (raw: Record<string, unknown>): Buffer => codec.encode(raw)
const dec = (buf: Buffer): Record<string, unknown> => codec.decode(buf)?.raw ?? {}

// The shipped chain is stamp-only, so tests that exercise backup and rewrite inject a step that changes data.
const DATA_STEP: SettingsMigration = {
  id: 'synthetic-add-key',
  from: 0,
  to: 1,
  up: (raw) => ({ ...raw, addedByMigration: true })
}

describe('migrateSettingsFile', () => {
  let dir: string
  let path: string
  const log = { warn: vi.fn(), info: vi.fn() }
  const run = (overrides: Partial<Parameters<typeof migrateSettingsFile>[0]> = {}) =>
    migrateSettingsFile({ path, ...codec, log, plan: { migrations: [DATA_STEP], current: 1 }, ...overrides })
  const files = (): string[] => readdirSync(dir).sort()

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'metis-settings-migrate-')))
    path = join(dir, 'settings.json')
    log.warn.mockReset()
    log.info.mockReset()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('backs up the original bytes, then rewrites with the version stamp and every unknown key kept', async () => {
    const original = enc({ temperature: 0.7, retiredLegacyKey: { keep: 'me' } })
    writeFileSync(path, original)
    const result = await run()
    expect(result).toMatchObject({ status: 'migrated', from: 0, to: 1 })
    const backup = join(dir, 'settings.json.pre-v0.bak')
    expect(readFileSync(backup).equals(original)).toBe(true)
    expect(dec(readFileSync(path))).toEqual({
      temperature: 0.7,
      retiredLegacyKey: { keep: 'me' },
      addedByMigration: true,
      [SETTINGS_VERSION_KEY]: 1
    })
    expect(files()).toEqual(['settings.json', 'settings.json.pre-v0.bak'])
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('does not back up or rewrite for a stamp-only step: the version waits for the next ordinary save', async () => {
    const original = enc({ temperature: 0.7, retiredLegacyKey: 1 })
    writeFileSync(path, original)
    expect(await run({ plan: undefined })).toEqual({ status: 'deferred' })
    expect(readFileSync(path).equals(original)).toBe(true)
    expect(files()).toEqual(['settings.json'])
  })

  it('commits nothing once the time bound has passed and leaves the original alone', async () => {
    const original = enc({ a: 1 })
    writeFileSync(path, original)
    const result = await run({
      timeoutMs: 1,
      encode: (raw) => {
        const until = Date.now() + 25
        while (Date.now() < until) {
          /* hold the thread past the bound, as a stalled disk would hold the write */
        }
        return codec.encode(raw)
      }
    })
    expect(result).toMatchObject({ status: 'failed' })
    expect(readFileSync(path).equals(original)).toBe(true)
    expect(files().filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('never rejects, even when the codec throws', async () => {
    writeFileSync(path, enc({ a: 1 }))
    const result = await run({
      decode: () => {
        throw new Error('keychain exploded')
      }
    })
    expect(result).toMatchObject({ status: 'failed' })
  })

  it('is idempotent: a second run changes nothing and makes no new backup', async () => {
    writeFileSync(path, enc({ a: 1 }))
    await run()
    const after = readFileSync(path)
    expect(await run()).toEqual({ status: 'current' })
    expect(readFileSync(path).equals(after)).toBe(true)
    expect(files()).toEqual(['settings.json', 'settings.json.pre-v0.bak'])
  })

  it('does nothing for a missing file', async () => {
    expect(await run()).toEqual({ status: 'missing' })
    expect(files()).toEqual([])
  })

  it('keeps an unreadable file byte for byte and writes nothing', async () => {
    const corrupt = Buffer.concat([MARK, Buffer.from('{not json')])
    writeFileSync(path, corrupt)
    expect(await run()).toEqual({ status: 'unreadable' })
    expect(readFileSync(path).equals(corrupt)).toBe(true)
    expect(files()).toEqual(['settings.json'])
  })

  it('keeps a future-version file byte for byte and writes nothing', async () => {
    const future = enc({ [SETTINGS_VERSION_KEY]: 99, newerSetting: true })
    writeFileSync(path, future)
    expect(await run()).toEqual({ status: 'future', version: 99 })
    expect(readFileSync(path).equals(future)).toBe(true)
    expect(files()).toEqual(['settings.json'])
    expect(log.warn).toHaveBeenCalled()
  })

  it('never leaves a legacy plaintext copy behind: the backup of a plaintext file is encrypted', async () => {
    writeFileSync(path, JSON.stringify({ contextDocs: ['synthetic-private-note'] }))
    expect(await run()).toMatchObject({ status: 'migrated' })
    for (const name of files()) {
      const bytes = readFileSync(join(dir, name))
      expect(bytes.subarray(0, MARK.length).equals(MARK), name).toBe(true)
    }
    expect(dec(readFileSync(join(dir, 'settings.json.pre-v0.bak'))).contextDocs).toEqual(['synthetic-private-note'])
  })

  it('does not rewrite when the backup cannot be made, and keeps the original', async () => {
    const original = enc({ a: 1 })
    writeFileSync(path, original)
    mkdirSync(join(dir, 'settings.json.pre-v0.bak')) // a directory squatting on the backup name
    const result = await run()
    expect(result).toMatchObject({ status: 'failed', reason: 'BACKUP_FAILED' })
    expect(readFileSync(path).equals(original)).toBe(true)
  })

  it('keeps the original and the backup, and removes the temp file, when the rewrite fails', async () => {
    const original = enc({ a: 1 })
    writeFileSync(path, original)
    const result = await run({
      encode: () => {
        throw new Error('encryption unavailable')
      }
    })
    expect(result).toMatchObject({ status: 'failed', reason: 'WRITE_FAILED' })
    expect(readFileSync(path).equals(original)).toBe(true)
    expect(files()).toEqual(['settings.json', 'settings.json.pre-v0.bak'])
  })

  it('does not clobber a settings write that lands while the migration is in flight', async () => {
    writeFileSync(path, enc({ a: 1 }))
    const concurrent = enc({ a: 1, savedByTheUserMeanwhile: true })
    const result = await run({
      decode: (buf) => {
        const decoded = codec.decode(buf)
        writeFileSync(path, concurrent) // another writer wins after the read
        return decoded
      }
    })
    expect(result).toEqual({ status: 'changed' })
    expect(readFileSync(path).equals(concurrent)).toBe(true)
    expect(files()).toEqual(['settings.json']) // the stale backup this attempt made is removed, no temp file
    // The next boot sees the new file and migrates it.
    expect(await run()).toMatchObject({ status: 'migrated' })
    expect(dec(readFileSync(path)).savedByTheUserMeanwhile).toBe(true)
  })

  it('does not overwrite an existing backup of the same version', async () => {
    writeFileSync(path, enc({ a: 1 }))
    const older = Buffer.from('older backup')
    writeFileSync(join(dir, 'settings.json.pre-v0.bak'), older)
    expect(await run()).toMatchObject({ status: 'migrated' })
    expect(readFileSync(join(dir, 'settings.json.pre-v0.bak')).equals(older)).toBe(true)
  })
})
