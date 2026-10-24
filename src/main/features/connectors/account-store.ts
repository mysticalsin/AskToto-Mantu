import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { CONNECTOR_KINDS, type ConnectorKind } from '@shared/connector-catalog'

export interface ConnectorAccountStore {
  load(kind: ConnectorKind, scopeKey: string): Promise<unknown | null>
  save(kind: ConnectorKind, scopeKey: string, state: unknown): Promise<void>
}

const SCOPE_KEY = /^[a-f0-9]{64}$/

function assertStoreKey(kind: ConnectorKind, scopeKey: string): void {
  if (!(CONNECTOR_KINDS as readonly string[]).includes(kind) || !SCOPE_KEY.test(scopeKey)) {
    throw new Error('Unsafe connector account scope key.')
  }
}

export function within(base: string, target: string): boolean {
  const path = relative(base, target)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Atomic 0600 JSON write (temp file + rename) into a 0700 directory. */
export async function writeJsonAtomic(path: string, state: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export function createFileConnectorAccountStore(userDataPath: () => string): ConnectorAccountStore {
  const pathFor = (kind: ConnectorKind, scopeKey: string): string => {
    assertStoreKey(kind, scopeKey)
    const base = resolve(userDataPath(), 'connector-accounts')
    const directory = resolve(base, kind)
    const path = resolve(directory, `${scopeKey}.json`)
    if (!within(base, directory) || !within(directory, path)) throw new Error('Unsafe connector account storage path.')
    return path
  }

  return {
    async load(kind, scopeKey) {
      const path = pathFor(kind, scopeKey)
      try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw error
      }
    },

    async save(kind, scopeKey, state) {
      await writeJsonAtomic(pathFor(kind, scopeKey), state)
    }
  }
}

export function createMemoryConnectorAccountStore(): ConnectorAccountStore {
  const records = new Map<string, unknown>()
  const key = (kind: ConnectorKind, scopeKey: string): string => `${kind}:${scopeKey}`
  return {
    async load(kind, scopeKey) {
      assertStoreKey(kind, scopeKey)
      const value = records.get(key(kind, scopeKey))
      return value === undefined ? null : structuredClone(value)
    },
    async save(kind, scopeKey, state) {
      assertStoreKey(kind, scopeKey)
      records.set(key(kind, scopeKey), structuredClone(state))
    }
  }
}
