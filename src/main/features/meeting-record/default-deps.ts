import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { decodeSavedResult, writeSaved } from '../../transcripts'
import type { RecordEditsDeps } from './record-edits-store'

/** Real sidecar I/O: the same at-rest encryption and atomic write as every saved transcript. */
export const defaultRecordEditsDeps: RecordEditsDeps = {
  async read(path) {
    try {
      return await readFile(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  decode(bytes) {
    const decoded = decodeSavedResult(bytes)
    return decoded.ok ? decoded.text : null
  },
  async write(path, content, encrypt) {
    await mkdir(dirname(path), { recursive: true })
    await writeSaved(path, content, encrypt)
  },
  async remove(path) {
    await rm(path, { force: true })
  }
}
