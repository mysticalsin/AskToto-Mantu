import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

export async function stagedFileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? s.size : null
  } catch {
    return null
  }
}

/** Streamed (the installer is large); the feed's sha512 is base64. */
export function stagedFileSha512Base64(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('base64')))
  })
}
