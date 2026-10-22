import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTempRoot, syntheticKeys } from './__fixtures__/dictation-memory-fixtures'
import { createMemoryKeyring } from './dictation-memory-crypto'

const roots: Array<{ remove(): void }> = []
afterEach(() => {
  while (roots.length) roots.pop()?.remove()
})
function root() {
  const r = makeTempRoot()
  roots.push(r)
  return r
}

describe('memory keyring (G26)', () => {
  it('seals with AES-256-GCM, never leaves the plaintext in the bytes, and opens only with the same aad', async () => {
    const dir = root()
    const keyring = createMemoryKeyring({ keyPath: join(dir.path, 'key.v1'), keys: syntheticKeys() })
    const sealed = await keyring.seal(Buffer.from('synthetic secret sentence'), 'entry:1')
    expect(sealed).not.toBeNull()
    expect(sealed!.includes(Buffer.from('synthetic secret sentence'))).toBe(false)
    expect((await keyring.open(sealed!, 'entry:1'))?.toString('utf8')).toBe('synthetic secret sentence')
    expect(await keyring.open(sealed!, 'entry:2')).toBeNull()
    const flipped = Buffer.from(sealed!)
    flipped[flipped.length - 1] ^= 1
    expect(await keyring.open(flipped, 'entry:1')).toBeNull()
    expect(await keyring.open(Buffer.from('short'), 'entry:1')).toBeNull()
  })

  it('uses a fresh iv per seal', async () => {
    const dir = root()
    const keyring = createMemoryKeyring({ keyPath: join(dir.path, 'key.v1'), keys: syntheticKeys() })
    const a = await keyring.seal(Buffer.from('same'), 'x')
    const b = await keyring.seal(Buffer.from('same'), 'x')
    expect(a!.equals(b!)).toBe(false)
  })

  it('creates the wrapped key once, keeps it outside the sealed files and re-reads it after a relaunch', async () => {
    const dir = root()
    const keyPath = join(dir.path, 'key.v1')
    const first = syntheticKeys()
    const a = createMemoryKeyring({ keyPath, keys: first })
    const sealed = await a.seal(Buffer.from('kept'), 'aad')
    await a.seal(Buffer.from('again'), 'aad')
    expect(first.generated).toBe(1)
    expect(JSON.parse(await readFile(keyPath, 'utf8')).kLocal).toMatch(/^F:/)
    const second = syntheticKeys()
    const b = createMemoryKeyring({ keyPath, keys: second })
    expect((await b.open(sealed!, 'aad'))?.toString('utf8')).toBe('kept')
    expect(second.generated).toBe(0)
  })

  it('open never creates a key; a missing key is unavailable, not a new key that could not decrypt anything', async () => {
    const dir = root()
    const keys = syntheticKeys()
    const keyring = createMemoryKeyring({ keyPath: join(dir.path, 'key.v1'), keys })
    expect(await keyring.open(Buffer.alloc(64), 'aad')).toBeNull()
    expect(keys.generated).toBe(0)
  })

  it('refuses to seal when the wrapped key file is corrupt rather than replacing it', async () => {
    const dir = root()
    const keyPath = join(dir.path, 'key.v1')
    await writeFile(keyPath, 'not json')
    const keys = syntheticKeys()
    const keyring = createMemoryKeyring({ keyPath, keys })
    expect(await keyring.seal(Buffer.from('x'), 'aad')).toBeNull()
    expect(keys.generated).toBe(0)
    expect(await readFile(keyPath, 'utf8')).toBe('not json')
  })

  it('refuses to seal when the OS wrap is unavailable and never writes a clear key', async () => {
    const dir = root()
    const keys = {
      ...syntheticKeys(),
      wrap: () => ({ ok: false as const, reason: 'unavailable' as const, error: new Error('x') })
    }
    const keyring = createMemoryKeyring({ keyPath: join(dir.path, 'key.v1'), keys })
    expect(await keyring.seal(Buffer.from('x'), 'aad')).toBeNull()
  })

  it('zeroes its key on dispose and then refuses', async () => {
    const dir = root()
    const keyring = createMemoryKeyring({ keyPath: join(dir.path, 'key.v1'), keys: syntheticKeys() })
    const sealed = await keyring.seal(Buffer.from('x'), 'aad')
    keyring.dispose()
    expect(await keyring.seal(Buffer.from('y'), 'aad')).toBeNull()
    expect(await keyring.open(sealed!, 'aad')).toBeNull()
  })
})
