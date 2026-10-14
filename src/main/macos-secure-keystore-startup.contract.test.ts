import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const secrets = readFileSync(join(root, 'src/main/secrets.ts'), 'utf8')
const store = readFileSync(join(root, 'src/main/store.ts'), 'utf8')
const auth = readFileSync(join(root, 'src/main/auth.ts'), 'utf8')
const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
const state = readFileSync(join(root, 'src/renderer/src/state.ts'), 'utf8')
const recovery = readFileSync(join(root, 'src/shared/encrypted-profile-recovery.ts'), 'utf8')

describe('packaged macOS secure-keystore startup', () => {
  it('does not force the raw file keystore for Darwin', () => {
    expect(main).not.toMatch(/process\.platform\s*===\s*['"]darwin['"]\s*\)\s*process\.env\.ASKTOTO_LOCAL_KEYSTORE/)
    expect(secrets).toContain('if (packagedMacRequiresKeychain()) {')
    expect(secrets).toContain('throw new KeychainKeyRecoveryError()')
  })

  it('shows an explicit unlock action before retrying a locked encrypted profile', () => {
    expect(state).toContain('if (isMacKeychainUnlockMessage(message))')
    expect(app).toContain("isMacKeychainUnlockMessage(settingsBootError)")
    expect(app).toContain('Unlock secure storage')
    expect(app).toContain('Continue to Keychain')
    expect(app).toContain('unlockEncryptedProfile()')
    expect(app).toContain('Denying access')
    expect(app).toContain('leaves your files unchanged.')
  })

  it('can paint the locked-profile surface without reading profile settings', () => {
    expect(main).toMatch(/function liveOverlayLayout\(\): OverlayLayout \{[\s\S]*?catch \{[\s\S]*?return DEFAULT_OVERLAY_LAYOUT/)
    expect(main).toMatch(/function liveOverlayPlacement\(\): OverlayPlacement \{[\s\S]*?catch \{[\s\S]*?return 'top-center'/)
    expect(main).toContain('DEFAULT_OVERLAY_LAYOUT,')
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
    expect(rawReadPath).toContain("return tryRecoveredSettings() ?? {}")
    expect(settingsReadPath).not.toContain('serializeUserRaw(')
    expect(settingsReadPath).not.toContain('encryptSecret(')
    expect(rawReadPath).not.toContain('encryptSecret(')
  })

  it('completes boot setup while locked and resumes deferred startup work once after unlock', () => {
    expect(main).toContain('deferredMacProfileBootSteps.set(name, run)')
    expect(main).toContain('deferredMacProfileBootSteps.clear()')
    expect(main).toContain('startupBootInitializationComplete = true')
    expect(main).toContain('deferMacProfileBootStep(name, () => runStep(name, fn))')
    expect(main).toContain("deferMacProfileBootStep('applyOperatorBootstrapSettings', applyOperatorBootstrapSettings)")
    expect(main).toContain('startupBootWorkReleased = true')
    expect(main).toContain('releaseStartupBootWorkIfReady()')
    expect(main).toContain('resumeDeferredMacProfileBootSteps()')
    expect(main).toContain('if (!isMacProfileUnlockError(e)) throw e')
    expect(main).toContain('if (isMacProfileUnlockError(e)) {\n              deferMacProfileBootStep(name, () => runStep(name, fn))')
    expect(auth).toContain('json === null && !useFileBackend() && safeStorage.isEncryptionAvailable()')
    expect(auth).toContain('export function reloadSessionAfterProfileUnlock(): void')
  })

  it('does not probe safeStorage or allow a raw-key override before the explicit Mac unlock', () => {
    expect(secrets).toMatch(/if \(packagedMacRequiresKeychain\(\) && !_macKeychainUnlockConfirmed\) return true/)
    expect(secrets).toMatch(/function packagedMacRequiresKeychain\(\): boolean \{[\s\S]*?return app\.isPackaged && process\.platform === 'darwin'/)
    expect(secrets).toMatch(/requireMacKeychainUnlock\(\)\s+const keychainAvailable = !localKeystoreForced && isKeychainAvailable\(\)/)
    expect(main).toContain("if (app.isPackaged && process.platform === 'darwin') requireMacKeychainUnlock()")
    expect(main).toContain('error instanceof KeychainKeyRecoveryError) {\n        throw new MacKeychainUnlockRequiredError()')
    expect(main).toContain('reloadSessionAfterProfileUnlock()')
    expect(main).toContain('prepareFileKeyForWrite()')
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
    const unlockSurface = app.slice(unlockSurfaceStart, onboardingStart)
    expect(unlockSurface).toContain('Continue to Keychain')
    expect(unlockSurface).not.toMatch(/recoverEncryptedProfile|archiveEncryptedProfile|Create new local profile|provisionalOnboardingSettings/)
    expect(state).toContain('if (isMacKeychainUnlockMessage(message))')
    expect(store).toContain('requireMacKeychainUnlock()')
    expect(store).toContain('throw error')
  })

  it('gates legacy encrypted credential readers and does not cache unlock failures', () => {
    const section = (start: string, end: string): string => {
      const from = store.indexOf(start)
      const to = store.indexOf(end, from)
      expect(from).toBeGreaterThanOrEqual(0)
      expect(to).toBeGreaterThan(from)
      return store.slice(from, to)
    }
    const apiKeyReader = section('export function getApiKey(', 'export function hasApiKey(')
    const dustTokenReader = section('export function getDustRefreshToken(', '/** Returns false when the token file')
    const sonioxReader = section('export function getSonioxApiKeyStored(', '/** Seated Soniox key')

    for (const reader of [apiKeyReader, dustTokenReader, sonioxReader]) {
      expect(reader.indexOf('requireMacKeychainUnlock()')).toBeGreaterThanOrEqual(0)
      const legacySafeStorageRead = reader.indexOf('safeStorage.isEncryptionAvailable()')
      if (legacySafeStorageRead >= 0) {
        expect(reader.indexOf('requireMacKeychainUnlock()')).toBeLessThan(legacySafeStorageRead)
      }
      expect(reader).toContain('e instanceof KeychainKeyRecoveryError) throw e')
    }
    expect(apiKeyReader).toContain('rethrowMacKeychainDecryptFailure(e)')
    expect(dustTokenReader).toContain('rethrowMacKeychainDecryptFailure(e)')
    expect(sonioxReader).toContain('rethrowMacKeychainDecryptFailure(e)')
    expect(store).toMatch(/function rethrowMacKeychainDecryptFailure\(error: unknown\): void \{[\s\S]*?if \(app\.isPackaged && process\.platform === 'darwin'\) throw new MacKeychainUnlockRequiredError\(\)/)
    expect(apiKeyReader.indexOf('requireMacKeychainUnlock()')).toBeLessThan(apiKeyReader.indexOf('_apiKeyCache.has(provider)'))
    expect(sonioxReader.indexOf('requireMacKeychainUnlock()')).toBeLessThan(sonioxReader.indexOf('_sonioxKeyCache !== undefined'))
    expect(store).toContain('export function resetCredentialReadCachesAfterProfileUnlock(): void')
    expect(store).toContain('_apiKeyCache.clear()\n  _sonioxKeyCache = undefined')
    expect(main).toContain('resetCredentialReadCachesAfterProfileUnlock()')
  })

  it('routes ordinary Keychain decrypt denial back to the visible retry surface', () => {
    expect(recovery).toContain('export function isMacKeychainUnlockMessage(message: string): boolean')
    expect(recovery).toContain('message.startsWith(MAC_KEYCHAIN_UNLOCK_REQUIRED_PREFIX)')
    expect(main).toMatch(/ipcMain\.handle\(IPC\.settingsUnlockProfile,[\s\S]*?error instanceof KeychainKeyRecoveryError\)[\s\S]*?throw new MacKeychainUnlockRequiredError\(\)/)
    expect(main).toContain('void hasKeysMap()\n      void getDustRefreshToken()')
    expect(main).toContain('resetMacKeychainUnlockAuthorization()\n      resetCredentialReadCachesAfterProfileUnlock()')
    expect(state).toContain('if (isMacKeychainUnlockMessage(message)) {\n            if (!cancelled) setBootError(message)')
    expect(state).toContain('setBootError(message)\n      throw e')
    expect(app).toContain("if (settingsBootError && isMacKeychainUnlockMessage(settingsBootError))")
    expect(app).toContain(".finally(() => setUnlockingEncryptedProfile(false))")
  })
})
