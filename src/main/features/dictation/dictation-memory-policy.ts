/**
 * The budgets of the dictation memory (G26). Every number here is PROPOSED unless it says PROVIDED: no owner or
 * spec value exists for the journal, so these are the smallest budgets that satisfy the acceptance text (a 12 minute
 * interrupted dictation recovers once) with room to spare. They are main-owned constants; no renderer setting or IPC
 * can change them, and a test seam may only tighten them.
 */

const DAY_MS = 86_400_000

export interface DictationJournalLimits {
  /** PROPOSED: a draft nobody asked for after seven days is deleted. */
  readonly retentionMs: number
  /** PROPOSED: at most this many dictation entries are kept; the oldest is evicted first, a live turn never. */
  readonly maxEntries: number
  /** The guard itself caps a draft at 32 KiB of UTF-8; a segment longer than this many characters is refused. */
  readonly maxSegmentChars: number
  /** PROPOSED: segments per entry (a 12 minute hands-free dictation is a few dozen 15 s turns at most). */
  readonly maxSegments: number
  /** PROPOSED: the sealed record of one entry, in bytes of plaintext JSON. */
  readonly maxEntryBytes: number
}

export const DICTATION_JOURNAL_LIMITS: Readonly<DictationJournalLimits> = Object.freeze({
  retentionMs: 7 * DAY_MS,
  maxEntries: 20,
  maxSegmentChars: 32_768,
  maxSegments: 64,
  maxEntryBytes: 262_144
})

export interface DictationDictionaryLimits {
  /** PROPOSED: entries per partition; the least recently updated is evicted first. */
  readonly maxEntries: number
  /** PROPOSED: a term or its spelling is at most this many characters. */
  readonly maxTermChars: number
}

export const DICTATION_DICTIONARY_LIMITS: Readonly<DictationDictionaryLimits> = Object.freeze({
  maxEntries: 500,
  maxTermChars: 64
})

/** PROVIDED (Clicky 1.0.37, C212-R023): a correction made within about twenty seconds can become an entry. */
export const OWNED_SPAN_WINDOW_MS = 20_000
/** PROPOSED: dictated spans held in memory for correction at once. */
export const OWNED_SPAN_MAX = 8

/** PROPOSED: a sweep reads at most this many files; anything beyond is evicted oldest first without being read. */
export const DICTATION_JOURNAL_SCAN_MAX = 256
