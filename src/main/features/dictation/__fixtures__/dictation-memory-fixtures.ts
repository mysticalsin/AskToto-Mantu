import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DictationKeyCustody } from '../dictation-memory-crypto'

/** Shared synthetic fixtures for the dictation memory tests. No real text, owner, key or path. */

export const PARTITION_A = 'a'.repeat(32)
export const PARTITION_B = 'b'.repeat(32)

export function makeTempRoot(prefix = 'synthetic-dictation-memory-'): { path: string; remove(): void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}

export function makeDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Key custody with a real random content key and a reversible stand-in for the OS wrap (the production wrap needs
 * Electron). The wrapped key file is a real file, so a "relaunch" can unwrap it with a second custody instance.
 */
export function syntheticKeys(): DictationKeyCustody & { generated: number } {
  const keys = {
    generated: 0,
    generate(): Buffer {
      keys.generated += 1
      return randomBytes(32)
    },
    wrap(key: Buffer) {
      return { ok: true as const, wrapped: `F:${key.toString('base64')}` }
    },
    unwrap(wrapped: string) {
      if (!wrapped.startsWith('F:'))
        return { ok: false as const, reason: 'unavailable' as const, error: new Error('x') }
      return { ok: true as const, key: Buffer.from(wrapped.slice(2), 'base64'), keychainRecovery: false }
    },
    async writeFile(path: string, wrapped: string) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({ v: 1, kLocal: wrapped }))
      return { ok: true as const }
    },
    async readFile(path: string) {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch {
        return { ok: false as const, reason: 'missing' as const }
      }
      try {
        const parsed = JSON.parse(text) as { v?: number; kLocal?: string }
        if (parsed.v !== 1 || typeof parsed.kLocal !== 'string')
          return { ok: false as const, reason: 'corrupt' as const }
        return { ok: true as const, wrapped: parsed.kLocal }
      } catch {
        return { ok: false as const, reason: 'corrupt' as const }
      }
    }
  }
  return keys
}
