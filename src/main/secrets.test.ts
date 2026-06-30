import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { encryptSecret, decryptSecret } from './secrets'

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
})
