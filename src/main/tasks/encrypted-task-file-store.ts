import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TaskStateReadResult } from './task-persistence'

/** Marks a file as an encrypted task archive. The payload is whatever `encrypt` returns for the archive string. */
const FILE_MARKER = Buffer.from('ATKTSK1\n')

/** The ciphertext could not be opened with this profile's key. The file is preserved aside, never overwritten. */
export const TASK_STORE_DECRYPT_FAILED = 'decrypt-failed'

/** Byte-level storage for the task archive: encryption and atomic replacement are injected by the composition root. */
export interface TaskStateStore {
  read(): Promise<TaskStateReadResult>
  write(serialized: string): Promise<void>
  /** Move an unreadable archive out of the way without deleting it, so a fresh archive can be started. */
  quarantine(): Promise<void>
}

export interface EncryptedTaskFileStoreDeps {
  file: () => string
  encrypt: (data: string) => Buffer
  decrypt: (data: Buffer) => string
  atomicWrite: (file: string, data: Buffer) => Promise<void>
  now?: () => number
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

export function createEncryptedTaskFileStore(deps: EncryptedTaskFileStoreDeps): TaskStateStore {
  const now = deps.now ?? Date.now
  return {
    async read() {
      const file = deps.file()
      let bytes: Buffer
      try {
        bytes = await readFile(file)
      } catch (error) {
        return errorCode(error) === 'ENOENT'
          ? { kind: 'not-found' }
          : { kind: 'unavailable', reason: `read-failed:${errorCode(error)}` }
      }
      // A file without the marker is not ours; hand the codec an empty document so it reports it as corrupt.
      if (bytes.length < FILE_MARKER.length || !bytes.subarray(0, FILE_MARKER.length).equals(FILE_MARKER)) {
        return { kind: 'found', serialized: '' }
      }
      try {
        return { kind: 'found', serialized: deps.decrypt(bytes.subarray(FILE_MARKER.length)) }
      } catch {
        return { kind: 'unavailable', reason: TASK_STORE_DECRYPT_FAILED }
      }
    },
    async write(serialized) {
      const file = deps.file()
      await mkdir(dirname(file), { recursive: true })
      await deps.atomicWrite(file, Buffer.concat([FILE_MARKER, deps.encrypt(serialized)]))
    },
    async quarantine() {
      const file = deps.file()
      try {
        await rename(file, `${file}.corrupt-${now()}`)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
  }
}
