/**
 * Which terms did the person correct? (G26)
 *
 * A pure word-level diff between the text main dictated and the text the person corrected it to. It extracts only
 * short replacements, "heard" to "preferred spelling": a block of one to three words replaced by a block of one to
 * three words. Insertions, deletions and rewrites are edits, not spelling preferences, and teach nothing.
 *
 * Words are compared without the punctuation around them, so "Toto," and "Toto" are the same word and a comma added
 * or removed is no correction. The comparison is case-sensitive, so "toto" to "Toto" is a correction.
 *
 * Text without spaces (Chinese, Japanese, Thai) splits into one huge "word"; its replacement is longer than a term
 * may be and is refused. Learning from such scripts needs a segmenter and is out of scope here (UNKNOWN: G25 owns
 * the language handling).
 */
import { DICTATION_DICTIONARY_LIMITS } from './dictation-memory-policy'

export interface TermPair {
  readonly heard: string
  readonly preferred: string
}

/** PROPOSED: the longest block of words that counts as one term, and the most terms one correction teaches. */
const MAX_BLOCK_WORDS = 3
const MAX_PAIRS = 8
/** A middle (after the common head and tail) longer than this is a rewrite. */
const MAX_MIDDLE_WORDS = 400
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000e-\u001f\u007f]/

interface Word {
  /** Without edge punctuation: what is compared and stored. */
  readonly core: string
}

function words(text: string): Word[] {
  const out: Word[] = []
  for (const raw of text.split(/\s+/)) {
    const core = raw.replace(EDGE, '')
    if (core.length > 0) out.push({ core })
  }
  return out
}

export function extractTermCorrections(original: string, corrected: string): TermPair[] {
  if (CONTROL.test(corrected) || CONTROL.test(original)) return []
  const before = words(original)
  const after = words(corrected)
  if (before.length === 0 || after.length === 0) return []

  let head = 0
  while (head < before.length && head < after.length && before[head].core === after[head].core) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail].core === after[after.length - 1 - tail].core
  )
    tail++
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  if (a.length === 0 || b.length === 0) return []
  if (a.length > MAX_MIDDLE_WORDS || b.length > MAX_MIDDLE_WORDS) return []

  // Longest common subsequence of the middle, then the unmatched runs between matches are the replacements.
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i].core === b[j].core
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const blocks: Array<{ removed: Word[]; added: Word[] }> = []
  let removed: Word[] = []
  let added: Word[] = []
  const flush = (): void => {
    if (removed.length > 0 || added.length > 0) blocks.push({ removed, added })
    removed = []
    added = []
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].core === b[j].core) {
      flush()
      i++
      j++
    } else if (j >= b.length || (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      removed.push(a[i++])
    } else {
      added.push(b[j++])
    }
  }
  flush()

  if (blocks.length === 0 || blocks.length > MAX_PAIRS) return []
  // A correction that changes more than half of what was said is a rewrite.
  const changed = blocks.reduce((sum, block) => sum + Math.max(block.removed.length, block.added.length), 0)
  if (changed > Math.max(MAX_BLOCK_WORDS, Math.ceil(before.length / 2))) return []

  const max = DICTATION_DICTIONARY_LIMITS.maxTermChars
  const pairs = new Map<string, TermPair>()
  for (const block of blocks) {
    if (block.removed.length < 1 || block.removed.length > MAX_BLOCK_WORDS) continue
    if (block.added.length < 1 || block.added.length > MAX_BLOCK_WORDS) continue
    const heard = block.removed
      .map((word) => word.core)
      .join(' ')
      .toLowerCase()
    const preferred = block.added.map((word) => word.core).join(' ')
    if (heard.length > max || preferred.length > max || heard === preferred) continue
    pairs.set(heard, { heard, preferred })
  }
  return [...pairs.values()]
}
