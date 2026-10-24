import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import {
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_TEXT_EXTENSIONS,
  type AttachmentKind,
  type AttachmentRefusal
} from '@shared/attachments'

export interface InspectedFile {
  name: string
  kind: AttachmentKind
  bytes: number
  data: Buffer
  /** Set for images: the media type their magic bytes proved. */
  mime?: string
}

export type InspectResult = ({ ok: true } & InspectedFile) | { ok: false; reason: AttachmentRefusal; name: string }

/** Program and script types. Named so the copy can say "program" rather than "unsupported". */
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'dll',
  'bat',
  'cmd',
  'com',
  'msi',
  'scr',
  'ps1',
  'vbs',
  'sh',
  'bash',
  'zsh',
  'command',
  'app',
  'pkg',
  'dmg',
  'jar',
  'bin',
  'so',
  'dylib',
  'apk',
  'js',
  'mjs',
  'py',
  'rb',
  'pl',
  'lnk',
  'url',
  'desktop'
])
const TEXT: ReadonlySet<string> = new Set(ATTACHMENT_TEXT_EXTENSIONS)
const IMAGE: ReadonlySet<string> = new Set(ATTACHMENT_IMAGE_EXTENSIONS)

/** Path segments main never reads on a drop, whatever the file is called: keys, cloud credentials, keychains. */
const PROTECTED_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.docker',
  '.gcloud',
  'keychains'
])

export function isProtectedByName(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()))
}

function looksExecutable(head: Buffer): boolean {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true // MZ (Windows PE)
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true // ELF
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return true // #! script
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0)
    // Mach-O 32/64 in either byte order, and fat binaries (also the Java class magic, never a text or image file).
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return true
  }
  return false
}

function imageMime(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}

/** Classifies bytes the clipboard handed over in memory (no file behind them). */
export function inspectBytes(name: string, data: Buffer): InspectResult {
  const mime = imageMime(data)
  if (looksExecutable(data)) return { ok: false, reason: 'executable', name }
  if (data.length === 0) return { ok: false, reason: 'empty', name }
  if (data.length > ATTACHMENT_MAX_FILE_BYTES) return { ok: false, reason: 'too-large', name }
  if (!mime) return { ok: false, reason: 'not-an-image', name }
  return { ok: true, name, kind: 'image', bytes: data.length, data, mime }
}

/**
 * Reads one dropped, picked or pasted file in main. The renderer's path is only a claim, so this refuses anything that is
 * not a plain, readable, allow-listed regular file: no folders, no symlinks (also through the file's own final
 * component), no programs, nothing in a protected location. The read goes through a descriptor that refuses to follow
 * a link and is re-checked with fstat, so a swap between the check and the read cannot widen what is read.
 */
export async function inspectFile(
  path: string,
  isProtectedPath: (path: string) => boolean = () => false
): Promise<InspectResult> {
  const name = basename(path).slice(0, 255)
  if (!isAbsolute(path) || path.includes('\u0000')) return { ok: false, reason: 'invalid', name }
  if (isProtectedByName(path) || isProtectedPath(path)) return { ok: false, reason: 'protected-location', name }
  const ext = extname(name).slice(1).toLowerCase()
  if (EXECUTABLE_EXTENSIONS.has(ext)) return { ok: false, reason: 'executable', name }
  if (!TEXT.has(ext) && !IMAGE.has(ext)) return { ok: false, reason: 'unsupported-type', name }
  try {
    const link = await lstat(path)
    if (link.isSymbolicLink()) return { ok: false, reason: 'symlink', name }
    if (!link.isFile()) return { ok: false, reason: 'not-a-file', name }
    // A symlinked parent folder is the owner's own layout (macOS /tmp); only the file itself must not be a link.
    if ((await realpath(path)) !== join(await realpath(dirname(path)), basename(path)))
      return { ok: false, reason: 'symlink', name }
    if (isProtectedPath(await realpath(path))) return { ok: false, reason: 'protected-location', name }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return { ok: false, reason: 'not-a-file', name }
      if (stat.size > ATTACHMENT_MAX_FILE_BYTES) return { ok: false, reason: 'too-large', name }
      const buffer = Buffer.alloc(Math.min(stat.size, ATTACHMENT_MAX_FILE_BYTES) + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > ATTACHMENT_MAX_FILE_BYTES) return { ok: false, reason: 'too-large', name }
      const data = buffer.subarray(0, bytesRead)
      if (data.length === 0) return { ok: false, reason: 'empty', name }
      if (looksExecutable(data)) return { ok: false, reason: 'executable', name }
      if (IMAGE.has(ext)) {
        const mime = imageMime(data)
        return mime
          ? { ok: true, name, kind: 'image', bytes: data.length, data: Buffer.from(data), mime }
          : { ok: false, reason: 'not-an-image', name }
      }
      // Text: no NUL bytes in the head and valid UTF-8, or it is a binary file wearing a text name.
      if (data.subarray(0, 8192).includes(0)) return { ok: false, reason: 'unreadable', name }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data)
      } catch {
        return { ok: false, reason: 'unreadable', name }
      }
      return { ok: true, name, kind: 'text', bytes: data.length, data: Buffer.from(data) }
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, reason: 'unreadable', name }
  }
}
