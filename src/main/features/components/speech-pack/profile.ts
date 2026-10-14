import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { resolve } from 'node:path'

export type SpeechPackBuildProfile = 'full' | 'lean' | 'development'
export type SpeechPackProfileRead = { profile: SpeechPackBuildProfile } | { profile: null; error: 'invalid-profile' }

const PROFILE_FILE = 'speech-pack-profile.json'
const MAX_PROFILE_BYTES = 128

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Buffer | null> {
  const bytes = Buffer.alloc(maxBytes + 1)
  let offset = 0
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > maxBytes) return null
  return bytes.subarray(0, offset)
}

/**
 * Read only the package-owned profile resource. A runtime setting never selects lean. In development,
 * the caller's explicit `app.isPackaged` fact selects the development path without reading a file.
 */
export async function readSpeechPackProfile(
  resourcesRoot: string,
  isPackaged: boolean
): Promise<SpeechPackProfileRead> {
  if (!isPackaged) return { profile: 'development' }
  const path = resolve(resourcesRoot, PROFILE_FILE)
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: 'full' }
    return { profile: null, error: 'invalid-profile' }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_PROFILE_BYTES) {
    return { profile: null, error: 'invalid-profile' }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > MAX_PROFILE_BYTES ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    ) {
      return { profile: null, error: 'invalid-profile' }
    }
    const bytes = await readBounded(handle, MAX_PROFILE_BYTES)
    const afterRead = await handle.stat()
    const afterPath = await lstat(path)
    if (
      !bytes ||
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== opened.size
    ) {
      return { profile: null, error: 'invalid-profile' }
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown
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
    await handle?.close().catch(() => undefined)
  }
}
