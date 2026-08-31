import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateEmbeddedProxyKey, writeEmbeddedProxyKey } from './rotate-embedded-keys.mjs'

describe('rotate-embedded-keys', () => {
  it('generates a key that matches the embed bundle pattern and is not an account-token shape', () => {
    const key = generateEmbeddedProxyKey()
    expect(key).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/)
    expect(key).not.toMatch(/^sk-/)
    expect(key).not.toMatch(/^ATK-/)
  })

  it('writes only { proxyKey } to the dest file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embed-rotate-'))
    const dest = join(dir, 'key.json')
    try {
      const { key } = writeEmbeddedProxyKey(dest)
      const parsed = JSON.parse(await readFile(dest, 'utf8')) as { proxyKey?: string }
      expect(parsed).toEqual({ proxyKey: key })
      expect(Object.keys(parsed)).toEqual(['proxyKey'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
