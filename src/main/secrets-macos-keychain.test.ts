import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX } from '@shared/encrypted-profile-recovery'
import {
  authorizeMacKeychainUnlock,
  KeychainKeyRecoveryError,
  decryptSecret,
  encryptSecret,
  prepareFileKeyForWrite,
  resetMacKeychainUnlockAuthorization,
  resetSecretKeyCache,
  useFileBackend
} from './secrets'

vi.mock('electron')

describe('packaged macOS Keychain unlock', () => {
  let userData: string
  let originalPlatform: string
  let originalLocalKeystore: string | undefined

  beforeEach(() => {
    originalPlatform = process.platform
    originalLocalKeystore = process.env.ASKTOTO_LOCAL_KEYSTORE
    delete process.env.ASKTOTO_LOCAL_KEYSTORE
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    userData = mkdtempSync(join(tmpdir(), 'asktoto-macos-keychain-'))
    ;(app as unknown as { isPackaged: boolean }).isPackaged = true
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation((value: string) =>
      Buffer.from(`wrapped:${value}`)
    )
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockImplementation((value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('wrapped:')) throw new Error('Keychain denied')
      return text.slice('wrapped:'.length)
    })
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockClear()
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockClear()
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockClear()
    resetMacKeychainUnlockAuthorization()
    resetSecretKeyCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    ;(app as unknown as { isPackaged: boolean }).isPackaged = false
    resetMacKeychainUnlockAuthorization()
    resetSecretKeyCache()
    rmSync(userData, { recursive: true, force: true })
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    if (originalLocalKeystore === undefined) delete process.env.ASKTOTO_LOCAL_KEYSTORE
    else process.env.ASKTOTO_LOCAL_KEYSTORE = originalLocalKeystore
  })

  it('keeps a wrapped key byte-identical and does not probe Keychain before the visible unlock action', () => {
    const keyFile = join(userData, 'secret-key.bin')
    const wrapped = Buffer.from(`wrapped:${randomBytes(32).toString('base64')}`)
    writeFileSync(keyFile, wrapped)
    const ciphertext = randomBytes(12 + 16 + 24)

    expect(useFileBackend()).toBe(true)
    expect(() => decryptSecret(ciphertext)).toThrow(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
    expect(readFileSync(keyFile)).toEqual(wrapped)

    authorizeMacKeychainUnlock()
    expect(() => decryptSecret(ciphertext)).toThrow()
    expect(safeStorage.decryptString).toHaveBeenCalledOnce()
    expect(readFileSync(keyFile)).toEqual(wrapped)
  })

  it('atomically migrates an existing raw key through the wrapped format', () => {
    const keyFile = join(userData, 'secret-key.bin')
    const originalKey = randomBytes(32)
    writeFileSync(keyFile, originalKey)

    expect(() => encryptSecret('existing profile data')).toThrow(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)
    expect(readFileSync(keyFile)).toEqual(originalKey)
    authorizeMacKeychainUnlock()

    const encrypted = encryptSecret('existing profile data')

    expect(readFileSync(keyFile)).not.toEqual(originalKey)
    expect(readFileSync(keyFile).toString('utf8')).toBe(`wrapped:${originalKey.toString('base64')}`)
    expect(decryptSecret(encrypted)).toBe('existing profile data')
    expect(existsSync(`${keyFile}.migrate.tmp`)).toBe(false)
  })

  it('keeps an existing raw key intact when atomic wrapping fails', () => {
    const keyFile = join(userData, 'secret-key.bin')
    const originalKey = randomBytes(32)
    writeFileSync(keyFile, originalKey)
    authorizeMacKeychainUnlock()
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Keychain denied')
    })

    expect(() => encryptSecret('existing profile data')).toThrow(KeychainKeyRecoveryError)
    expect(readFileSync(keyFile)).toEqual(originalKey)
    expect(existsSync(`${keyFile}.migrate.tmp`)).toBe(false)
  })

  it('does not create a raw key when packaged macOS safeStorage is unavailable', () => {
    authorizeMacKeychainUnlock()
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false)

    expect(() => encryptSecret('new profile data')).toThrow(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)
    expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)
  })

  it('gates fresh-profile key creation behind the visible unlock action', () => {
    expect(() => encryptSecret('first visible settings write')).toThrow(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)

    authorizeMacKeychainUnlock()
    prepareFileKeyForWrite()
    expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)
    const ciphertext = encryptSecret('first visible settings write')
    expect(ciphertext.length).toBeGreaterThan(0)
    expect(safeStorage.encryptString).toHaveBeenCalledOnce()
    expect(readFileSync(join(userData, 'secret-key.bin')).toString('utf8')).toMatch(/^wrapped:/)
  })

  it('requires a fresh visible unlock before using a cached key after authorization is reset', () => {
    authorizeMacKeychainUnlock()
    const ciphertext = encryptSecret('already unlocked profile data')
    const keyFile = join(userData, 'secret-key.bin')
    const wrappedKey = readFileSync(keyFile)
    const encryptCalls = (safeStorage.encryptString as ReturnType<typeof vi.fn>).mock.calls.length
    const decryptCalls = (safeStorage.decryptString as ReturnType<typeof vi.fn>).mock.calls.length

    resetMacKeychainUnlockAuthorization()

    expect(() => encryptSecret('must remain locked')).toThrow(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)
    expect(() => decryptSecret(ciphertext)).toThrow(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)
    expect(readFileSync(keyFile)).toEqual(wrappedKey)
    expect(safeStorage.encryptString).toHaveBeenCalledTimes(encryptCalls)
    expect(safeStorage.decryptString).toHaveBeenCalledTimes(decryptCalls)
  })

  it('does not let the local-keystore environment override create a packaged Mac raw key', () => {
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    expect(() => encryptSecret('settings write')).toThrow(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)

    authorizeMacKeychainUnlock()
    encryptSecret('settings write')
    expect(readFileSync(join(userData, 'secret-key.bin')).toString('utf8')).toMatch(/^wrapped:/)
  })
})
