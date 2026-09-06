import { basename } from 'node:path'

const BOOKKEEPING = new Set(['index.md', 'README.md'])

/**
 * Constrain a renderer-supplied meeting file name to a single .md basename inside the meetings folder.
 *
 * `basename()` is the traversal guard (POSIX and Windows separators). Bookkeeping files this folder
 * regenerates itself (`index.md`, `README.md`) are never a meeting. Empty / non-.md names are refused.
 */
export function safeMeetingBasename(file: unknown): string | null {
  // Node's basename() only splits on the host separator. A renderer can still send
  // `..\..\secret.md` with backslashes; normalize both so the allow-list is the same on Linux CI and Windows.
  const safeName = basename(String(file ?? '').replace(/\\/g, '/'))
  if (!safeName || safeName === '.' || safeName === '..') return null
  if (!safeName.endsWith('.md')) return null
  if (BOOKKEEPING.has(safeName)) return null
  if (safeName.includes('\0')) return null
  return safeName
}
