import { beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const sourceFile = (path: string): Promise<string> => readFile(join(root, path + '.' + 'ts'), 'utf8')
const sourceTsxFile = (path: string): Promise<string> => readFile(join(root, path + '.' + 't' + 'sx'), 'utf8')
let main = ''
let secrets = ''
let store = ''
let auth = ''
let app = ''
let state = ''
let recovery = ''
let startup = ''
let authCache = ''
let credentialReaders = ''
let unlockIpc = ''
let unlockScreen = ''
let unlockHook = ''
let settingsBoot = ''

beforeAll(async () => {
  ;[
    main,
    secrets,
    store,
    auth,
    app,
    state,
    recovery,
    startup,
    authCache,
    credentialReaders,
    unlockIpc,
    unlockScreen,
    unlockHook,
    settingsBoot
  ] = await Promise.all([
    sourceFile('src/main/index'),
    sourceFile('src/main/secrets'),
    sourceFile('src/main/store'),
    sourceFile('src/main/auth'),
    sourceFile('src/renderer/src/App'),
    sourceFile('src/renderer/src/state'),
    sourceFile('src/shared/encrypted-profile-recovery'),
    sourceFile('src/main/mac-profile-boot'),
    sourceFile('src/main/auth-session-cache'),
    sourceFile('src/main/store-credential-readers'),
    sourceFile('src/main/ipc/mac-profile-unlock'),
    sourceTsxFile('src/renderer/src/components/MacKeychainUnlockScreen'),
    sourceFile('src/renderer/src/hooks/use-encrypted-profile-unlock'),
    sourceFile('src/renderer/src/settings-boot')
  ])
})

describe('packaged macOS secure-keystore startup', () => {
  it('does not force the raw file keystore for Darwin', () => {
    expect(main).not.toMatch(/process\.platform\s*===\s*['"]darwin['"]\s*\)\s*process\.env\.ASKTOTO_LOCAL_KEYSTORE/)
    expect(secrets).toContain('if (packagedMacRequiresKeychain()) {')
    expect(secrets).toContain('throw new KeychainKeyRecoveryError()')
  })

  it('shows an explicit unlock action before retrying a locked encrypted profile', () => {
    expect(state).toContain('isMacKeychainUnlockMessage')
    expect(settingsBoot).toContain('if (isMacKeychainUnlockMessage(message))')
    expect(unlockHook).toContain('window.toto.unlockEncryptedProfile()')
    expect(app).toContain('isMacKeychainUnlockMessage(settingsBootError)')
    expect(unlockScreen).toContain('Unlock secure storage')
    expect(unlockScreen).toContain('Continue to Keychain')
    expect(unlockScreen).toContain('Denying access')
    expect(unlockScreen).toContain('leaves your files unchanged.')
  })

  it('can paint the locked-profile surface without reading profile settings', () => {
    expect(main).toContain('return safeOverlayLayout(getSettings)')
    expect(startup).toContain('export function withProfileReadFallback<T>')
    expect(startup).toContain('return fallback')
    expect(startup).toContain('DEFAULT_OVERLAY_LAYOUT')
  })

  it('does not create or wrap a key while a fresh profile is being read at startup', () => {
    const settingsReadStart = store.indexOf('export function getSettings(): Settings {')
    const settingsReadEnd = store.indexOf('export function setSettings(', settingsReadStart)
    const settingsReadPath = store.slice(settingsReadStart, settingsReadEnd)
    const rawReadStart = store.indexOf('function readUserRaw(): Record<string, unknown> | null {')
    const rawReadEnd = store.indexOf('/**\n * Sparse user overrides', rawReadStart)
    const rawReadPath = store.slice(rawReadStart, rawReadEnd)

    expect(settingsReadStart).toBeGreaterThanOrEqual(0)
    expect(settingsReadEnd).toBeGreaterThan(settingsReadStart)
    expect(rawReadPath).toContain('return tryRecoveredSettings() ?? {}')
    expect(settingsReadPath).not.toContain('serializeUserRaw(')
    expect(settingsReadPath).not.toContain('encryptSecret(')
    expect(rawReadPath).not.toContain('encryptSecret(')
  })

  it('completes boot setup while locked and resumes deferred startup work once after unlock', () => {
    expect(startup).toContain('deferred.set(name, run)')
    expect(startup).toContain('deferred.clear()')
    expect(startup).toContain('completeInitialization()')
    expect(startup).toContain('requestBootWorkRelease(window)')
    expect(startup).toContain('unlockSucceeded()')
    expect(main).toContain("macProfileBoot.defer('applyOperatorBootstrapSettings', () =>")
    expect(main).toContain('macProfileBoot.completeInitialization()')
    expect(main).toContain('macProfileBoot.isUnlockError(e)')
    expect(authCache).toContain('json === null && (options.packagedMac || !options.useFileBackend())')
    expect(auth).toContain('export function reloadSessionAfterProfileUnlock(): void')
  })

  it('does not probe safeStorage or allow a raw-key override before the explicit Mac unlock', () => {
    expect(secrets).toMatch(/if \(packagedMacRequiresKeychain\(\) && !_macKeychainUnlockConfirmed\) return true/)
    expect(secrets).toMatch(
      /export function isKeychainAvailable\(\): boolean \{\s+if \(packagedMacRequiresKeychain\(\) && !_macKeychainUnlockConfirmed\) return false/
    )
    expect(secrets).toMatch(
      /function packagedMacRequiresKeychain\(\): boolean \{[\s\S]*?return app\.isPackaged && process\.platform === 'darwin'/
    )
    expect(secrets).toMatch(
      /requireMacKeychainUnlock\(\)\s+const keychainAvailable = !localKeystoreForced && isKeychainAvailable\(\)/
    )
    expect(main).toContain("if (app.isPackaged && process.platform === 'darwin') requireMacKeychainUnlock()")
    expect(unlockIpc).toContain('reloadSessionAfterProfileUnlock()')
    expect(unlockIpc).toContain('prepareFileKeyForWrite()')
    const settingsGetStart = main.indexOf('ipcMain.handle(IPC.settingsGet')
    const unlockGate = main.indexOf('requireMacKeychainUnlock()', settingsGetStart)
    const settingsRead = main.indexOf('publicSettingsWithSpeakerPolicy()', settingsGetStart)
    expect(settingsGetStart).toBeGreaterThanOrEqual(0)
    expect(unlockGate).toBeGreaterThan(settingsGetStart)
    expect(settingsRead).toBeGreaterThan(unlockGate)
  })

  it('keeps denial fail-closed without onboarding or profile replacement', () => {
    const unlockSurfaceStart = app.indexOf('if (settingsBootError && isMacKeychainUnlockMessage(settingsBootError))')
    const onboardingStart = app.indexOf('if (onboardingBoot && DEMO == null)', unlockSurfaceStart)
    expect(unlockSurfaceStart).toBeGreaterThanOrEqual(0)
    expect(onboardingStart).toBeGreaterThan(unlockSurfaceStart)
    const unlockSurface = unlockScreen
    expect(unlockSurface).toContain('Continue to Keychain')
    expect(unlockSurface).not.toMatch(
      /recoverEncryptedProfile|archiveEncryptedProfile|Create new local profile|provisionalOnboardingSettings/
    )
    expect(state).toContain('isMacKeychainUnlockMessage')
    expect(credentialReaders).toContain('requireMacKeychainUnlock()')
    expect(unlockIpc).toContain('throw error')
  })

  it('gates legacy encrypted credential readers and does not cache unlock failures', () => {
    const section = (start: string, end: string): string => {
      const from = credentialReaders.indexOf(start)
      const to = credentialReaders.indexOf(end, from)
      expect(from).toBeGreaterThanOrEqual(0)
      expect(to).toBeGreaterThan(from)
      return credentialReaders.slice(from, to)
    }
    const apiKeyReader = section('const getApiKey =', 'const getDustRefreshToken =')
    const dustTokenReader = section('const getDustRefreshToken =', 'const getSonioxApiKeyStored =')
    const sonioxReader = section('const getSonioxApiKeyStored =', 'return {')

    for (const reader of [apiKeyReader, dustTokenReader, sonioxReader]) {
      expect(reader.indexOf('requireMacKeychainUnlock()')).toBeGreaterThanOrEqual(0)
      const legacySafeStorageRead = reader.indexOf('safeStorage.isEncryptionAvailable()')
      if (legacySafeStorageRead >= 0) {
        expect(reader.indexOf('requireMacKeychainUnlock()')).toBeLessThan(legacySafeStorageRead)
      }
      expect(reader).toContain('KeychainKeyRecoveryError) throw error')
    }
    expect(apiKeyReader).toContain('rethrowMacKeychainDecryptFailure(error)')
    expect(dustTokenReader).toContain('rethrowMacKeychainDecryptFailure(error)')
    expect(sonioxReader).toContain('rethrowMacKeychainDecryptFailure(error)')
    expect(credentialReaders).toMatch(
      /const rethrowMacKeychainDecryptFailure = \(error: unknown\): void => \{[\s\S]*?if \(app\.isPackaged && process\.platform === 'darwin'\) throw new MacKeychainUnlockRequiredError\(\)/
    )
    expect(apiKeyReader.indexOf('requireMacKeychainUnlock()')).toBeLessThan(
      apiKeyReader.indexOf('apiKeyCache.has(provider)')
    )
    expect(sonioxReader.indexOf('requireMacKeychainUnlock()')).toBeLessThan(
      sonioxReader.indexOf('sonioxKeyCache !== undefined')
    )
    expect(store).toContain('export function resetCredentialReadCachesAfterProfileUnlock(): void')
    expect(credentialReaders).toContain('apiKeyCache.clear()')
    expect(credentialReaders).toContain('sonioxKeyCache = undefined')
    expect(unlockIpc).toContain('resetCredentialReadCachesAfterProfileUnlock()')
  })

  it('routes ordinary Keychain decrypt denial back to the visible retry surface', () => {
    expect(recovery).toContain('export function isMacKeychainUnlockMessage(message: string): boolean')
    expect(recovery).toContain('message.startsWith(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)')
    expect(unlockIpc).toContain('ipcMain.handle(IPC.settingsUnlockProfile')
    expect(unlockIpc).toContain('error instanceof KeychainKeyRecoveryError')
    expect(unlockIpc).toContain('new MacKeychainUnlockRequiredError()')
    expect(unlockIpc).toContain('void hasKeysMap()\n      void getDustRefreshToken()')
    expect(unlockIpc).toContain(
      'resetMacKeychainUnlockAuthorization()\n      resetCredentialReadCachesAfterProfileUnlock()'
    )
    expect(state).toContain('isMacKeychainUnlockMessage')
    expect(unlockHook).toContain('setBootError(message)\n      throw error')
    expect(app).toContain('if (settingsBootError && isMacKeychainUnlockMessage(settingsBootError))')
    expect(unlockScreen).toContain('.finally(() => setUnlocking(false))')
  })

  it('keeps denied auth-session reads uncached so a later Keychain retry can restore the session', () => {
    expect(authCache).toContain('if (packagedMac && !isMacKeychainUnlockAuthorized())')
    expect(authCache).toContain('safeStorageDecryptFailed = true')
    expect(authCache).toContain('if (json === null && options.packagedMac && safeStorageDecryptFailed)')
    expect(authCache).toMatch(/options\.setLoaded\(false\)[\s\S]*?throw new MacKeychainUnlockRequiredError\(\)/)
    expect(authCache).toMatch(/options\.setSession\(null\)[\s\S]*?options\.setLoaded\(false\)[\s\S]*?options\.load\(\)/)
  })
})
