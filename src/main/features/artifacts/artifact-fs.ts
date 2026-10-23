import { createReadStream, lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
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
  lstatSync(path: string): ArtifactFileStat | null
  sha256(path: string): Promise<string>
}

export const nodeArtifactFs: ArtifactFs = {
  async lstat(path) {
    try {
      return await lstat(path)
    } catch {
      return null
    }
  },
  lstatSync(path) {
    try {
      return lstatSync(path)
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
  }
}
