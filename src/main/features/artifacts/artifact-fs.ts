import { createReadStream } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export interface ArtifactFileStat {
  isFile(): boolean
  isSymbolicLink(): boolean
  size: number
  mtimeMs: number
  ino: number
}

/** The file operations the artifact feature needs, behind one seam so tests can pin edge cases. */
export interface ArtifactFs {
  lstat(path: string): Promise<ArtifactFileStat | null>
  sha256(path: string): Promise<string>
  /** The file's bytes, or null when it is larger than `maxBytes` (never reads past the cap). */
  readBytes(path: string, maxBytes: number): Promise<Buffer | null>
}

export const nodeArtifactFs: ArtifactFs = {
  async lstat(path) {
    try {
      return await lstat(path)
    } catch {
      return null
    }
  },
  sha256(path) {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  },
  async readBytes(path, maxBytes) {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0)
      return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }
}
