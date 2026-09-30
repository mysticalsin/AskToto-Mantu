/**
 * archive.ts — guards around unpacking an upstream archive (M2-0475).
 *
 * The archive itself is pinned by length and sha256 before it is opened. Unpacking is still treated as
 * hostile: an extractor can only write through an `ArchiveSink`, which refuses an unsafe entry name BEFORE
 * anything is written and aborts as soon as the running total passes the size cap. After extraction only
 * regular files are admitted, and every file that is kept is checked against its own per-file pin.
 */
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { SpeechPackError } from './errors'
import { sha256File } from './download'
import type { SpeechPackFile } from './manifest'

/** The only way an extractor puts bytes on disk. Every regular-file entry of the archive goes through `addFile`. */
export interface ArchiveSink {
  /** Refuses an unsafe name before writing and throws 'tamper' the moment the running total exceeds the cap. */
  addFile(name: string, data: AsyncIterable<Uint8Array>): Promise<void>
}

/** Streams the entries of `archivePath` into `sink`; a link or special entry must be reported as an error. */
export type ExtractArchive = (archivePath: string, sink: ArchiveSink, signal: AbortSignal) => Promise<void>

/** True when an archive entry name stays inside the extraction directory on both macOS and Windows. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return false
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  return !name.split('/').some((part) => part === '..')
}

/** A sink that writes under `destDir`, holding all entries together to `capBytes`. */
export function createArchiveSink(destDir: string, capBytes: number): ArchiveSink {
  const root = resolve(destDir)
  let total = 0
  return {
    async addFile(name, data) {
      if (!isSafeEntryName(name)) throw new SpeechPackError('tamper', 'archive entry name is not allowed')
      const abs = resolve(root, ...name.split('/'))
      if (!abs.startsWith(root + sep)) throw new SpeechPackError('tamper', 'archive entry escapes its directory')
      await mkdir(dirname(abs), { recursive: true })
      // 'wx' refuses an existing path, so a duplicate entry or a planted link is never written through.
      const handle = await open(abs, 'wx')
      try {
        for await (const chunk of data) {
          total += chunk.byteLength
          if (total > capBytes) throw new SpeechPackError('tamper', 'archive expands beyond its size cap')
          await handle.write(chunk)
        }
      } finally {
        await handle.close()
      }
    }
  }
}

/** Every regular file under `root` (relative, forward slashes) and their total size. Anything else is 'tamper'. */
export async function listExtracted(root: string, capBytes: number): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  let total = 0
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const abs = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = await lstat(abs)
      if (st.isDirectory()) await walk(abs, relPath)
      else if (st.isFile() && st.nlink === 1) {
        total += st.size
        if (total > capBytes) throw new SpeechPackError('tamper', 'archive expands beyond its size cap')
        found.set(relPath, st.size)
      } else throw new SpeechPackError('tamper', 'archive holds a link or special file')
    }
  }
  await walk(root, '')
  return found
}

/**
 * Move the pinned files from `<extractRoot>/<entryPrefix>/` into `destDir`, each only after its length and
 * sha256 match its own pin. Files not in the pin list are ignored and never moved.
 */
export async function adoptExtracted(
  extractRoot: string,
  entryPrefix: string,
  files: readonly SpeechPackFile[],
  destDir: string,
  capBytes: number
): Promise<void> {
  const found = await listExtracted(extractRoot, capBytes)
  for (const file of files) {
    const rel = `${entryPrefix}/${file.path}`
    if (found.get(rel) !== file.bytes) throw new SpeechPackError('tamper', 'extracted file has the wrong length')
    const abs = join(extractRoot, ...rel.split('/'))
    if (!abs.startsWith(extractRoot + sep)) throw new SpeechPackError('tamper', 'extracted path escapes its directory')
    if ((await sha256File(abs)) !== file.sha256) throw new SpeechPackError('tamper', 'extracted file does not match its pin')
    const dest = join(destDir, ...file.path.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await rename(abs, dest)
  }
}
