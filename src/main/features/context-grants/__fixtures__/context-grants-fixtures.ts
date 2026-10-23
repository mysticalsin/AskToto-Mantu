import type { SnapshotIo } from '../snapshot-store'

/** A sealed-bytes stand-in for tests: a reversible, obviously-not-plaintext transform. */
export const testSeal = (text: string): Buffer => Buffer.from(`sealed:${Buffer.from(text, 'utf8').toString('base64')}`)
export const testOpen = (data: Buffer): string => {
  const raw = data.toString('utf8')
  if (!raw.startsWith('sealed:')) throw new Error('not sealed')
  return Buffer.from(raw.slice(7), 'base64').toString('utf8')
}

export function memoryIo(): SnapshotIo & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  return {
    files,
    write: async (id, data) => void files.set(id, data),
    read: async (id) => files.get(id) ?? null,
    remove: async (id) => void files.delete(id),
    purge: async () => files.clear()
  }
}

export interface Env {
  owner: string | null
  generation: number
  session: string
  now: number
}
