import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CREDENTIAL_REFUSAL_COPY, type CredentialReadRefusalCode } from '@shared/credential-inventory'

vi.mock('electron')

// Everything the app writes to its main log or audit trail during a test lands here, so a test can prove that no
// secret (and no text of an underlying error) ever reached either one. The sink survives vi.resetModules().
const sink = vi.hoisted(() => ({
  logs: [] as unknown[][],
  audits: [] as unknown[][]
}))
vi.mock('./logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger')>()
  const record =
    (target: unknown[][]) =>
    (...args: unknown[]): void => {
      target.push(args)
    }
  return {
    ...actual,
    mainLog: { error: record(sink.logs), warn: record(sink.logs), info: record(sink.logs), debug: record(sink.logs) },
    auditLog: record(sink.audits)
  }
})

const SECRET = 'synthetic-denied-read-secret-value'
/** An underlying error whose text deliberately carries the secret: the code must never forward error text. */
const hostile = (): Error => new Error(`keystore failure for ${SECRET}`)

const everything = (): string => inspect([sink.logs, sink.audits], { depth: 8, maxStringLength: 100_000 })

let userData: string
let safeStorage: typeof import('electron').safeStorage

/** vi.resetModules() gives every module a fresh electron mock, so the profile path is pinned again afterwards. */
async function rearm(): Promise<void> {
  vi.resetModules()
  const electron = await import('electron')
  safeStorage = electron.safeStorage
  ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
    name === 'userData' ? userData : join(userData, name)
  )
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
}

beforeEach(async () => {
  sink.logs.length = 0
  sink.audits.length = 0
  userData = mkdtempSync(join(tmpdir(), 'metis-denied-read-'))
  delete process.env.ASKTOTO_LOCAL_KEYSTORE
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.SONIOX_API_KEY
  await rearm()
})

afterEach(() => {
  delete process.env.ASKTOTO_LOCAL_KEYSTORE
  rmSync(userData, { recursive: true, force: true })
})

/** A blob with no format marker: the legacy shape that only the OS keystore can open. */
const legacyBlob = (): Buffer => Buffer.from('enc:legacy-ciphertext-bytes-for-the-os-keystore')
const lockKeychain = (): void => {
  vi.mocked(safeStorage.decryptString).mockImplementation(() => {
    throw hostile()
  })
}

describe('G20 (c): classifying a denied read', () => {
  it('maps each known failure to a closed code and never inspects the message for a secret', async () => {
    const { classifyCredentialReadError } = await import('./credential-read-denial')
    const { KeychainKeyRecoveryError, ProfileKeyMissingError } = await import('./secrets')
    expect(classifyCredentialReadError(new KeychainKeyRecoveryError())).toBe('keychain-locked')
    expect(classifyCredentialReadError(new ProfileKeyMissingError())).toBe('profile-key-missing')
    expect(classifyCredentialReadError(hostile())).toBe('unreadable')
    expect(classifyCredentialReadError(hostile(), 'keychain')).toBe('keychain-locked')
    expect(classifyCredentialReadError('not even an Error')).toBe('unreadable')
    expect(classifyCredentialReadError(undefined)).toBe('unreadable')
  })

  it('returns a typed refusal with fixed copy, logs and audits the code only, and dedupes repeats', async () => {
    const { noteCredentialReadDenied, lastCredentialReadRefusal } = await import('./credential-read-denial')
    const refusal = noteCredentialReadDenied('provider-api-key', hostile(), { scope: 'anthropic', via: 'keychain' })
    expect(refusal).toEqual({
      ok: false,
      code: 'keychain-locked',
      credential: 'provider-api-key',
      message: CREDENTIAL_REFUSAL_COPY['keychain-locked']
    })
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toEqual(refusal)
    expect(sink.audits).toEqual([
      ['credential.read.denied', { credential: 'provider-api-key', scope: 'anthropic', code: 'keychain-locked' }]
    ])
    // A hot read path asks again: same refusal back, no second log line or audit record.
    noteCredentialReadDenied('provider-api-key', hostile(), { scope: 'anthropic', via: 'keychain' })
    expect(sink.audits).toHaveLength(1)
    expect(everything()).not.toContain(SECRET)
    expect(everything()).not.toContain('keystore failure')
  })

  it('refuses to put anything but a plain identifier in the log scope', async () => {
    const { noteCredentialReadDenied } = await import('./credential-read-denial')
    noteCredentialReadDenied('mcp-api-key', hostile(), { scope: `../../${SECRET}` })
    expect(everything()).not.toContain(SECRET)
    expect(everything()).not.toContain('..')
  })

  it('guardedCredentialRead returns the value, or a typed refusal when the read throws', async () => {
    const { guardedCredentialRead } = await import('./credential-read-denial')
    expect(guardedCredentialRead('soniox-api-key', () => 'a-value')).toEqual({ ok: true, value: 'a-value' })
    const refused = guardedCredentialRead('soniox-api-key', () => {
      throw hostile()
    })
    expect(refused).toMatchObject({ ok: false, credential: 'soniox-api-key', code: 'unreadable' })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    expect(everything()).not.toContain(SECRET)
  })
})

describe('G20 (c): the real readers refuse without leaking when the keystore denies the read', () => {
  const cases: Array<[string, CredentialReadRefusalCode, () => void]> = [
    [
      'the system keychain is locked',
      'keychain-locked',
      () => {
        lockKeychain()
      }
    ],
    [
      'safeStorage reports encryption unavailable',
      'encryption-unavailable',
      () => {
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      }
    ],
    [
      'the local keystore is forced and the blob needs the system keychain',
      'keychain-locked',
      () => {
        process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
      }
    ]
  ]

  describe.each(cases)('when %s', (_label, code, arrange) => {
    it('provider key: getApiKey returns empty, the refusal is typed, and testApiKey says so without the secret', async () => {
      writeFileSync(join(userData, 'key-anthropic.bin'), legacyBlob())
      arrange()
      const store = await import('./store')
      const { lastCredentialReadRefusal } = await import('./credential-read-denial')
      expect(store.getApiKey('anthropic')).toBe('')
      expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toEqual({
        ok: false,
        code,
        credential: 'provider-api-key',
        message: CREDENTIAL_REFUSAL_COPY[code]
      })
      const tested = await store.testApiKey('anthropic', '')
      expect(tested).toEqual({ ok: false, error: CREDENTIAL_REFUSAL_COPY[code] })
      expect(everything()).not.toContain(SECRET)
      expect(everything()).not.toContain('legacy-ciphertext')
    })

    it('soniox key: empty value, typed refusal', async () => {
      writeFileSync(join(userData, 'key-soniox.bin'), legacyBlob())
      arrange()
      const store = await import('./store')
      const { lastCredentialReadRefusal } = await import('./credential-read-denial')
      expect(store.getSonioxApiKeyStored()).toBe('')
      expect(lastCredentialReadRefusal('soniox-api-key')).toMatchObject({ ok: false, code })
      expect(everything()).not.toContain(SECRET)
    })

    it('dust refresh token: empty value, typed refusal', async () => {
      writeFileSync(join(userData, 'dust-refresh.bin'), legacyBlob())
      arrange()
      const store = await import('./store')
      const { lastCredentialReadRefusal } = await import('./credential-read-denial')
      expect(store.getDustRefreshToken()).toBe('')
      expect(lastCredentialReadRefusal('dust-oauth-refresh')).toMatchObject({ ok: false, code })
      expect(everything()).not.toContain(SECRET)
    })

    it('mcp key: empty value, typed refusal', async () => {
      writeFileSync(join(userData, 'key-mcp-plane.bin'), legacyBlob())
      arrange()
      const { getMcpApiKey } = await import('./mcp/mcpSecrets')
      const { lastCredentialReadRefusal } = await import('./credential-read-denial')
      expect(getMcpApiKey('plane')).toBe('')
      expect(lastCredentialReadRefusal('mcp-api-key', 'plane')).toMatchObject({ ok: false, code })
      expect(everything()).not.toContain(SECRET)
    })

    it('member licence cache: no licence, typed refusal', async () => {
      writeFileSync(join(userData, 'license-cache.bin'), legacyBlob())
      arrange()
      const { readLicenseCache } = await import('./license/secret-store')
      const { lastCredentialReadRefusal } = await import('./credential-read-denial')
      expect(readLicenseCache(userData)).toBeNull()
      expect(lastCredentialReadRefusal('member-licence-cache')).toMatchObject({ ok: false })
      expect(everything()).not.toContain(SECRET)
    })
  })

  it('a wrapped profile key this build cannot unlock refuses with the keychain code and the fixed copy only', async () => {
    const store = await import('./store')
    store.setApiKey('anthropic', SECRET)
    expect(store.getApiKey('anthropic')).toBe(SECRET)
    // Replace the raw file key with bytes that look like a keychain-wrapped key (not 32 bytes, not empty).
    writeFileSync(join(userData, 'secret-key.bin'), Buffer.alloc(48, 7))
    await rearm()
    sink.audits.length = 0
    const fresh = await import('./store')
    const { lastCredentialReadRefusal } = await import('./credential-read-denial')
    expect(fresh.getApiKey('anthropic')).toBe('')
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toMatchObject({
      ok: false,
      code: 'keychain-locked'
    })
    expect(everything()).not.toContain(SECRET)
    expect(everything()).not.toContain('Unlock or grant access') // the recovery error's own text is not forwarded
  })

  it('a profile with no file key refuses with profile-key-missing', async () => {
    const store = await import('./store')
    store.setApiKey('anthropic', SECRET)
    rmSync(join(userData, 'secret-key.bin'))
    await rearm()
    sink.audits.length = 0
    const fresh = await import('./store')
    const { lastCredentialReadRefusal } = await import('./credential-read-denial')
    expect(fresh.getApiKey('anthropic')).toBe('')
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toMatchObject({
      ok: false,
      code: 'profile-key-missing'
    })
    expect(everything()).not.toContain(SECRET)
  })

  it('a corrupted blob refuses as unreadable and never echoes the blob', async () => {
    const store = await import('./store')
    store.setApiKey('anthropic', SECRET)
    const { readFileSync } = await import('node:fs')
    const blob = readFileSync(join(userData, 'key-anthropic.bin'))
    blob[blob.length - 1] ^= 0xff // break the GCM tag check
    writeFileSync(join(userData, 'key-anthropic.bin'), blob)
    await rearm()
    sink.audits.length = 0
    const fresh = await import('./store')
    const { lastCredentialReadRefusal } = await import('./credential-read-denial')
    expect(fresh.getApiKey('anthropic')).toBe('')
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toMatchObject({ ok: false, code: 'unreadable' })
    expect(everything()).not.toContain(SECRET)
    expect(everything()).not.toContain(blob.toString('base64'))
  })

  it('removing the key, then saving a new one, clears the recorded refusal', async () => {
    writeFileSync(join(userData, 'key-anthropic.bin'), legacyBlob())
    lockKeychain()
    const store = await import('./store')
    const { lastCredentialReadRefusal } = await import('./credential-read-denial')
    expect(store.getApiKey('anthropic')).toBe('')
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).not.toBeNull()
    // Saving beside an unreadable blob is refused on purpose (it could orphan the only copy), so the user removes it first.
    store.clearApiKey('anthropic')
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toBeNull()
    store.setApiKey('anthropic', SECRET)
    expect(store.getApiKey('anthropic')).toBe(SECRET)
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toBeNull()
  })

  it('an absent key is absent, not a refusal', async () => {
    const store = await import('./store')
    const { lastCredentialReadRefusal } = await import('./credential-read-denial')
    expect(store.getApiKey('anthropic')).toBe('')
    expect(lastCredentialReadRefusal('provider-api-key', 'anthropic')).toBeNull()
    expect(sink.audits).toEqual([])
  })
})
