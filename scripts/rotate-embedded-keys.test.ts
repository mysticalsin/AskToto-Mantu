import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateEmbeddedProxyKey, writeEmbeddedProxyKey } from './rotate-embedded-keys.mjs'
import { decryptProxyKey, isEncryptedBlob } from './lib/embedded-cloudflare-crypto.mjs'

describe('rotate-embedded-keys', () => {
  it('generates a key that matches the embed bundle pattern and is not an account-token shape', () => {
    const key = generateEmbeddedProxyKey()
    expect(key).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/)
    expect(key).not.toMatch(/^sk-/)
    expect(key).not.toMatch(/^ATK-/)
  })

  it('writes the encrypted blob the packaging gate accepts, never a plaintext proxyKey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embed-rotate-'))
    const dest = join(dir, 'key.json')
    try {
      const { key } = writeEmbeddedProxyKey(dest)
      const raw = await readFile(dest, 'utf8')
      expect(raw).not.toContain(key)
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect('proxyKey' in parsed).toBe(false)
      expect(isEncryptedBlob(parsed)).toBe(true)
      expect(decryptProxyKey(parsed)).toBe(key)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
