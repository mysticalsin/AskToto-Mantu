import { app, safeStorage } from 'electron'
import { auditLog } from './logger'
import {
  KeychainKeyRecoveryError,
  MacKeychainUnlockRequiredError,
  decryptSecret,
  encryptSecret,
  isMacKeychainUnlockAuthorized,
  useFileBackend
} from './secrets'

export function readAuthSession<T>(options: {
  read: () => Buffer
  useFileBackend: () => boolean
  safeStorageAvailable: () => boolean
  decryptFile: (data: Buffer) => string
  encryptFile: (json: string) => Buffer
  decryptSafeStorage: (data: Buffer) => string
  encryptSafeStorage: (json: string) => Buffer
  write: (data: Buffer) => void
  packagedMac: boolean
}): T | null {
  let safeStorageDecryptFailed = false
  try {
    const buf = options.read()
    let json: string | null = null
    if (options.useFileBackend()) {
      try {
        json = options.decryptFile(buf)
      } catch {
        /* not AES-GCM format; legacy safeStorage may still succeed */
      }
    }
    if (
      json === null &&
      (options.packagedMac || !options.useFileBackend()) &&
      (options.packagedMac || options.safeStorageAvailable())
    ) {
      try {
        json = options.decryptSafeStorage(buf)
      } catch {
        safeStorageDecryptFailed = true
      }
      if (json !== null && options.useFileBackend()) {
        try {
          options.write(options.encryptFile(json))
        } catch {
          /* best-effort migration */
        }
      }
    }
    if (json === null && (options.packagedMac || !options.useFileBackend())) {
      try {
        json = options.decryptFile(buf)
      } catch (error) {
        if (error instanceof KeychainKeyRecoveryError) throw error
      }
      if (json !== null && options.safeStorageAvailable()) {
        try {
          options.write(options.encryptSafeStorage(json))
        } catch {
          /* best-effort migration */
        }
      }
    }
    if (json === null && options.packagedMac && safeStorageDecryptFailed) throw new MacKeychainUnlockRequiredError()
    return json !== null ? (JSON.parse(json) as T) : null
  } catch (error) {
    if (error instanceof KeychainKeyRecoveryError && options.packagedMac) throw new MacKeychainUnlockRequiredError()
    throw error
  }
}

export function createAuthSessionLoader<T extends { at?: number }>(options: {
  isLoaded: () => boolean
  setLoaded: (loaded: boolean) => void
  getSession: () => T | null
  setSession: (session: T | null) => void
  path: () => string
  readFile: (path: string) => Buffer
  writeFile: (path: string, data: Buffer, options: { mode: number }) => void
  clearExpiredSession: () => void
}): () => void {
  return () => {
    if (options.isLoaded()) return
    const packagedMac = app.isPackaged && process.platform === 'darwin'
    if (packagedMac && !isMacKeychainUnlockAuthorized()) {
      options.setSession(null)
      return
    }
    try {
      options.setSession(
        readAuthSessionFile({
          path: options.path(),
          readFile: options.readFile,
          writeFile: options.writeFile,
          packagedMac
        })
      )
    } catch (error) {
      options.setSession(null)
      if (error instanceof KeychainKeyRecoveryError) {
        options.setLoaded(false)
        if (packagedMac) throw new MacKeychainUnlockRequiredError()
        throw error
      }
    }
    options.setLoaded(true)
    const session = options.getSession()
    if (session && (typeof session.at !== 'number' || Date.now() - session.at > 7 * 24 * 60 * 60 * 1000)) {
      options.clearExpiredSession()
      options.setSession(null)
      auditLog('auth.expired', { reason: 'max_age' })
    }
  }
}

export function reloadAuthSessionAfterUnlock<T>(options: {
  setSession: (session: T | null) => void
  setLoaded: (loaded: boolean) => void
  load: () => void
}): void {
  options.setSession(null)
  options.setLoaded(false)
  options.load()
}

export function readAuthSessionFile<T>(options: {
  path: string
  readFile: (path: string) => Buffer
  writeFile: (path: string, data: Buffer, options: { mode: number }) => void
  packagedMac: boolean
}): T | null {
  return readAuthSession<T>({
    read: () => options.readFile(options.path),
    useFileBackend,
    safeStorageAvailable: () => safeStorage.isEncryptionAvailable(),
    decryptFile: decryptSecret,
    encryptFile: encryptSecret,
    decryptSafeStorage: (buffer) => safeStorage.decryptString(buffer),
    encryptSafeStorage: (json) => safeStorage.encryptString(json),
    write: (buffer) => options.writeFile(options.path, buffer, { mode: 0o600 }),
    packagedMac: options.packagedMac
  })
}
