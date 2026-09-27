import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import {
  KeychainKeyRecoveryError,
  decryptSecret,
  encryptSecret,
  prepareFileKeyForWrite,
  resetSecretKeyCache
} from './secrets'

vi.mock('electron')

// secrets.ts caches the per-install key in-module, so a single key (bound to the mocked userData
// path) is reused across these assertions — exactly what encrypt→decrypt round-trips need.
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>

describe('secrets — AES-256-GCM file keystore', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-secrets-test-'))
    mockGetPath.mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('round-trips a normal (multi-byte) string', () => {
    expect(decryptSecret(encryptSecret('hello-世界'))).toBe('hello-世界')
  })

  // Regression: a valid AES-GCM envelope for empty plaintext is exactly IV(12)+tag(16)=28 bytes with
  // zero ciphertext. The length floor must be IV_LEN+TAG_LEN, not +1, or the empty string is rejected.
  it('round-trips an EMPTY string (28-byte envelope must not be rejected)', () => {
    const env = encryptSecret('')
    expect(env.length).toBe(28)
    expect(decryptSecret(env)).toBe('')
  })

  it('uses a fresh IV per call — identical plaintext yields distinct ciphertext', () => {
    expect(encryptSecret('x').equals(encryptSecret('x'))).toBe(false)
  })

  it('fails closed on a buffer too short to be a valid envelope', () => {
    expect(() => decryptSecret(Buffer.alloc(20))).toThrow()
  })

  it('fails closed when the auth tag is tampered (no silent plaintext)', () => {
    const env = encryptSecret('secret')
    env[15] ^= 0xff // flip a byte inside the 16-byte GCM tag (offsets 12..27)
    expect(() => decryptSecret(env)).toThrow()
  })

  it('fails closed when the ciphertext is tampered', () => {
    const env = encryptSecret('secret-payload')
    env[env.length - 1] ^= 0xff // flip a ciphertext byte → tag check fails
    expect(() => decryptSecret(env)).toThrow()
  })

  describe('the key file — only a write creates it', () => {
    const keyFile = (): string => join(userData, 'secret-key.bin')
    /** IV + tag + 16 ciphertext bytes under a key this profile never held: a file synced from another install. */
    const envelopeFromAnotherInstall = (): Buffer => randomBytes(12 + 16 + 16)

    // Each case starts as a new process would: nothing cached, so every key access goes to disk.
    beforeEach(() => resetSecretKeyCache())

    it('a decrypt on a profile with no key file fails and writes nothing', () => {
      expect(() => decryptSecret(envelopeFromAnotherInstall())).toThrow('no file key')
      expect(readdirSync(userData)).toEqual([])
    })

    it('a decrypt treats a zero-byte key file as no key and leaves it empty', () => {
      writeFileSync(keyFile(), Buffer.alloc(0))
      expect(() => decryptSecret(envelopeFromAnotherInstall())).toThrow('no file key')
      expect(readFileSync(keyFile())).toHaveLength(0)
    })

    it('a decrypt against a key file it cannot unwrap fails closed with KeychainKeyRecoveryError, bytes intact', () => {
      const wrapped = Buffer.from('a-key-wrapped-by-an-older-signed-build')
      writeFileSync(keyFile(), wrapped)
      expect(() => decryptSecret(envelopeFromAnotherInstall())).toThrow(KeychainKeyRecoveryError)
      expect(readFileSync(keyFile())).toEqual(wrapped)
    })

    it('the first encrypt creates the key, and the next process decrypts with that same key', () => {
      const envelope = encryptSecret('first-write')
      const key = readFileSync(keyFile())
      expect(key).toHaveLength(32) // unpackaged mock: canWrap is false, so the key is raw
      resetSecretKeyCache()
      expect(decryptSecret(envelope)).toBe('first-write')
      expect(readFileSync(keyFile())).toEqual(key)
    })

    it('prepareFileKeyForWrite creates the key on a keyless file-backend profile', () => {
      prepareFileKeyForWrite()
      expect(readFileSync(keyFile())).toHaveLength(32)
    })
  })
})
