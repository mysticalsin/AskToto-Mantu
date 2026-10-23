/** File-backed nonce memory (G37): a small JSON map of nonce to expiry in userData. Nonces are random, not content. */
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { NonceStore } from './nonce-ledger'

export function createFileNonceStore(path: string): NonceStore {
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, number>)
          : {}
      } catch {
        return {}
      }
    },
    async save(entries) {
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 })
      await rename(tmp, path)
    }
  }
}
