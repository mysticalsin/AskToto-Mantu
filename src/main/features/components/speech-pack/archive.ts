/**
 * archive.ts — guards around unpacking an upstream archive (M2-0475).
 *
 * The archive itself is pinned by length and sha256 before it is opened. Unpacking is still treated as
 * hostile: entry names cannot leave the extraction directory, only regular files are admitted, the total
 * size is capped, and every file that is kept is checked against its own per-file pin.
 */
import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { SpeechPackError } from './errors'
import { sha256File } from './download'
import type { SpeechPackFile } from './manifest'

/** Unpacks `archivePath` into `destDir`. Extractors must reject names for which `isSafeEntryName` is false. */
export type ExtractArchive = (archivePath: string, destDir: string) => Promise<void>

/** True when an archive entry name stays inside the extraction directory on both macOS and Windows. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return false
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  return !name.split('/').some((part) => part === '..')
}

/** Every regular file under `root` (relative, forward slashes) and their total size. Anything else is 'tamper'. */
export function listExtracted(root: string, capBytes: number): Map<string, number> {
  const found = new Map<string, number>()
  let total = 0
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = lstatSync(abs)
      if (st.isDirectory()) walk(abs, relPath)
      else if (st.isFile() && st.nlink === 1) {
        total += st.size
        if (total > capBytes) throw new SpeechPackError('tamper', 'archive expands beyond its size cap')
        found.set(relPath, st.size)
      } else throw new SpeechPackError('tamper', 'archive holds a link or special file')
    }
  }
  walk(root, '')
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
  const found = listExtracted(extractRoot, capBytes)
  for (const file of files) {
    const rel = `${entryPrefix}/${file.path}`
    if (found.get(rel) !== file.bytes) throw new SpeechPackError('tamper', 'extracted file has the wrong length')
    const abs = join(extractRoot, ...rel.split('/'))
    if (!abs.startsWith(extractRoot + sep)) throw new SpeechPackError('tamper', 'extracted path escapes its directory')
    if ((await sha256File(abs)) !== file.sha256) throw new SpeechPackError('tamper', 'extracted file does not match its pin')
    const dest = join(destDir, ...file.path.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(abs, dest)
  }
}
