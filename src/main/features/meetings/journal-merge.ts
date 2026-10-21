import type { TranscriptLine } from '@shared/transcript-line'
import { draftSummaryFields } from './draft-transcript-document'
import { parseMeetingDocument, serializeMeetingDocument } from './meeting-document'
import {
  decodeStoredMeetingSpeechAsync,
  renderMeetingTranscriptAsync,
  rewriteStoredSpeechTranscriptAsync
} from './meeting-speech'
import { lineIdentityKey, type JournalRecord } from './journal-reader'

/**
 * Merging a live meeting journal into an orphaned autosave draft (WP03 / C09b T6).
 *
 * Precedence: the DRAFT is authoritative for every line it holds, because it carries speaker renames, deletions and
 * edits the journal never sees. The journal only adds the records that landed after the draft's last autosave. A
 * journal record is such a tail record when it is newer than every journal record the draft already contains: a line
 * the user deleted from the draft earlier has an older revision than a line the draft still has, so it is not
 * resurrected. Only a line deleted after the draft's last tick (and before the crash) can reappear, which is the
 * accepted "recover more rather than lose" trade-off.
 */

const NO_SPEECH_PLACEHOLDER = '_No speech captured yet._'

/** Journal records newer than the newest journal record the draft already holds, in revision order. */
export function selectJournalTail(
  draftLines: readonly TranscriptLine[],
  records: readonly JournalRecord[]
): JournalRecord[] {
  const inDraft = new Set<string>()
  for (const line of draftLines) {
    const key = lineIdentityKey(line)
    if (key) inDraft.add(key)
  }
  let anchor = 0
  for (const record of records)
    if (record.identityKey && inDraft.has(record.identityKey)) anchor = Math.max(anchor, record.revision)
  return records
    .filter((record) => record.revision > anchor && !(record.identityKey && inDraft.has(record.identityKey)))
    .sort((a, b) => a.revision - b.revision)
}

/**
 * Stable merge by line time: the draft's lines keep their own order, tail lines keep revision order, and on a tie the
 * draft's line comes first.
 */
export function mergeLinesByTime(draft: readonly TranscriptLine[], tail: readonly TranscriptLine[]): TranscriptLine[] {
  const merged: TranscriptLine[] = []
  let d = 0
  let t = 0
  while (d < draft.length || t < tail.length) {
    if (t >= tail.length || (d < draft.length && draft[d].t <= tail[t].t)) merged.push(draft[d++])
    else merged.push(tail[t++])
  }
  return merged
}

export type DraftMergeResult =
  | { status: 'merged'; text: string; added: number }
  /** The draft already holds every record (or the journal is empty): the text is untouched. */
  | { status: 'nothing-to-add' }
  /** The draft cannot take a merge safely (no frame to rewrite, ambiguous or invalid frame, over budget). */
  | { status: 'unmergeable' }

/** Rewrites `duration_min` and `participants` so the recovered meeting's badges describe the merged lines. */
function withSummaryFields(text: string, lines: readonly TranscriptLine[], startedAt: number): string {
  const document = parseMeetingDocument(text)
  if (!document) return text
  const { durMin, participants } = draftSummaryFields(lines, startedAt)
  document.lines = document.lines.map((line) => {
    if (line.startsWith('duration_min: ')) return `duration_min: ${durMin}`
    if (line.startsWith('participants: ')) return `participants: [${participants.join(', ')}]`
    return line
  })
  return serializeMeetingDocument(document)
}

/** Merges the journal's missing tail into the draft text. Never throws; the draft text is never modified on failure. */
export async function mergeJournalIntoDraft(
  draftText: string,
  startedAt: number,
  records: readonly JournalRecord[]
): Promise<DraftMergeResult> {
  try {
    if (records.length === 0) return { status: 'nothing-to-add' }
    const decoded = await decodeStoredMeetingSpeechAsync(draftText)
    if (!decoded.ok) return { status: 'unmergeable' }
    let draftLines: TranscriptLine[]
    let empty = false
    if (decoded.status === 'valid') {
      draftLines = decoded.lines
    } else if (decoded.status === 'absent' && draftText.includes(`\n${NO_SPEECH_PLACEHOLDER}\n`)) {
      // A draft written before the first final was committed: its body is the empty-transcript placeholder.
      draftLines = []
      empty = true
    } else {
      // Plain (unframed) draft lines or an unverifiable frame cannot be rewritten without dropping or inventing lines.
      return { status: 'unmergeable' }
    }
    const tail = selectJournalTail(draftLines, records)
    if (tail.length === 0) return { status: 'nothing-to-add' }
    const merged = mergeLinesByTime(
      draftLines,
      tail.map((record) => record.line)
    )
    let rewritten: string | null
    if (empty) {
      const rendered = await renderMeetingTranscriptAsync(merged)
      // A replacer function: spoken text can contain `$&`-style patterns that a string replacement would expand.
      rewritten = draftText.replace(NO_SPEECH_PLACEHOLDER, () => rendered)
    } else {
      rewritten = await rewriteStoredSpeechTranscriptAsync(draftText, merged)
    }
    if (!rewritten) return { status: 'unmergeable' }
    return { status: 'merged', text: withSummaryFields(rewritten, merged, startedAt), added: tail.length }
  } catch {
    return { status: 'unmergeable' }
  }
}
