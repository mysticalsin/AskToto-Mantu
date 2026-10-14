import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, safeStorage } from 'electron'
import { isMacKeychainUnlockMessage } from '@shared/encrypted-profile-recovery'
import { DEFAULT_OVERLAY_LAYOUT } from '@shared/overlay-chrome'
import { createAuthSessionLoader, readAuthSession } from './auth-session-cache'
import { createMacProfileBootCoordinator, safeOverlayLayout, safeOverlayPlacement } from './mac-profile-boot'
import { createCredentialReaders } from './store-credential-readers'
import {
  authorizeMacKeychainUnlock,
  KeychainKeyRecoveryError,
  MacKeychainUnlockRequiredError,
  resetMacKeychainUnlockAuthorization
} from './secrets'

vi.mock('electron')
vi.mock('./logger', () => ({
  auditLog: vi.fn(),
  mainLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

describe('packaged macOS secure-keystore startup', () => {
  let originalPlatform: string
  let originalPackaged: boolean

  beforeEach(() => {
    originalPlatform = process.platform
    originalPackaged = app.isPackaged
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    ;(app as unknown as { isPackaged: boolean }).isPackaged = true
    ;(safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReset().mockReturnValue(false)
    ;(safeStorage.encryptString as ReturnType<typeof vi.fn>).mockReset()
    ;(safeStorage.decryptString as ReturnType<typeof vi.fn>).mockReset()
    resetMacKeychainUnlockAuthorization()
  })

  afterEach(() => {
    resetMacKeychainUnlockAuthorization()
    ;(app as unknown as { isPackaged: boolean }).isPackaged = originalPackaged
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.restoreAllMocks()
  })

  it('routes the stable Keychain error to the explicit unlock state', () => {
    const unlockError = new MacKeychainUnlockRequiredError()

    expect(isMacKeychainUnlockMessage(unlockError.message)).toBe(true)
    expect(isMacKeychainUnlockMessage(new Error('settings unavailable').message)).toBe(false)
  })

  it('keeps startup work queued while locked, then releases and resumes it once after unlock', () => {
    const releaseAfterFirstShow = vi.fn()
    const getBootWork = vi.fn(() => ({ releaseAfterFirstShow }))
    const coordinator = createMacProfileBootCoordinator(getBootWork)
    const deferredStep = vi.fn()
    const retryLockedStep = vi.fn()
    const beforeDefer = vi.fn()

    expect(coordinator.deferIfLocked('profileStartup', deferredStep, beforeDefer)).toBe(true)
    expect(coordinator.deferUnlockError('settingsRead', new KeychainKeyRecoveryError(), retryLockedStep)).toBe(true)
    coordinator.requestBootWorkRelease(null)
    coordinator.completeInitialization()

    expect(beforeDefer).toHaveBeenCalledOnce()
    expect(releaseAfterFirstShow).not.toHaveBeenCalled()
    expect(deferredStep).not.toHaveBeenCalled()
    expect(retryLockedStep).not.toHaveBeenCalled()

    authorizeMacKeychainUnlock()
    coordinator.unlockSucceeded()
    coordinator.unlockSucceeded()

    expect(releaseAfterFirstShow).toHaveBeenCalledOnce()
    expect(deferredStep).toHaveBeenCalledOnce()
    expect(retryLockedStep).toHaveBeenCalledOnce()
  })

  it('uses safe geometry defaults when locked profile settings cannot be read', () => {
    const readSettings = vi.fn(() => {
      throw new MacKeychainUnlockRequiredError()
    })

    expect(safeOverlayLayout(readSettings)).toEqual(DEFAULT_OVERLAY_LAYOUT)
    expect(safeOverlayPlacement(readSettings)).toBe('top-center')
    expect(readSettings).toHaveBeenCalled()
  })

  it('does not read or cache the auth session before visible Keychain consent', () => {
    const readFile = vi.fn(() => Buffer.from('legacy-safe-storage-session'))
    let loaded = false
    let session: { accessToken: string } | null = null
    const loadSession = createAuthSessionLoader<{ accessToken: string; at?: number }>({
      isLoaded: () => loaded,
      setLoaded: (value) => (loaded = value),
      getSession: () => session,
      setSession: (value) => (session = value),
      path: () => '/profile/auth-session.bin',
      readFile,
      writeFile: vi.fn(),
      clearExpiredSession: vi.fn()
    })

    loadSession()

    expect(readFile).not.toHaveBeenCalled()
    expect(session).toBeNull()
    expect(loaded).toBe(false)
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('fails closed on auth-session Keychain denial and retries successfully without losing bytes', () => {
    const source = Buffer.from('encrypted-auth-session')
    const decryptSafeStorage = vi
      .fn<(data: Buffer) => string>()
      .mockImplementationOnce(() => {
        throw new Error('Keychain access denied')
      })
      .mockReturnValueOnce(JSON.stringify({ accessToken: 'restored' }))
    const decryptFile = vi.fn(() => {
      throw new Error('not AES-GCM')
    })
    const write = vi.fn()
    const options = {
      read: () => source,
      useFileBackend: () => true,
      safeStorageAvailable: vi.fn(() => true),
      decryptFile,
      encryptFile: vi.fn(() => Buffer.from('file-encrypted-session')),
      decryptSafeStorage,
      encryptSafeStorage: vi.fn(() => Buffer.from('wrapped-session')),
      write,
      packagedMac: true
    }

    expect(() => readAuthSession<{ accessToken: string }>(options)).toThrow(MacKeychainUnlockRequiredError)
    expect(write).not.toHaveBeenCalled()
    expect(readAuthSession<{ accessToken: string }>(options)).toEqual({ accessToken: 'restored' })
    expect(write).toHaveBeenCalledWith(Buffer.from('file-encrypted-session'))
    expect(options.safeStorageAvailable).not.toHaveBeenCalled()
    expect(source.toString()).toBe('encrypted-auth-session')
  })

  it('gates legacy credential readers and retries denial without caching empty credentials', () => {
    const readPath = vi.fn(() => Buffer.from('legacy-safe-storage-credential'))
    const pathExists = vi.fn(() => true)
    const decryptString = vi
      .fn<(data: Buffer) => string>()
      .mockImplementationOnce(() => {
        throw new Error('Keychain access denied')
      })
      .mockImplementationOnce(() => {
        throw new Error('Keychain access denied')
      })
      .mockImplementationOnce(() => {
        throw new Error('Keychain access denied')
      })
      .mockReturnValue('restored-credential')
    const saveApiKey = vi.fn()
    const readers = createCredentialReaders({
      readPath,
      pathExists,
      apiKeyPath: (provider) => `/profile/key-${provider}.bin`,
      dustTokenPath: () => '/profile/dust-refresh.bin',
      sonioxKeyPath: () => '/profile/key-soniox.bin',
      envKey: () => undefined,
      saveApiKey
    })

    expect(() => readers.getApiKey('openai')).toThrow(MacKeychainUnlockRequiredError)
    expect(() => readers.getDustRefreshToken()).toThrow(MacKeychainUnlockRequiredError)
    expect(() => readers.getSonioxApiKeyStored()).toThrow(MacKeychainUnlockRequiredError)
    expect(readPath).not.toHaveBeenCalled()
    expect(pathExists).not.toHaveBeenCalled()

    authorizeMacKeychainUnlock()
    vi.mocked(safeStorage.decryptString).mockImplementation(decryptString)
    expect(() => readers.getApiKey('openai')).toThrow(MacKeychainUnlockRequiredError)
    expect(() => readers.getDustRefreshToken()).toThrow(MacKeychainUnlockRequiredError)
    expect(() => readers.getSonioxApiKeyStored()).toThrow(MacKeychainUnlockRequiredError)

    expect(readers.getApiKey('openai')).toBe('restored-credential')
    expect(readers.getDustRefreshToken()).toBe('restored-credential')
    expect(readers.getSonioxApiKeyStored()).toBe('restored-credential')
    expect(readers.getApiKey('openai')).toBe('restored-credential')
    expect(saveApiKey).toHaveBeenCalledOnce()
    expect(readPath).toHaveBeenCalledTimes(6)
    expect(decryptString).toHaveBeenCalledTimes(6)
  })
})
