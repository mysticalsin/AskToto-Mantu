import { describe, expect, it } from 'vitest'
import { decryptEmbeddedBlob } from './embedded-cloudflare-crypto'
import {
  decryptProxyKey,
  encryptProxyKey,
  isEncryptedBlob,
  loadMaterial
} from '../../scripts/lib/embedded-cloudflare-crypto.mjs'

// A stand-in for a real METIS_PROXY_KEY. NEVER a real token — the crypto is format-agnostic, so a dummy
// that merely satisfies the runtime's proxy-key shape (>=20 chars of [A-Za-z0-9+/_=-]) proves everything.
const DUMMY_TOKEN = 'cfut_test_dummy_0123456789ABCDEFghij+/='

describe('embedded-cloudflare crypto — the SHIPPED decryptor against the BUILD-TIME encryptor', () => {
  it('round-trips: a blob encrypted by the build script decrypts to the same token at runtime', () => {
    const blob = encryptProxyKey(DUMMY_TOKEN)
    // The runtime decryptor (src/main) is a separate implementation from the build-time one (scripts/lib);
    // this proves they agree, which is the whole reason both read embedded-key-material.json.
    expect(decryptEmbeddedBlob(blob)).toBe(DUMMY_TOKEN)
    // ...and the build-time decrypt agrees with itself too.
    expect(decryptProxyKey(blob)).toBe(DUMMY_TOKEN)
  })

  it('produces the encrypted shape and NEVER a plaintext proxyKey field', () => {
    const blob = encryptProxyKey(DUMMY_TOKEN)
    expect(isEncryptedBlob(blob)).toBe(true)
    expect(blob).not.toHaveProperty('proxyKey')
    expect(blob.alg).toBe('aes-256-gcm')
    const fields = blob as unknown as Record<string, string>
    for (const f of ['salt', 'iv', 'tag', 'ciphertext']) {
      expect(typeof fields[f]).toBe('string')
      expect(fields[f].length).toBeGreaterThan(0)
    }
  })

  it('does not leak the plaintext token anywhere in the serialized blob', () => {
    const blob = encryptProxyKey(DUMMY_TOKEN)
    const serialized = JSON.stringify(blob)
    expect(serialized.includes(DUMMY_TOKEN)).toBe(false)
    // Also guard the individual base64 fields — a bug could stash it somewhere JSON.stringify order hid.
    for (const v of Object.values(blob)) {
      expect(String(v).includes(DUMMY_TOKEN)).toBe(false)
    }
  })

  it('uses a fresh salt + iv every call, so identical tokens never yield identical ciphertext', () => {
    const a = encryptProxyKey(DUMMY_TOKEN)
    const b = encryptProxyKey(DUMMY_TOKEN)
    expect(a.iv).not.toBe(b.iv)
    expect(a.salt).not.toBe(b.salt)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    // ...yet both still decrypt to the same token.
    expect(decryptEmbeddedBlob(a)).toBe(DUMMY_TOKEN)
    expect(decryptEmbeddedBlob(b)).toBe(DUMMY_TOKEN)
  })

  describe('GCM tamper-detection — a flipped byte must fail, never silently return a wrong key', () => {
    function flipFirstByteOfBase64(b64: string): string {
      const buf = Buffer.from(b64, 'base64')
      buf[0] ^= 0x01
      return buf.toString('base64')
    }

    it('rejects a flipped ciphertext byte (runtime returns null, build-time throws)', () => {
      const blob = encryptProxyKey(DUMMY_TOKEN)
      const tampered = { ...blob, ciphertext: flipFirstByteOfBase64(blob.ciphertext) }
      expect(decryptEmbeddedBlob(tampered)).toBeNull()
      expect(() => decryptProxyKey(tampered)).toThrow()
    })

    it('rejects a flipped auth tag', () => {
      const blob = encryptProxyKey(DUMMY_TOKEN)
      const tampered = { ...blob, tag: flipFirstByteOfBase64(blob.tag) }
      expect(decryptEmbeddedBlob(tampered)).toBeNull()
      expect(() => decryptProxyKey(tampered)).toThrow()
    })

    it('rejects a flipped iv', () => {
      const blob = encryptProxyKey(DUMMY_TOKEN)
      const tampered = { ...blob, iv: flipFirstByteOfBase64(blob.iv) }
      expect(decryptEmbeddedBlob(tampered)).toBeNull()
    })

    it('rejects a swapped salt (re-derives a different key, so GCM auth fails)', () => {
      const blob = encryptProxyKey(DUMMY_TOKEN)
      const tampered = { ...blob, salt: flipFirstByteOfBase64(blob.salt) }
      expect(decryptEmbeddedBlob(tampered)).toBeNull()
    })
  })

  it('fails closed on a blob encrypted under different material (wrong obfuscation secret)', () => {
    const material = loadMaterial()
    const wrong = { ...material, obfuscationSecret: `${material.obfuscationSecret}-WRONG` }
    const foreignBlob = encryptProxyKey(DUMMY_TOKEN, wrong)
    // The shipped decryptor uses the real material — it must NOT decrypt a blob sealed with another secret.
    expect(decryptEmbeddedBlob(foreignBlob)).toBeNull()
  })

  it('returns null on structurally invalid input instead of throwing', () => {
    expect(decryptEmbeddedBlob(null)).toBeNull()
    expect(decryptEmbeddedBlob(undefined)).toBeNull()
    expect(decryptEmbeddedBlob({})).toBeNull()
    expect(decryptEmbeddedBlob({ ciphertext: 'x' })).toBeNull()
  })

  it('isEncryptedBlob rejects the legacy plaintext {proxyKey} shape', () => {
    expect(isEncryptedBlob({ proxyKey: 'something-that-looks-like-a-key-123456' })).toBe(false)
  })
})
