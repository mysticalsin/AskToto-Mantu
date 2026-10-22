import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSchema, DEFAULT_SETTINGS } from '@shared/ipc'
import { CURRENT_SETTINGS_SCHEMA_VERSION, SETTINGS_VERSION_KEY } from '@shared/settings-migrations'
import { decryptSecret, encryptSecret } from './secrets'
import { getSettings, migrateSettingsFileOnBoot, resetSettingsCacheForTests, setSettings } from './store'
import { getPublishedSettingsObservation } from './settings-observation'

vi.mock('electron')

const ENC_V2 = Buffer.from('ATKENC2\n')
const NOTE = 'synthetic-private-note-for-encryption-check'

describe('settings file migration through the real store', () => {
  let userData: string
  const settingsFile = (): string => join(userData, 'settings.json')
  const writeEncrypted = (raw: Record<string, unknown>): Buffer => {
    const bytes = Buffer.concat([ENC_V2, encryptSecret(JSON.stringify(raw))])
    writeFileSync(settingsFile(), bytes)
    return bytes
  }
  const readEncrypted = (path: string): Record<string, unknown> => {
    const buf = readFileSync(path)
    expect(buf.subarray(0, ENC_V2.length).equals(ENC_V2), path).toBe(true)
    return JSON.parse(decryptSecret(buf.subarray(ENC_V2.length)))
  }

  beforeEach(() => {
    resetSettingsCacheForTests()
    userData = realpathSync(mkdtempSync(join(tmpdir(), 'metis-settings-store-migrate-')))
    vi.mocked(app.getPath).mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('migrates an encrypted legacy profile: backup first, stamp, unknown keys kept, still encrypted, same Settings', async () => {
    const original = writeEncrypted({ temperature: 0.37, contextDocs: [NOTE], retiredLegacyKey: { keep: 'me' } })
    const before = getSettings()

    const result = await migrateSettingsFileOnBoot()

    expect(result).toMatchObject({ status: 'migrated', from: 0, to: CURRENT_SETTINGS_SCHEMA_VERSION })
    const backup = `${settingsFile()}.pre-v0.bak`
    expect(readFileSync(backup).equals(original)).toBe(true)
    const persisted = readEncrypted(settingsFile())
    expect(persisted).toMatchObject({
      temperature: 0.37,
      retiredLegacyKey: { keep: 'me' },
      [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION
    })
    expect(readFileSync(settingsFile()).includes(NOTE)).toBe(false)
    expect(getSettings()).toEqual(before) // the loaded Settings are unchanged: no default moved
    expect(readdirSync(userData).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('never writes the profile as plaintext, even when the legacy file was plaintext', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ contextDocs: [NOTE] }))
    expect(await migrateSettingsFileOnBoot()).toMatchObject({ status: 'migrated' })
    for (const name of readdirSync(userData)) {
      if (name === 'secret-key.bin') continue
      expect(readFileSync(join(userData, name)).includes(NOTE), name).toBe(false)
    }
    expect(readEncrypted(`${settingsFile()}.pre-v0.bak`).contextDocs).toEqual([NOTE])
  })

  it('keeps managed-policy locks working: the lock still wins on read and no managed value is copied into the user file', async () => {
    writeFileSync(
      join(userData, 'managed-config.json'),
      JSON.stringify({ temperature: 0.11, lockedKeys: ['temperature'] })
    )
    writeEncrypted({ temperature: 0.9, contextDocs: [NOTE] })
    expect(getSettings().temperature).toBe(0.11)

    await migrateSettingsFileOnBoot()

    expect(getSettings().temperature).toBe(0.11)
    const persisted = readEncrypted(settingsFile())
    expect(persisted.temperature).toBe(0.9) // the user layer is untouched; policy is applied on read
    expect(Object.keys(persisted).sort()).toEqual(['contextDocs', SETTINGS_VERSION_KEY, 'temperature'].sort())
    setSettings({ temperature: 0.5 }) // a locked write is still dropped
    expect(getSettings().temperature).toBe(0.11)
  })

  it('a corrupt profile loads safe defaults, refuses writes, and the original is never deleted or rewritten', async () => {
    const corrupt = Buffer.concat([ENC_V2, Buffer.from('not-a-valid-ciphertext-at-all-0123456789')])
    writeFileSync(settingsFile(), corrupt)

    expect(await migrateSettingsFileOnBoot()).toEqual({ status: 'unreadable' })

    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(getPublishedSettingsObservation()?.readable).toBe(false)
    expect(() => setSettings({ temperature: 0.5 })).toThrow(/can't read/i)
    expect(readFileSync(settingsFile()).equals(corrupt)).toBe(true)
    expect(existsSync(`${settingsFile()}.pre-v0.bak`)).toBe(false)
  })

  it('a future-version profile loads safe defaults, refuses writes, and the original is never deleted or rewritten', async () => {
    const future = writeEncrypted({ [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION + 1, temperature: 0.91 })

    expect(getSettings().temperature).toBe(DEFAULT_SETTINGS.temperature)
    expect(getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(getPublishedSettingsObservation()?.readable).toBe(false)
    expect(() => setSettings({ temperature: 0.5 })).toThrow(/can't read/i)
    expect(await migrateSettingsFileOnBoot()).toEqual({
      status: 'future',
      version: CURRENT_SETTINGS_SCHEMA_VERSION + 1
    })
    expect(readFileSync(settingsFile()).equals(future)).toBe(true)
  })

  it('rolls back cleanly: an older reader of the migrated file sees the same settings, and the backup restores the exact bytes', async () => {
    const original = writeEncrypted({ temperature: 0.37, retiredLegacyKey: 1 })
    const oldReaderBefore = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...readEncrypted(settingsFile()) })

    await migrateSettingsFileOnBoot()

    // The pre-G09 reader is `SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...raw })`; the schema is unchanged.
    const migrated = readEncrypted(settingsFile())
    const oldReaderAfter = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...migrated })
    expect(oldReaderAfter.success).toBe(true)
    expect(oldReaderAfter.success && oldReaderAfter.data).toEqual(oldReaderBefore)

    copyFileSync(`${settingsFile()}.pre-v0.bak`, settingsFile())
    expect(readFileSync(settingsFile()).equals(original)).toBe(true)
  })

  it('a later settings save keeps the version stamp and every unknown key', async () => {
    writeEncrypted({ temperature: 0.37, retiredLegacyKey: { keep: 'me' } })
    await migrateSettingsFileOnBoot()
    setSettings({ temperature: 0.6 })
    expect(readEncrypted(settingsFile())).toMatchObject({
      temperature: 0.6,
      retiredLegacyKey: { keep: 'me' },
      [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_SCHEMA_VERSION
    })
  })

  it('does nothing on a fresh profile', async () => {
    mkdirSync(userData, { recursive: true })
    expect(await migrateSettingsFileOnBoot()).toEqual({ status: 'missing' })
    expect(existsSync(settingsFile())).toBe(false)
  })
})
