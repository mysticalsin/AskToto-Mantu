import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createMemoryKeyring, type DictationKeyCustody } from '../../dictation'
import { createUserMemoryStore, type UserMemoryStore } from '../user-memory-store'

/** Synthetic fixtures for the user memory tests: a real random content key, a reversible stand-in for the OS wrap. */
export const PARTITION_A = 'a'.repeat(32)
export const PARTITION_B = 'b'.repeat(32)
export const DAY = 86_400_000

export function syntheticKeys(): DictationKeyCustody {
  return {
    generate: () => randomBytes(32),
    wrap: (key) => ({ ok: true as const, wrapped: `F:${key.toString('base64')}` }),
    unwrap: (wrapped) =>
      wrapped.startsWith('F:')
        ? { ok: true as const, key: Buffer.from(wrapped.slice(2), 'base64'), keychainRecovery: false }
        : { ok: false as const, reason: 'unavailable' as const, error: new Error('x') },
    async writeFile(path, wrapped) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({ v: 1, kLocal: wrapped }))
      return { ok: true as const }
    },
    async readFile(path) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as { kLocal: string }
        return { ok: true as const, wrapped: parsed.kLocal }
      } catch {
        return { ok: false as const, reason: 'missing' as const }
      }
    }
  } as DictationKeyCustody
}

export interface Env {
  root: string
  partition: string | null
  now: number
  store: UserMemoryStore
  remove(): void
}

export function makeEnv(): Env {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-user-memory-')))
  mkdirSync(root, { recursive: true })
  const env = {
    root,
    partition: PARTITION_A as string | null,
    now: 1_800_000_000_000,
    remove: () => rmSync(root, { recursive: true, force: true })
  } as Env
  env.store = createUserMemoryStore({
    rootDir: () => join(root, 'user-memory'),
    keyring: createMemoryKeyring({ keyPath: join(root, 'user-memory', 'key.v1'), keys: syntheticKeys() }),
    partition: () => env.partition,
    now: () => env.now
  })
  return env
}
