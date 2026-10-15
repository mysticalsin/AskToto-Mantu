import { app, safeStorage } from 'electron'
import type { ProviderId } from '@shared/providers'
import { mainLog } from './logger'
import {
  KeychainKeyRecoveryError,
  MacKeychainUnlockRequiredError,
  decryptSecret,
  requireMacKeychainUnlock
} from './secrets'

const AES_KEY_MARKER = Buffer.from('ATKAES1\n')

export function createCredentialReaders(deps: {
  readPath: (path: string) => Buffer
  pathExists: (path: string) => boolean
  apiKeyPath: (provider: ProviderId) => string
  dustTokenPath: () => string
  sonioxKeyPath: () => string
  envKey: (provider: ProviderId) => string | undefined
  saveApiKey: (provider: ProviderId, value: string) => void
}): {
  getApiKey: (provider: ProviderId) => string
  getDustRefreshToken: () => string
  getSonioxApiKeyStored: () => string
  invalidateApiKey: (provider: ProviderId) => void
  invalidateSoniox: () => void
  resetCaches: () => void
} {
  const apiKeyCache = new Map<ProviderId, string>()
  let sonioxKeyCache: string | null | undefined

  const rethrowMacKeychainDecryptFailure = (error: unknown): void => {
    if (error instanceof KeychainKeyRecoveryError) throw error
    if (app.isPackaged && process.platform === 'darwin') throw new MacKeychainUnlockRequiredError()
  }

  const getApiKey = (provider: ProviderId): string => {
    const env = deps.envKey(provider)
    if (env) return env
    requireMacKeychainUnlock()
    if (apiKeyCache.has(provider)) return apiKeyCache.get(provider)!
    let key = ''
    try {
      const buf = deps.readPath(deps.apiKeyPath(provider))
      if (buf.subarray(0, 6).toString('utf8') === 'plain:') {
        const plain = buf.subarray(6).toString('utf8')
        try {
          deps.saveApiKey(provider, plain)
        } catch {
          /* keep the plaintext file; key still works */
        }
        key = plain
      } else if (buf.length > AES_KEY_MARKER.length && buf.subarray(0, AES_KEY_MARKER.length).equals(AES_KEY_MARKER)) {
        try {
          key = decryptSecret(buf.subarray(AES_KEY_MARKER.length))
        } catch (error) {
          if (error instanceof KeychainKeyRecoveryError) throw error
          mainLog.warn('[store] key file undecryptable for', provider, error)
        }
      } else if (
        (!process.env.ASKTOTO_LOCAL_KEYSTORE || (app.isPackaged && process.platform === 'darwin')) &&
        ((app.isPackaged && process.platform === 'darwin') || safeStorage.isEncryptionAvailable())
      ) {
        try {
          const plain = safeStorage.decryptString(buf)
          try {
            deps.saveApiKey(provider, plain)
          } catch {
            /* keep the old blob; key still works */
          }
          key = plain
        } catch (error) {
          rethrowMacKeychainDecryptFailure(error)
        }
      }
    } catch (error) {
      if (error instanceof KeychainKeyRecoveryError) throw error
    }
    apiKeyCache.set(provider, key)
    return key
  }

  const getDustRefreshToken = (): string => {
    requireMacKeychainUnlock()
    try {
      const buf = deps.readPath(deps.dustTokenPath())
      if (buf.length > AES_KEY_MARKER.length && buf.subarray(0, AES_KEY_MARKER.length).equals(AES_KEY_MARKER)) {
        return decryptSecret(buf.subarray(AES_KEY_MARKER.length))
      }
      if (
        (!process.env.ASKTOTO_LOCAL_KEYSTORE || (app.isPackaged && process.platform === 'darwin')) &&
        ((app.isPackaged && process.platform === 'darwin') || safeStorage.isEncryptionAvailable())
      ) {
        try {
          return safeStorage.decryptString(buf)
        } catch (error) {
          rethrowMacKeychainDecryptFailure(error)
        }
      }
    } catch (error) {
      if (error instanceof KeychainKeyRecoveryError) throw error
    }
    return ''
  }

  const getSonioxApiKeyStored = (): string => {
    requireMacKeychainUnlock()
    if (sonioxKeyCache !== undefined && sonioxKeyCache !== null) return sonioxKeyCache
    let key = ''
    try {
      const path = deps.sonioxKeyPath()
      if (!deps.pathExists(path)) {
        sonioxKeyCache = ''
        return ''
      }
      const buf = deps.readPath(path)
      if (buf.length > AES_KEY_MARKER.length && buf.subarray(0, AES_KEY_MARKER.length).equals(AES_KEY_MARKER)) {
        key = decryptSecret(buf.subarray(AES_KEY_MARKER.length))
      } else if ((app.isPackaged && process.platform === 'darwin') || safeStorage.isEncryptionAvailable()) {
        try {
          key = safeStorage.decryptString(buf)
        } catch (error) {
          rethrowMacKeychainDecryptFailure(error)
        }
      }
    } catch (error) {
      if (error instanceof KeychainKeyRecoveryError) throw error
      mainLog.warn('[store] soniox key undecryptable', error)
    }
    sonioxKeyCache = key
    return key
  }

  return {
    getApiKey,
    getDustRefreshToken,
    getSonioxApiKeyStored,
    invalidateApiKey: (provider) => apiKeyCache.delete(provider),
    invalidateSoniox: () => {
      sonioxKeyCache = undefined
    },
    resetCaches: () => {
      apiKeyCache.clear()
      sonioxKeyCache = undefined
    }
  }
}
