import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { app as ElectronApp, safeStorage as ElectronSafeStorage } from 'electron'

vi.mock('electron')

const ENC_MARKER_V2 = Buffer.from('ATKENC2\n')

function encryptExistingSettings(key: Buffer, value: Record<string, unknown>): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([ENC_MARKER_V2, iv, cipher.getAuthTag(), ciphertext])
}

describe('store local-keystore migration', () => {
  let userData: string
  let priorLocalKeystore: string | undefined
  let app: typeof ElectronApp
  let safeStorage: typeof ElectronSafeStorage

  beforeEach(async () => {
    vi.resetModules()
    const electron = await import('electron')
    app = electron.app
    safeStorage = electron.safeStorage
    userData = mkdtempSync(join(tmpdir(), 'asktoto-local-keystore-migration-'))
    priorLocalKeystore = process.env.ASKTOTO_LOCAL_KEYSTORE
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'

    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation((value: string) =>
      Buffer.from(`wrapped:${value}`, 'utf8')
    )
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation((value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('wrapped:')) throw new Error('not a wrapped key')
      return text.slice('wrapped:'.length)
    })
  })

  afterEach(() => {
    if (priorLocalKeystore === undefined) delete process.env.ASKTOTO_LOCAL_KEYSTORE
    else process.env.ASKTOTO_LOCAL_KEYSTORE = priorLocalKeystore
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('preserves an existing encrypted profile without probing Keychain when the local keystore is forced', async () => {
    const originalKey = randomBytes(32)
    writeFileSync(
      join(userData, 'secret-key.bin'),
      Buffer.from(`wrapped:${originalKey.toString('base64')}`, 'utf8'),
      { mode: 0o600 }
    )
    const settings = encryptExistingSettings(originalKey, { provider: 'openai', temperature: 0.42 })
    writeFileSync(
      join(userData, 'settings.json'),
      settings,
      { mode: 0o600 }
    )

    const { setSettings } = await import('./store')
    expect(() => setSettings({ recordingConsent: true })).toThrow(
      'Métis could not unlock the existing encrypted profile'
    )
    expect(readFileSync(join(userData, 'secret-key.bin'))).toEqual(
      Buffer.from(`wrapped:${originalKey.toString('base64')}`, 'utf8')
    )
    expect(readFileSync(join(userData, 'settings.json'))).toEqual(settings)
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('leaves the encrypted profile untouched when the original Keychain cannot unlock its file key', async () => {
    const originalKey = randomBytes(32)
    const wrappedKey = Buffer.from(`wrapped:${originalKey.toString('base64')}`, 'utf8')
    const settings = encryptExistingSettings(originalKey, { provider: 'openai', temperature: 0.42 })
    writeFileSync(join(userData, 'secret-key.bin'), wrappedKey, { mode: 0o600 })
    writeFileSync(join(userData, 'settings.json'), settings, { mode: 0o600 })
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Keychain access denied')
    })

    const { setSettings } = await import('./store')

    expect(() => setSettings({ recordingConsent: true })).toThrow(
      'Métis could not unlock the existing encrypted profile'
    )
    expect(readFileSync(join(userData, 'secret-key.bin'))).toEqual(wrappedKey)
    expect(readFileSync(join(userData, 'settings.json'))).toEqual(settings)
  })

  it('archives the encrypted profile before allowing a fresh local profile to be created', async () => {
    const originalKey = randomBytes(32)
    const wrappedKey = Buffer.from(`wrapped:${originalKey.toString('base64')}`, 'utf8')
    writeFileSync(join(userData, 'secret-key.bin'), wrappedKey, { mode: 0o600 })
    const settings = encryptExistingSettings(originalKey, { provider: 'openai' })
    writeFileSync(join(userData, 'settings.json'), settings, { mode: 0o600 })
    writeFileSync(join(userData, 'key-openai.bin'), Buffer.from('encrypted-provider-key'), { mode: 0o600 })

    const { archiveEncryptedProfile, setSettings } = await import('./store')
    const archive = archiveEncryptedProfile()

    expect(archive.files).toEqual(expect.arrayContaining(['secret-key.bin', 'settings.json', 'key-openai.bin']))
    expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)
    expect(existsSync(join(userData, 'settings.json'))).toBe(false)
    expect(readFileSync(join(archive.backupDir, 'secret-key.bin'))).toEqual(wrappedKey)
    expect(readFileSync(join(archive.backupDir, 'settings.json'))).toEqual(settings)

    const fresh = setSettings({ recordingConsent: true })
    expect(fresh.recordingConsent).toBe(true)
    expect(readFileSync(join(userData, 'secret-key.bin'))).toHaveLength(32)
    expect(readdirSync(userData).some((name) => name.startsWith('.metis-recovery-'))).toBe(true)
  })
})
