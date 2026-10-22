/**
 * Safe targets for voice actions (V03), pure.
 *
 * Spoken text becomes data in exactly three places: a web search URL, a note's HTML body, and a Windows note
 * file name. Each is built here from validated text, and each has a check that refuses anything outside what it
 * was built to be. Nothing here runs a process or touches a file.
 */
import { win32 } from 'node:path'

const GOOGLE_HOST = 'www.google.com'
const X_HOST = 'x.com'

/** The one fixed X address. Navigation only: Métis never composes or posts. */
export const X_URL = 'https://x.com'

/** The Google search URL for a query, or null when the query cannot be encoded (a lone surrogate). */
export function googleSearchUrl(query: string): string | null {
  try {
    return `https://${GOOGLE_HOST}/search?q=${encodeURIComponent(query)}`
  } catch {
    return null
  }
}

/**
 * The browser allowlist, checked again at the adapter boundary: https only, exactly Google search with a single
 * `q` parameter or the fixed X address, no credentials, no port, no fragment. A `file:`, `javascript:`, custom
 * scheme or another host is refused no matter how it got here.
 */
export function isAllowedBrowserUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') {
    return false
  }
  if (url.hostname === GOOGLE_HOST) {
    const keys = [...url.searchParams.keys()]
    return url.pathname === '/search' && keys.length === 1 && keys[0] === 'q' && url.searchParams.get('q') !== ''
  }
  return url.hostname === X_HOST && url.pathname === '/' && url.search === ''
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])

/**
 * The body Apple Notes receives (it takes HTML). The title is the first line, which Notes uses as the note's
 * name. Every character of the person's text is escaped, so it can never become markup.
 */
export function noteHtml(title: string, body?: string): string {
  const lines = body === undefined ? [] : body.split(/\r\n|\r|\n/)
  const rows = lines.map((line) => `<div>${line === '' ? '<br>' : escapeHtml(line)}</div>`)
  return `<div><h1>${escapeHtml(title)}</h1></div>${rows.join('')}`
}

/** Plain text for a Windows note file: a UTF-8 byte-order mark (older Notepad needs it for accents), the title, a blank line, then the body. */
export function noteText(title: string, body?: string): string {
  const text = body === undefined ? `${title}\r\n` : `${title}\r\n\r\n${body.replace(/\r\n|\r|\n/g, '\r\n')}\r\n`
  return `\ufeff${text}`
}

const NOTES_FOLDER = 'Métis Notes'
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const FILE_NAME_MAX = 100
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_CHARS =
  /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/gu

/** A safe Windows file name stem for a title: no separators, no reserved device names, no trailing dots. */
export function windowsNoteStem(title: string): string {
  let stem = title.replace(UNSAFE_FILE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  stem = stem.replace(/[. ]+$/u, '').replace(/^[. ]+/u, '')
  if (stem.length > FILE_NAME_MAX) stem = stem.slice(0, FILE_NAME_MAX).replace(/[. ]+$/u, '')
  if (!stem) stem = 'Note'
  // A device name is reserved with or without an extension ("con", "con.txt").
  if (RESERVED_DEVICE.test(stem.split('.')[0].trim())) stem = `_${stem}`
  return stem
}

export interface WindowsNotePlan {
  directory: string
  /** The path for attempt `n` (1 is the plain name, 2 is "name (2).txt"). Always inside `directory`. */
  pathFor(attempt: number): string
}

/**
 * Where a note's file goes: `<documents>\Métis Notes\<stem>.txt`. Returns null unless every candidate path is a
 * direct child of that folder, so a title can never name a path outside it.
 */
export function planWindowsNote(documentsDir: string, title: string): WindowsNotePlan | null {
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(documentsDir)) return null
  const directory = win32.join(documentsDir, NOTES_FOLDER)
  const stem = windowsNoteStem(title)
  const pathFor = (attempt: number): string => {
    const name = attempt <= 1 ? `${stem}.txt` : `${stem} (${attempt}).txt`
    return win32.join(directory, name)
  }
  for (const attempt of [1, 2, 99]) {
    const file = pathFor(attempt)
    if (win32.dirname(file) !== directory || win32.relative(directory, file) !== win32.basename(file)) return null
  }
  return { directory, pathFor }
}
