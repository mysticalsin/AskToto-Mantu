import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/**
 * Realpath-resolve the asr-model:// resource root ONCE, at protocol-registration time.
 *
 * The request target is always realpath-resolved before the traversal check (symlink-escape guard), so
 * the base it is compared against must be realpath-resolved too or the two sides describe the same
 * directory in different words. On Windows an install reached through a junction (redirected Program
 * Files, roaming/redirected user folders, portable installs on a mapped junction) makes
 * `process.resourcesPath` the junction path while the resolved target comes back as the junction's
 * TARGET — `relative()` then yields `..\..\real\...`, the guard 403s EVERY model asset, and ASR dies
 * silently. The same mismatch exists on macOS wherever a path crosses /var → /private/var.
 *
 * Falls back to the raw path when the base cannot be resolved (missing dir, permission denied) so an
 * unresolvable resources root degrades to today's behaviour instead of throwing at startup.
 */
export function realResourceBase(base: string): string {
  try {
    return realpathSync(base)
  } catch {
    return base
  }
}

/**
 * Path-traversal guard: true only when `real` stays inside `baseReal`. BOTH arguments must already be
 * realpath-resolved (see `realResourceBase`). Separator-safe on Windows — `relative()` does the
 * platform-correct comparison, including NTFS's case-insensitivity, so no manual case folding is needed.
 */
export function isInsideResourceBase(baseReal: string, real: string): boolean {
  const rel = relative(baseReal, real)
  return !rel.startsWith('..') && !isAbsolute(rel)
}
