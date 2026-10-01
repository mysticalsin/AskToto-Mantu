// The one reader/writer of a saved meeting's leading `---` frontmatter block. Meeting files are written
// with LF but arrive with CRLF after a cloud-sync or editor round-trip, so every consumer must agree on
// the delimiter grammar: a divergent parser that only knows LF sees no block in a CRLF file, and a
// confidentiality check built on it fails open. scripts/check-architecture.mjs (FF-15) rejects any other
// frontmatter-delimiter regex under src/main.

/** A well-formed double-quoted YAML scalar, capturing its body: the shape every title/mode value is
 *  written in (see saveMeeting's frontmatter block in transcripts.ts). */
const QUOTED_SCALAR = /^"((?:[^"\\]|\\.)*)"\s*$/

/** Opening `---` line, the block's lines, and a closing `---` that ends its line (or the file). Trailing
 *  spaces/tabs after either delimiter are tolerated (editors leave them; YAML allows them). A longer run
 *  such as `----` is NOT a delimiter, so a block closed that way is "no block" and callers fail closed
 *  (readConfidentialMeetings then excludes the meeting rather than publishing it). */
const FRONTMATTER = /^---[ \t]*(\r?\n)([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/

const LINE_KEY = /^([a-z_]+):/i

export interface MeetingDocument {
  /** The frontmatter block's lines, without delimiters or line endings. */
  lines: string[]
  /** The line ending the block was written with; kept so a rewrite never mixes endings. */
  eol: '\n' | '\r\n'
  /** Everything after the closing `---`, starting with its line ending. */
  body: string
}

/** Splits a meeting file into frontmatter lines and body. Null when there is no complete leading block —
 *  a missing block and an unclosed one are indistinguishable to callers, and both must fail closed. */
export function parse(text: string): MeetingDocument | null {
  const m = FRONTMATTER.exec(text)
  if (!m) return null
  return { lines: m[2].split(/\r?\n/), eol: m[1] === '\r\n' ? '\r\n' : '\n', body: text.slice(m[0].length) }
}

export function serialize(doc: MeetingDocument): string {
  // Rewrites canonicalize delimiter lines to bare `---`; the codec preserves frontmatter data, body,
  // and line endings, but not harmless trailing whitespace on the delimiters.
  return `---${doc.eol}${doc.lines.join(doc.eol)}${doc.eol}---${doc.body}`
}

export const parseMeetingDocument = parse
export const serializeMeetingDocument = serialize

/** Decodes one raw frontmatter value. Undoes the YAML escaping the writers apply (`\` → `\\`, `"` → `\"`):
 *  without the inverse the escapes reach History verbatim and the rename box re-escapes them on every
 *  commit. Anything that is not a well-formed quoted scalar (a `[a, b]` flow list, a plain unquoted value
 *  such as `date:`) just loses its outer quote/bracket characters. */
function decodeScalar(raw: string): string {
  const quoted = raw.match(QUOTED_SCALAR)
  return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : raw.replace(/^["[]|["\]]$/g, '').trim()
}

/** The frontmatter's `key: value` pairs, decoded; empty when the file has no complete block. */
export function readMeetingFields(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of parse(text)?.lines ?? []) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i)
    if (kv) out[kv[1]] = decodeScalar(kv[2])
  }
  return out
}

/** True when ANY frontmatter line for `key` decodes to `true` (case-insensitive), so a duplicated key can
 *  never let a later value override an earlier `true`; false when there is no complete block. */
export function hasMeetingFlag(text: string, key: string): boolean {
  const wanted = key.toLowerCase()
  return (parse(text)?.lines ?? []).some((line) => {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i)
    return kv !== null && kv[1].toLowerCase() === wanted && /^true$/i.test(decodeScalar(kv[2]))
  })
}

/** The file with its frontmatter block (and the line ending after it) removed. */
export function stripMeetingFrontmatter(text: string): string {
  const doc = parse(text)
  return doc ? doc.body.replace(/^\r?\n/, '') : text
}

/** Sets `key` to the raw serialized `value` (caller quotes/escapes): replaces the first existing line and
 *  drops duplicates, or appends when absent. A null value removes the key. */
export function setMeetingField(doc: MeetingDocument, key: string, value: string | null): MeetingDocument {
  const isKey = (line: string): boolean => LINE_KEY.exec(line)?.[1].toLowerCase() === key.toLowerCase()
  const lines: string[] = []
  let placed = false
  for (const line of doc.lines) {
    if (!isKey(line)) lines.push(line)
    else if (!placed && value !== null) {
      lines.push(`${key}: ${value}`)
      placed = true
    }
  }
  if (!placed && value !== null) lines.push(`${key}: ${value}`)
  return { ...doc, lines }
}
