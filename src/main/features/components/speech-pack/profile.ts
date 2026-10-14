import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type SpeechPackBuildProfile = 'full' | 'lean' | 'development'
export type SpeechPackProfileRead = { profile: SpeechPackBuildProfile } | { profile: null; error: 'invalid-profile' }

const PROFILE_FILE = 'speech-pack-profile.json'
const MAX_PROFILE_BYTES = 128

/**
 * Read only the package-owned profile resource. A runtime setting never selects lean. In development,
 * the caller's explicit `app.isPackaged` fact selects the development path without reading a file.
 */
export function readSpeechPackProfile(resourcesRoot: string, isPackaged: boolean): SpeechPackProfileRead {
  if (!isPackaged) return { profile: 'development' }
  const path = resolve(resourcesRoot, PROFILE_FILE)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: 'full' }
    return { profile: null, error: 'invalid-profile' }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_PROFILE_BYTES) {
    return { profile: null, error: 'invalid-profile' }
  }
  let fd = -1
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > MAX_PROFILE_BYTES ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    ) {
      return { profile: null, error: 'invalid-profile' }
    }
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { profile: null, error: 'invalid-profile' }
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'profile,schema' || record.schema !== 1) {
      return { profile: null, error: 'invalid-profile' }
    }
    if (record.profile !== 'full' && record.profile !== 'lean') return { profile: null, error: 'invalid-profile' }
    return { profile: record.profile }
  } catch {
    return { profile: null, error: 'invalid-profile' }
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}
