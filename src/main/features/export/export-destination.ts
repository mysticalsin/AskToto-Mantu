/**
 * export-destination.ts — where an export would land and whether it may.
 *
 * Plans a user-chosen destination (resolved real directory, name checks, case- and Unicode-normalisation-aware
 * conflict detection) and re-checks it synchronously at write time. The pure name rules take the platform as a
 * parameter so they are testable with Windows semantics on any host.
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

export type ConflictPolicy = 'none' | 'keep-both' | 'replace'

export class ExportRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportRefusal'
  }
}

export interface ExistingTarget {
  /** The name as it exists on disk (may differ in case or normalisation from the requested one). */
  name: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
}

export interface DestinationPlan {
  /** Real (symlink-resolved) absolute directory the export lands in. */
  directory: string
  /** The name the user chose. */
  name: string
  /** Absolute path of the chosen name inside the real directory. */
  destination: string
  existing: ExistingTarget | null
  isDirectory: boolean
}

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Null when the name is acceptable, otherwise a short reason. */
export function validateExportName(name: string, platform: NodeJS.Platform): string | null {
  if (!name || name === '.' || name === '..') return 'The file name is empty.'
  if (/[\\/]/.test(name)) return 'The file name contains a path separator.'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return 'The file name contains a control character.'
  if (platform === 'win32') {
    if (/[<>:"|?*]/.test(name)) return 'The file name contains a character Windows does not allow.'
    if (/[. ]$/.test(name)) return 'The file name ends with a dot or a space.'
    if (RESERVED_WINDOWS.test(name.split('.')[0] ?? '')) return 'The file name is a reserved Windows device name.'
  }
  return null
}

/** Equivalence key: macOS and Windows treat case variants and NFC/NFD forms as the same file. */
export function nameKey(name: string, platform: NodeJS.Platform): string {
  return platform === 'darwin' || platform === 'win32' ? name.normalize('NFC').toLowerCase() : name
}

/** "name (2).ext", skipping every taken name. Directories keep their whole name as the stem. */
export function keepBothName(
  name: string,
  taken: readonly string[],
  platform: NodeJS.Platform,
  isDirectory: boolean
): string {
  const dot = isDirectory ? -1 : name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const used = new Set(taken.map((t) => nameKey(t, platform)))
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!used.has(nameKey(candidate, platform))) return candidate
  }
  throw new ExportRefusal('Could not find a free name for the second copy.')
}

export interface PlanOptions {
  platform?: NodeJS.Platform
  isDirectory?: boolean
}

/** Resolves a chosen path into a plan, or a refusal reason. Never writes. */
export async function planDestination(
  chosenPath: string,
  options: PlanOptions = {}
): Promise<DestinationPlan | { refused: string }> {
  const platform = options.platform ?? process.platform
  const isDirectory = options.isDirectory === true
  if (typeof chosenPath !== 'string' || !isAbsolute(chosenPath))
    return { refused: 'The destination is not an absolute path.' }
  const name = basename(chosenPath)
  const invalid = validateExportName(name, platform)
  if (invalid) return { refused: invalid }
  let directory: string
  try {
    directory = await realpath(dirname(chosenPath))
  } catch {
    return { refused: 'The destination folder does not exist.' }
  }
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return { refused: 'The destination folder could not be read.' }
  }
  const key = nameKey(name, platform)
  const match = entries.find((e) => e === name) ?? entries.find((e) => nameKey(e, platform) === key)
  let existing: ExistingTarget | null = null
  if (match !== undefined) {
    const info = await lstat(join(directory, match)).catch(() => null)
    if (!info) return { refused: 'The existing file could not be inspected.' }
    if (info.isSymbolicLink()) return { refused: 'The destination is a symbolic link.' }
    if (isDirectory !== info.isDirectory())
      return { refused: 'The destination exists and is not the same kind of item.' }
    existing = { name: match, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }
  }
  return { directory, name, destination: join(directory, name), existing, isDirectory }
}

/**
 * Synchronous last check, run immediately before the write is committed. Throws ExportRefusal when the folder
 * or the target no longer matches what the user was shown.
 */
export function writeTimeCheck(
  plan: DestinationPlan,
  finalName: string,
  policy: ConflictPolicy,
  platform: NodeJS.Platform
): void {
  let real: string
  let entries: string[]
  try {
    real = realpathSync(plan.directory)
    entries = readdirSync(plan.directory)
  } catch {
    throw new ExportRefusal('The destination folder is no longer available.')
  }
  if (real !== plan.directory) throw new ExportRefusal('The destination folder changed since the preview.')
  const invalid = validateExportName(finalName, platform)
  if (invalid) throw new ExportRefusal(invalid)
  const key = nameKey(finalName, platform)
  const matches = entries.filter((e) => nameKey(e, platform) === key)
  if (policy === 'replace') {
    const prior = plan.existing
    const current = matches[0]
    if (!prior || matches.length !== 1 || current !== prior.name) {
      throw new ExportRefusal('The file to replace changed since the preview.')
    }
    const info = lstatSync(join(plan.directory, current))
    if (
      info.isSymbolicLink() ||
      info.dev !== prior.dev ||
      info.ino !== prior.ino ||
      info.size !== prior.size ||
      info.mtimeMs !== prior.mtimeMs
    ) {
      throw new ExportRefusal('The file to replace changed since the preview.')
    }
    return
  }
  if (matches.length > 0) {
    throw new ExportRefusal('A file with that name appeared since the preview, so nothing was overwritten.')
  }
}
