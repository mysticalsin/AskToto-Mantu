import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { decryptSecret, encryptSecret, resetSecretKeyCache } from '../../secrets'
import { decodeSavedResult } from '../../transcripts'
import {
  generateContentKey,
  readWrappedKeyFile,
  unwrapContentKey,
  wrapContentKey,
  writeWrappedKeyFile
} from './content-key-wrap'

vi.mock('electron')

const ENC_MARKER_V2 = Buffer.from('ATKENC2\n')
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>
const appState = app as unknown as { isPackaged?: boolean }

let userData: string

/**
 * Builds an at-rest envelope exactly as the pre-extraction encryptEnvelopeV2 did: random 32-byte content key,
 * AES-256-GCM, kLocal supplied by the caller from the pre-extraction wrap expressions.
 */
function legacyEnvelope(plaintext: string, wrapLocal: (keyB64: string) => string): Buffer {
  const contentKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const env = {
    v: 2,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    kLocal: wrapLocal(contentKey.toString('base64'))
  }
  return Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')])
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'asktoto-content-key-test-'))
  mockGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
  resetSecretKeyCache()
  delete process.env.ASKTOTO_LOCAL_KEYSTORE
  appState.isPackaged = false
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(() => {
  delete process.env.ASKTOTO_LOCAL_KEYSTORE
  delete appState.isPackaged
  resetSecretKeyCache()
  rmSync(userData, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('content-key wrap: compatibility with envelopes written before the extraction', () => {
  it("decrypts a pre-extraction 'F:' envelope", () => {
    const buf = legacyEnvelope('FILE-BACKEND-BODY', (b64) => 'F:' + encryptSecret(b64).toString('base64'))
    expect(decodeSavedResult(buf)).toEqual({ ok: true, text: 'FILE-BACKEND-BODY' })
  })

  it("decrypts a pre-extraction 'S:' envelope", () => {
    const buf = legacyEnvelope('KEYCHAIN-BODY', (b64) => 'S:' + safeStorage.encryptString(b64).toString('base64'))
    expect(decodeSavedResult(buf)).toEqual({ ok: true, text: 'KEYCHAIN-BODY' })
  })

  it('decrypts a pre-extraction legacy bare-base64 envelope', () => {
    const buf = legacyEnvelope('BARE-BODY', (b64) => safeStorage.encryptString(b64).toString('base64'))
    expect(decodeSavedResult(buf)).toEqual({ ok: true, text: 'BARE-BODY' })
  })

  it("refuses a pre-extraction 'S:' envelope under the forced local keystore, with the original reason", () => {
    const buf = legacyEnvelope('KEYCHAIN-BODY', (b64) => 'S:' + safeStorage.encryptString(b64).toString('base64'))
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    expect(decodeSavedResult(buf)).toEqual({
      ok: false,
      reason: 'Keychain-wrapped transcript is unavailable while the local keystore is active'
    })
  })

  it('wrapped values are byte-compatible with the old expressions (wrap form decrypts via the old unwrap path)', () => {
    const key = generateContentKey()
    const wrapped = wrapContentKey(key)
    expect(wrapped.ok).toBe(true)
    if (!wrapped.ok) return
    // Old unwrap: strip 'F:', decryptSecret(base64 -> buffer) yields the base64 text of the key.
    expect(decryptSecret(Buffer.from(wrapped.wrapped.slice(2), 'base64'))).toBe(key.toString('base64'))
  })
})

describe('content-key wrap: generate / wrap / unwrap', () => {
  it('generates distinct 32-byte keys', () => {
    const a = generateContentKey()
    const b = generateContentKey()
    expect(a).toHaveLength(32)
    expect(a.equals(b)).toBe(false)
  })

  it("round-trips through the file backend ('F:') when not packaged", () => {
    const key = generateContentKey()
    const wrapped = wrapContentKey(key)
    expect(wrapped.ok && wrapped.wrapped.startsWith('F:')).toBe(true)
    if (!wrapped.ok) return
    expect(wrapped.wrapped).not.toContain(key.toString('base64'))
    const unwrapped = unwrapContentKey(wrapped.wrapped)
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return
    expect(unwrapped.key.equals(key)).toBe(true)
    expect(unwrapped.keychainRecovery).toBe(false)
  })

  it("round-trips through safeStorage ('S:') when packaged with an available keychain", () => {
    appState.isPackaged = true
    const key = generateContentKey()
    const wrapped = wrapContentKey(key)
    expect(wrapped.ok && wrapped.wrapped.startsWith('S:')).toBe(true)
    if (!wrapped.ok) return
    expect(safeStorage.encryptString).toHaveBeenCalledWith(key.toString('base64'))
    const unwrapped = unwrapContentKey(wrapped.wrapped)
    expect(unwrapped.ok).toBe(true)
    if (!unwrapped.ok) return
    expect(unwrapped.key.equals(key)).toBe(true)
  })

  it('falls back to the file backend when packaged but safeStorage is unavailable', () => {
    appState.isPackaged = true
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const wrapped = wrapContentKey(generateContentKey())
    expect(wrapped.ok && wrapped.wrapped.startsWith('F:')).toBe(true)
  })

  it("reads a legacy bare-base64 keychain value as 'S:'", () => {
    const key = generateContentKey()
    const bare = safeStorage.encryptString(key.toString('base64')).toString('base64')
    const unwrapped = unwrapContentKey(bare)
    expect(unwrapped.ok && unwrapped.key.equals(key)).toBe(true)
  })

  it("local keystore refuses 'S:' and legacy bare values, but still unwraps 'F:'", () => {
    const key = generateContentKey()
    const s = 'S:' + safeStorage.encryptString(key.toString('base64')).toString('base64')
    const f = wrapContentKey(key)
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    const refused = unwrapContentKey(s)
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.reason).toBe('refused')
      expect(String(refused.error)).toBe(
        'Error: Keychain-wrapped transcript is unavailable while the local keystore is active'
      )
    }
    expect(unwrapContentKey(s.slice(2)).ok).toBe(false)
    expect(f.ok && unwrapContentKey(f.wrapped).ok).toBe(true)
  })

  it("explicit keychain recovery lets the local keystore read 'S:' and reports it", () => {
    const key = generateContentKey()
    const s = 'S:' + safeStorage.encryptString(key.toString('base64')).toString('base64')
    process.env.ASKTOTO_LOCAL_KEYSTORE = '1'
    const recovered = unwrapContentKey(s, { allowKeychainRecovery: true })
    expect(recovered.ok && recovered.key.equals(key) && recovered.keychainRecovery).toBe(true)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(unwrapContentKey(s, { allowKeychainRecovery: true }).ok).toBe(false)
  })

  it('returns unavailable (never throws) for malformed, truncated and foreign input', () => {
    const truncatedV10 = Buffer.concat([Buffer.from('v10'), Buffer.alloc(4)]).toString('base64')
    for (const wrapped of ['S:', 'S:' + truncatedV10, 'F:', 'F:AAAA', 'F:' + Buffer.alloc(64).toString('base64')]) {
      const result = unwrapContentKey(wrapped)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('unavailable')
    }
    expect(vi.mocked(safeStorage.decryptString)).not.toHaveBeenCalledWith(Buffer.from(truncatedV10, 'base64'))
  })

  it('reports wrap failure as unavailable instead of falling through to cleartext', () => {
    appState.isPackaged = true
    vi.mocked(safeStorage.encryptString).mockImplementationOnce(() => {
      throw new Error('keychain locked')
    })
    const result = wrapContentKey(generateContentKey())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
  })
})

describe('content-key wrap: key file', () => {
  let dir: string
  beforeEach(() => {
    dir = join(userData, 'meeting-journal', '00000000-0000-8000-8000-000000000000')
  })

  it('round-trips a wrapped key with mode 0600 and no temp leftovers', async () => {
    const key = generateContentKey()
    const wrapped = wrapContentKey(key)
    if (!wrapped.ok) throw new Error('wrap failed')
    const path = join(dir, 'key.v1')
    expect(await writeWrappedKeyFile(path, wrapped.wrapped)).toEqual({ ok: true })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['key.v1'])
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain(key.toString('base64'))
    const read = await readWrappedKeyFile(path)
    expect(read).toEqual({ ok: true, wrapped: wrapped.wrapped })
    const unwrapped = read.ok ? unwrapContentKey(read.wrapped) : undefined
    expect(unwrapped?.ok && unwrapped.key.equals(key)).toBe(true)
  })

  it('replaces an existing key file atomically', async () => {
    const path = join(dir, 'key.v1')
    await writeWrappedKeyFile(path, 'F:AAAA')
    await writeWrappedKeyFile(path, 'S:BBBB')
    expect(await readWrappedKeyFile(path)).toEqual({ ok: true, wrapped: 'S:BBBB' })
  })

  it('refuses to write an unprefixed or non-base64 value', async () => {
    for (const bad of ['', 'AAAA', 'F:', 'F:not base64!', 'X:AAAA']) {
      const result = await writeWrappedKeyFile(join(dir, 'key.v1'), bad)
      expect(result.ok).toBe(false)
    }
  })

  it('returns missing for an absent file and an absent directory', async () => {
    expect(await readWrappedKeyFile(join(dir, 'key.v1'))).toEqual({ ok: false, reason: 'missing' })
    mkdirSync(dir, { recursive: true })
    expect(await readWrappedKeyFile(join(dir, 'key.v1'))).toEqual({ ok: false, reason: 'missing' })
  })

  it('returns corrupt for malformed, wrong-version, oversized and non-regular files', async () => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'key.v1')
    const cases: Array<string | Buffer> = [
      '',
      'not json',
      '{"v":2,"kLocal":"F:AAAA"}',
      '{"v":1}',
      '{"v":1,"kLocal":"AAAA"}',
      '{"v":1,"kLocal":42}',
      Buffer.alloc(8192, 0x41)
    ]
    for (const content of cases) {
      writeFileSync(path, content)
      expect(await readWrappedKeyFile(path)).toEqual({ ok: false, reason: 'corrupt' })
    }
    const target = join(dir, 'target')
    writeFileSync(target, '{"v":1,"kLocal":"F:AAAA"}')
    const link = join(dir, 'link')
    symlinkSync(target, link)
    expect(await readWrappedKeyFile(link)).toEqual({ ok: false, reason: 'corrupt' })
    expect(await readWrappedKeyFile(dir)).toEqual({ ok: false, reason: 'corrupt' })
  })

  it('returns unavailable when the file cannot be written', async () => {
    mkdirSync(userData, { recursive: true })
    const blocker = join(userData, 'blocker')
    writeFileSync(blocker, 'x')
    const result = await writeWrappedKeyFile(join(blocker, 'key.v1'), 'F:AAAA')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
  })
})
