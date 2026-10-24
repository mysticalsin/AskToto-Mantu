/** File-backed nonce memory (G37): a small JSON map of nonce to expiry in userData. Nonces are random, not content. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { NonceStore } from './nonce-ledger'

export function createFileNonceStore(path: string): NonceStore {
  return {
    /** A missing file is an empty store. Unreadable or corrupt storage throws, so the ledger fails closed. */
    async load() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw error
      }
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('nonce_store_corrupt')
      return parsed as Record<string, number>
    },
    async save(entries) {
      const tmp = `${path}.tmp`
      await mkdir(dirname(path), { recursive: true })
      await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 })
      await rename(tmp, path)
    }
  }
}
