import { fileURLToPath } from 'node:url'

/** Pure: the file paths a clipboard's native file formats name. macOS and Linux hold file URLs, Windows a wide-char list. */
export function pathsFromClipboardFormats(platform: NodeJS.Platform, read: (format: string) => Buffer): string[] {
  try {
    if (platform === 'win32') {
      const wide = read('FileNameW').toString('utf16le').split('\u0000').filter(Boolean)
      return wide
    }
    const format = platform === 'darwin' ? 'public.file-url' : 'text/uri-list'
    return (
      read(format)
        .toString('utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/\u0000/g, '').trim())
        .filter((line) => line.startsWith('file://'))
        // POSIX formats are decoded as POSIX paths whatever the host OS (tests run these on Windows too).
        .map((line) => fileURLToPath(line, { windows: false }))
    )
  } catch {
    return []
  }
}
