import { randomBytes } from 'node:crypto'

export const pad = (n: number): string => String(n).padStart(2, '0')
export function slug(s: string): string {
  return (
    (s || 'meeting')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'meeting'
  )
}
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
/** Non-reversible filename segment used in place of the title slug when encryptTranscripts is on — the
 *  file CONTENTS are already encrypted, but a readable `-${slug(title)}` in the filename itself leaks the
 *  plaintext title at rest (e.g. via a OneDrive-synced folder listing). A random token carries no
 *  relationship to the title (unlike a hash, which a small guessable title space could dictionary-attack).
 *  Keeps the `stamp(started)-` prefix untouched so recall.ts's STUB_FILENAME_TIMESTAMP/NOTE_FILENAME
 *  regexes (timestamp-prefix only) still recognize the file as a real meeting/note. */
export function opaqueNamePart(): string {
  return randomBytes(6).toString('hex')
}
export const cleanTitle = (s: string): string => {
  // Collapse whitespace, strip control/newline chars, limit length for YAML/frontmatter safety.
  return (s || '')
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}
export const yamlSafeTitle = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

/** Neutralize any line that would be parsed as a markdown heading (e.g. "## Sneaky heading") inside a
 *  user-authored debrief body. Without this, a heading-shaped line in the user's OWN text is
 *  indistinguishable from a real document section — both to appendDebrief's own replace-boundary search
 *  below and to any markdown renderer. Escaping the leading `#`s keeps the text fully visible, just not
 *  heading syntax. */
export function escapeHeadingLines(s: string): string {
  return s.replace(/^(#{1,6})(\s)/gm, '\\$1$2')
}
