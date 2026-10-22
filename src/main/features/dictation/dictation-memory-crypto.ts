/**
 * Encryption at rest for the dictation memory (G26): one 32-byte content key per profile, wrapped by the OS keychain
 * or the AES-GCM file backend (the same custody the live meeting journal and the transcript envelope use) and kept in
 * `key.v1` OUTSIDE the sealed files, never in the clear.
 *
 * Envelope: `DM1\n` + 12 byte iv + 16 byte tag + ciphertext. AES-256-GCM with a fresh iv per seal. The caller supplies
 * an `aad` that binds the bytes to what they are (an entry id, a partition): a sealed file copied to another name, or
 * another user's dictionary, fails authentication instead of being read.
 *
 * Nothing here throws: a seal or open that cannot proceed returns null. `open` never creates a key (a new key could not
 * decrypt anything that exists); `seal` creates one only when the key file is genuinely missing and never replaces a
 * corrupt one. Key material is never logged and never placed in an error.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type {
  ContentKeyUnwrapResult,
  ContentKeyWrapResult,
  WrappedKeyFileReadResult,
  WrappedKeyFileWriteResult
} from '../../infra/security/content-key-wrap'

export interface DictationKeyCustody {
  generate(): Buffer
  wrap(key: Buffer): ContentKeyWrapResult
  unwrap(wrapped: string): ContentKeyUnwrapResult
  writeFile(path: string, wrapped: string): Promise<WrappedKeyFileWriteResult>
  readFile(path: string): Promise<WrappedKeyFileReadResult>
}

export interface MemoryKeyring {
  seal(plain: Buffer, aad: string): Promise<Buffer | null>
  open(sealed: Buffer, aad: string): Promise<Buffer | null>
  /** Zeroes the key. Later calls return null. */
  dispose(): void
}

const MAGIC = Buffer.from('DM1\n', 'utf8')
const IV_LEN = 12
const TAG_LEN = 16
const KEY_BYTES = 32

export function createMemoryKeyring(options: { keyPath: string; keys: DictationKeyCustody }): MemoryKeyring {
  const { keyPath, keys } = options
  let key: Buffer | null = null
  let disposed = false

  async function load(create: boolean): Promise<Buffer | null> {
    try {
      const read = await keys.readFile(keyPath)
      if (read.ok) {
        const unwrapped = keys.unwrap(read.wrapped)
        if (!unwrapped.ok || unwrapped.key.length !== KEY_BYTES) {
          if (unwrapped.ok) unwrapped.key.fill(0)
          return null
        }
        return unwrapped.key
      }
      if (read.reason !== 'missing' || !create) return null
      const fresh = keys.generate()
      if (fresh.length !== KEY_BYTES) {
        fresh.fill(0)
        return null
      }
      const wrapped = keys.wrap(fresh)
      if (!wrapped.ok) {
        fresh.fill(0)
        return null
      }
      const written = await keys.writeFile(keyPath, wrapped.wrapped)
      if (!written.ok) {
        fresh.fill(0)
        return null
      }
      return fresh
    } catch {
      return null
    }
  }

  // Loads are chained, so two first uses share one key creation and an `open` that found no key never blocks the
  // `seal` that creates it.
  let chain: Promise<unknown> = Promise.resolve()
  function ensure(create: boolean): Promise<Buffer | null> {
    const next = chain.then(async () => {
      if (disposed) return null
      if (key) return key
      const loaded = await load(create)
      if (disposed) {
        loaded?.fill(0)
        return null
      }
      if (loaded) key = loaded
      return key
    })
    chain = next.catch(() => null)
    return next
  }

  return {
    async seal(plain, aad) {
      try {
        const content = await ensure(true)
        if (!content) return null
        const iv = randomBytes(IV_LEN)
        const cipher = createCipheriv('aes-256-gcm', content, iv)
        cipher.setAAD(Buffer.from(aad, 'utf8'))
        const body = Buffer.concat([cipher.update(plain), cipher.final()])
        return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
      } catch {
        return null
      }
    },
    async open(sealed, aad) {
      try {
        if (sealed.length < MAGIC.length + IV_LEN + TAG_LEN || !sealed.subarray(0, MAGIC.length).equals(MAGIC))
          return null
        const content = await ensure(false)
        if (!content) return null
        const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_LEN)
        const tag = sealed.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN)
        const decipher = createDecipheriv('aes-256-gcm', content, iv)
        decipher.setAAD(Buffer.from(aad, 'utf8'))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV_LEN + TAG_LEN)), decipher.final()])
      } catch {
        return null
      }
    },
    dispose() {
      disposed = true
      key?.fill(0)
      key = null
    }
  }
}
