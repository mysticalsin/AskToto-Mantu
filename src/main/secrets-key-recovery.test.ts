import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'

vi.mock('electron')

describe('secrets — corrupt wrapped key recovery', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-secrets-recovery-'))
    ;(app as unknown as { isPackaged: boolean }).isPackaged = true
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation((value: string) =>
      Buffer.from(`enc:${value}`)
    )
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation((buffer: Buffer) => {
      const value = buffer.toString('utf8')
      return value.startsWith('enc:') ? value.slice(4) : value
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    ;(app as unknown as { isPackaged: boolean }).isPackaged = false
    rmSync(userData, { recursive: true, force: true })
  })

  it('refuses to regenerate a non-empty wrapped value that cannot decode to a 32-byte AES key', async () => {
    const original = Buffer.from('legacy-invalid-wrapped-key')
    writeFileSync(join(userData, 'secret-key.bin'), original)
    const { encryptSecret } = await import('./secrets')

    expect(() => encryptSecret('brain-data')).toThrow('Métis could not unlock the existing encrypted profile')
    expect(readFileSync(join(userData, 'secret-key.bin'))).toEqual(original)
  })

  it('recovers a wrapped key on an explicit write even when availability reports false', async () => {
    const originalKey = randomBytes(32)
    writeFileSync(join(userData, 'secret-key.bin'), Buffer.from(`enc:${originalKey.toString('base64')}`))
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const { prepareFileKeyForWrite, encryptSecret, decryptSecret } = await import('./secrets')

    prepareFileKeyForWrite()
    expect(readFileSync(join(userData, 'secret-key.bin'))).toEqual(originalKey)
    expect(decryptSecret(encryptSecret('brain-data'))).toBe('brain-data')
  })

  describe('D7-5 a zero-byte wrapped key file', () => {
    it('zero-byte wrapped key on a fresh profile is recreated atomically', async () => {
      const keyFile = join(userData, 'secret-key.bin')
      writeFileSync(keyFile, Buffer.alloc(0)) // the file a crash during first key creation leaves behind
      const { encryptSecret, decryptSecret, resetSecretKeyCache, fileKeyState } = await import('./secrets')
      resetSecretKeyCache()
      expect(fileKeyState()).toBe('absent')

      const envelope = encryptSecret('brain-data')

      // Created through the keychain wrap (never a raw key beside its own ciphertext), and through
      // tmp+rename: no temp file survives and the key file is never left truncated.
      expect(readFileSync(keyFile).toString('utf8').startsWith('enc:')).toBe(true)
      expect(readdirSync(userData).filter((name) => name.endsWith('.tmp'))).toEqual([])
      resetSecretKeyCache()
      expect(fileKeyState()).toBe('available')
      expect(decryptSecret(envelope)).toBe('brain-data')
    })

    it('creates the key file through persistKeyFileAtomically, never an in-place write', async () => {
      const { readModuleSource } = await import('../test-helpers/module-source')
      const { text } = readModuleSource(__dirname, './secrets')
      const loadKey = text.slice(text.indexOf('function loadKey('), text.indexOf('export function resetSecretKeyCache'))
      expect(loadKey).not.toMatch(/writeFileSync\(/)
      expect(loadKey).toMatch(/persistKeyFileAtomically\(p, /)
    })

    it('a zero-byte key file beside other encrypted profile files fails closed and is left untouched', async () => {
      const keyFile = join(userData, 'secret-key.bin')
      writeFileSync(keyFile, Buffer.alloc(0))
      writeFileSync(join(userData, 'key-anthropic.bin'), randomBytes(48))
      const { encryptSecret, resetSecretKeyCache, KeychainKeyRecoveryError } = await import('./secrets')
      resetSecretKeyCache()

      expect(() => encryptSecret('brain-data')).toThrow(KeychainKeyRecoveryError)
      expect(readFileSync(keyFile)).toHaveLength(0)
    })
  })

  describe('D7-8 a missing key file never silently mints a new key', () => {
    it.each([
      'key-anthropic.bin',
      'auth-session.bin'
    ])('a missing key file with %s present refuses to mint', async (existingFile) => {
      writeFileSync(join(userData, existingFile), randomBytes(48))
      const { encryptSecret, resetSecretKeyCache, KeychainKeyRecoveryError } = await import('./secrets')
      resetSecretKeyCache()

      expect(() => encryptSecret('brain-data')).toThrow(KeychainKeyRecoveryError)
      expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)
    })

    it('a plaintext settings.json alone does not block the first key', async () => {
      writeFileSync(join(userData, 'settings.json'), '{}')
      const { encryptSecret, resetSecretKeyCache } = await import('./secrets')
      resetSecretKeyCache()

      expect(() => encryptSecret('brain-data')).not.toThrow()
      expect(existsSync(join(userData, 'secret-key.bin'))).toBe(true)
    })
  })
})
