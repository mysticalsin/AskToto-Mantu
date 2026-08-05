import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync as readSource } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The forced local keystore (ASKTOTO_LOCAL_KEYSTORE) is a macOS-only workaround for an un-notarized
 * build's Keychain prompt. On Windows it made useFileBackend() permanently true, which made canWrap
 * permanently false, which wrote the AES-256 master key to secret-key.bin as 32 RAW bytes beside the
 * ciphertext it protects. These tests pin the platform split and, more importantly, prove that an
 * EXISTING Windows profile survives the flip: same key, same ciphertext, nothing regenerated.
 *
 * The whole point is the upgrade, so each migration test really does write a profile through the OLD
 * code path (module registry reset, ASKTOTO_LOCAL_KEYSTORE set) and then re-imports every consumer
 * through the NEW one (registry reset, var unset) against the SAME userData directory.
 */

vi.mock('electron')

// safeStorage on Windows is DPAPI: it never prompts, and it throws for a blob belonging to another
// Windows account. The default electron mock's decryptString passes unknown bytes through unchanged,
// which would let a raw AES-GCM buffer "decrypt" to garbage instead of failing — so model it strictly.
const DPAPI_PREFIX = 'dpapi:'

type ElectronModule = typeof import('electron')
type Mock = ReturnType<typeof vi.fn>

interface BootOptions {
  /** app.isPackaged — canWrap requires a packaged build. */
  packaged?: boolean
  /** Simulates the pre-fix build (and the operator/QA override) forcing the file keystore. */
  forceLocalKeystore?: boolean
  /** 'ok' = this Windows account owns the blob · 'denied' = another account · 'unavailable' = no DPAPI. */
  dpapi?: 'ok' | 'denied' | 'unavailable'
}

let userData: string
let priorLocalKeystore: string | undefined

/** Reset the module registry and bring the whole main-process keystore stack up under one config. */
async function boot({
  packaged = true,
  forceLocalKeystore = false,
  dpapi = 'ok'
}: BootOptions = {}): Promise<ElectronModule> {
  vi.resetModules()
  if (forceLocalKeystore) process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
  else delete process.env.ASKTOTO_LOCAL_KEYSTORE

  const electron = await import('electron')
  ;(electron.app as unknown as { isPackaged: boolean }).isPackaged = packaged
  ;(electron.app.getPath as Mock).mockImplementation((name: string) =>
    name === 'userData' ? userData : join(userData, name)
  )
  ;(electron.safeStorage.isEncryptionAvailable as Mock).mockReturnValue(dpapi !== 'unavailable')
  ;(electron.safeStorage.encryptString as Mock).mockImplementation((value: string) =>
    Buffer.from(DPAPI_PREFIX + value, 'utf8')
  )
  ;(electron.safeStorage.decryptString as Mock).mockImplementation((buf: Buffer) => {
    if (dpapi !== 'ok') throw new Error('DPAPI: the data is bound to a different Windows account')
    const s = buf.toString('utf8')
    if (!s.startsWith(DPAPI_PREFIX)) throw new Error('DPAPI: not a protected blob')
    return s.slice(DPAPI_PREFIX.length)
  })
  return electron
}

const keyFile = (): string => join(userData, 'secret-key.bin')
const meetingFile = (): string => join(userData, '2026-08-05-board-sync.md')
const REAL_API_KEY = 'sk-proj-not-a-real-key-0123456789'
const TRANSCRIPT_BODY = '# Board sync\n\nWe agreed to ship on Friday.'

/**
 * Write a full profile exactly the way the shipped 1.5.x Windows build did: forced local keystore, so
 * secret-key.bin is 32 RAW bytes and every consumer is on the AES-GCM file backend.
 * Returns the raw key so later assertions can prove the SAME key survives, not just "something works".
 */
async function seedLegacyWindowsProfile(): Promise<Buffer> {
  await boot({ packaged: true, forceLocalKeystore: true, dpapi: 'ok' })
  const { setSettings, setApiKey } = await import('./store')
  const { encryptSecret } = await import('./secrets')
  const { writeSaved } = await import('./transcripts')

  setSettings({ recordingConsent: true, temperature: 0.42 })
  setApiKey('openai', REAL_API_KEY)
  await writeSaved(meetingFile(), TRANSCRIPT_BODY, true)
  writeFileSync(
    join(userData, 'auth-session.bin'),
    encryptSecret(JSON.stringify({ email: 'tony@mantu.com', domain: 'mantu.com', tid: 'tid', at: Date.now() })),
    { mode: 0o600 }
  )

  const rawKey = readFileSync(keyFile())
  // Precondition for the whole exercise: the old build really did leave a usable key in the clear.
  expect(rawKey).toHaveLength(32)
  return rawKey
}

describe('windows keystore — the forced local keystore is darwin-only', () => {
  // index.ts boots Electron on import (BrowserWindow, globalShortcut, crashReporter), so its wiring is
  // pinned via the raw source text — the same structural-proof pattern as c-main-fixes.contract.test.ts.
  const source = readSource(join(__dirname, 'index.ts'), 'utf8')

  it('gates the forced local keystore on darwin instead of applying it to every platform', () => {
    expect(source).toContain("if (process.platform === 'darwin') process.env.ASKTOTO_LOCAL_KEYSTORE ??= '1'")
  })

  it('has no unconditional assignment left that would re-force it on Windows', () => {
    const assignments = source.match(/^.*process\.env\.ASKTOTO_LOCAL_KEYSTORE\s*(?:\?\?)?=(?!=).*$/gm) ?? []
    expect(assignments).toHaveLength(1)
    expect(assignments[0]).toMatch(/process\.platform === 'darwin'/)
  })

  it('still honours an explicit operator/QA override on both platforms (nullish-assign, not assign)', () => {
    expect(source).toMatch(/ASKTOTO_LOCAL_KEYSTORE \?\?= '1'/)
    expect(source).not.toMatch(/ASKTOTO_LOCAL_KEYSTORE = '1'/)
  })
})

describe('windows keystore — an existing raw-key profile survives the flip to DPAPI', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-win-dpapi-'))
    priorLocalKeystore = process.env.ASKTOTO_LOCAL_KEYSTORE
  })

  afterEach(() => {
    if (priorLocalKeystore === undefined) delete process.env.ASKTOTO_LOCAL_KEYSTORE
    else process.env.ASKTOTO_LOCAL_KEYSTORE = priorLocalKeystore
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  it('reads back the real saved API key, settings and transcript after the upgrade', async () => {
    await seedLegacyWindowsProfile()

    // ── the upgrade: same profile folder, keystore no longer forced ──
    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'ok' })
    const { getApiKey, getSettings } = await import('./store')
    const { readSavedFile } = await import('./transcripts')
    const { useFileBackend } = await import('./secrets')

    expect(useFileBackend()).toBe(false) // the flip actually happened
    expect(getSettings().temperature).toBe(0.42)
    expect(getApiKey('openai')).toBe(REAL_API_KEY)
    expect(readSavedFile(meetingFile())).toContain('We agreed to ship on Friday.')
  })

  it('re-wraps the SAME key with DPAPI instead of regenerating or leaving it in the clear', async () => {
    const rawKey = await seedLegacyWindowsProfile()

    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'ok' })
    const { getSettings } = await import('./store')
    getSettings() // first decrypt is what triggers the in-place key migration

    const onDisk = readFileSync(keyFile())
    expect(onDisk.equals(rawKey)).toBe(false) // no longer a bare, directly usable AES key
    expect(onDisk.toString('utf8')).toBe(DPAPI_PREFIX + rawKey.toString('base64')) // ...but the same key
  })

  it('keeps an existing signed-in session instead of silently signing the user out', async () => {
    await seedLegacyWindowsProfile()

    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'ok' })
    const { authStatus } = await import('./auth')

    expect(authStatus().signedIn).toBe(true)
  })

  it('leaves the old key intact when the re-wrap fails midway instead of bricking the profile', async () => {
    // This migration runs on the BOOT READ path for every upgrading Windows user, and secret-key.bin is
    // the only copy of the KEK. An in-place writeFileSync truncates before it writes, so a crash, an
    // EDR/AV handle denial or ENOSPC in that window would leave a 0-byte key and make every existing
    // ciphertext permanently unreadable — a state the pre-flip build could still self-heal from by
    // regenerating. Fault is injected for real, not mocked: a DIRECTORY squatting on the tmp path makes
    // the write throw EISDIR/EPERM, which is exactly the "interrupted before rename" shape.
    const rawKey = await seedLegacyWindowsProfile()
    mkdirSync(`${keyFile()}.migrate.tmp`, { recursive: true })

    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'ok' })
    const { getApiKey, getSettings } = await import('./store')

    // The session still works off the in-memory key — the failed migration must not be fatal.
    expect(getSettings().temperature).toBe(0.42)
    expect(getApiKey('openai')).toBe(REAL_API_KEY)
    // ...and the on-disk key is untouched, so the NEXT launch can still read the profile and retry.
    expect(readFileSync(keyFile()).equals(rawKey)).toBe(true)
  })

  it('needs no re-encryption of user data — the pre-upgrade ciphertext files are byte-identical', async () => {
    await seedLegacyWindowsProfile()
    const before = {
      settings: readFileSync(join(userData, 'settings.json')),
      apiKey: readFileSync(join(userData, 'key-openai.bin')),
      meeting: readFileSync(meetingFile())
    }

    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'ok' })
    const { getApiKey, getSettings } = await import('./store')
    const { readSavedFile } = await import('./transcripts')
    getSettings()
    getApiKey('openai')
    readSavedFile(meetingFile())

    expect(readFileSync(join(userData, 'settings.json'))).toEqual(before.settings)
    expect(readFileSync(join(userData, 'key-openai.bin'))).toEqual(before.apiKey)
    expect(readFileSync(meetingFile())).toEqual(before.meeting)
  })
})

describe('windows keystore — fail-closed when DPAPI cannot unwrap the key', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-win-dpapi-denied-'))
    priorLocalKeystore = process.env.ASKTOTO_LOCAL_KEYSTORE
  })

  afterEach(() => {
    if (priorLocalKeystore === undefined) delete process.env.ASKTOTO_LOCAL_KEYSTORE
    else process.env.ASKTOTO_LOCAL_KEYSTORE = priorLocalKeystore
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  /** Seed, then upgrade once under a working DPAPI so the key file ends up wrapped. */
  async function seedThenWrap(): Promise<Buffer> {
    await seedLegacyWindowsProfile()
    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'ok' })
    const { getSettings } = await import('./store')
    getSettings()
    const wrapped = readFileSync(keyFile())
    expect(wrapped.toString('utf8').startsWith(DPAPI_PREFIX)).toBe(true)
    return wrapped
  }

  it('refuses a settings write and leaves the key + ciphertext untouched (different Windows account)', async () => {
    const wrapped = await seedThenWrap()
    const settingsBefore = readFileSync(join(userData, 'settings.json'))
    const apiKeyBefore = readFileSync(join(userData, 'key-openai.bin'))

    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'denied' })
    const { setSettings } = await import('./store')

    expect(() => setSettings({ recordingConsent: true })).toThrow(
      'Métis could not unlock the existing encrypted profile'
    )
    expect(readFileSync(keyFile())).toEqual(wrapped)
    expect(readFileSync(join(userData, 'settings.json'))).toEqual(settingsBefore)
    expect(readFileSync(join(userData, 'key-openai.bin'))).toEqual(apiKeyBefore)
  })

  it('names the Windows credential store in the error so the recovery UI can offer the escape hatch', async () => {
    await seedThenWrap()
    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'denied' })
    const { setSettings } = await import('./store')

    let message = ''
    try {
      setSettings({ recordingConsent: true })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    // Onboarding.tsx / Settings.tsx reveal the recoverEncryptedProfile action on this exact shape.
    expect(message).toMatch(/keychain|encrypted profile|secret.?key/i)
    if (process.platform === 'win32') expect(message).toContain('the Windows credential store')
  })

  it('refuses to overwrite an existing provider key file it cannot read', async () => {
    await seedThenWrap()
    const apiKeyBefore = readFileSync(join(userData, 'key-openai.bin'))

    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'denied' })
    const { setApiKey } = await import('./store')

    expect(() => setApiKey('openai', 'sk-replacement')).toThrow(
      'Métis could not unlock the existing encrypted profile'
    )
    expect(readFileSync(join(userData, 'key-openai.bin'))).toEqual(apiKeyBefore)
  })
})

describe('windows keystore — the cases that must NOT change', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-win-dpapi-unchanged-'))
    priorLocalKeystore = process.env.ASKTOTO_LOCAL_KEYSTORE
  })

  afterEach(() => {
    if (priorLocalKeystore === undefined) delete process.env.ASKTOTO_LOCAL_KEYSTORE
    else process.env.ASKTOTO_LOCAL_KEYSTORE = priorLocalKeystore
    vi.restoreAllMocks()
    rmSync(userData, { recursive: true, force: true })
  })

  it('unpackaged/dev runs still use the raw file backend and never touch the credential store', async () => {
    const electron = await boot({ packaged: false, forceLocalKeystore: false, dpapi: 'ok' })
    const { setSettings } = await import('./store')
    const { useFileBackend } = await import('./secrets')

    setSettings({ recordingConsent: true })

    expect(useFileBackend()).toBe(true)
    expect(readFileSync(keyFile())).toHaveLength(32) // canWrap requires app.isPackaged
    expect(electron.safeStorage.encryptString).not.toHaveBeenCalled()
  })

  it('an explicit operator override still forces the file keystore on a packaged Windows build', async () => {
    const electron = await boot({ packaged: true, forceLocalKeystore: true, dpapi: 'ok' })
    const { setSettings } = await import('./store')
    const { useFileBackend } = await import('./secrets')

    setSettings({ recordingConsent: true })

    expect(useFileBackend()).toBe(true)
    expect(readFileSync(keyFile())).toHaveLength(32)
    expect(electron.safeStorage.encryptString).not.toHaveBeenCalled()
    expect(electron.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('a fresh packaged install creates no file key at all (nothing left in the clear)', async () => {
    await boot({ packaged: true, forceLocalKeystore: false, dpapi: 'ok' })
    const { setSettings, setApiKey, getApiKey } = await import('./store')

    setSettings({ recordingConsent: true })
    setApiKey('openai', REAL_API_KEY)

    expect(existsSync(keyFile())).toBe(false)
    expect(getApiKey('openai')).toBe(REAL_API_KEY)
  })
})
