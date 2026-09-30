import { exciseDeletedMeeting } from './brain/ingest'
import { join, basename } from 'node:path'
import { safeMeetingBasename } from './meeting-path'
import { resolveMeetingsFolder, decodeSaved, isEncryptedBytes, writeSaved, formatTranscript, DEBRIEF_HEADING } from './transcripts'
import { storageAt } from './infra/storage/meetings-storage'
import type { HydrationProgress, ReadOptions } from './infra/storage/gateway'
import { DRAFT_FILENAME, UNREADABLE, frontmatter, isMeetingDocumentType, meetingFiles, readMeetings } from './history-read'
import { editMeetingIndex, removeMeetingFile } from './meeting-files'
import { getSettings } from './store'
import { detectLanguage } from '@shared/lang-id'
import { measuredDurationMs } from '@shared/meeting-duration'
import { readRecapStatus, recapStatusValidationError, type RecapStatus } from '@shared/recap-status'
import type { RecallReadResult, Settings, TranscriptLine } from '@shared/ipc'
import type { RecallHydration } from '@shared/recall-hydration'

// Independent meeting-history backend (own implementation, no third-party source): reading one saved
// meeting back, editing it, and deleting it. History's list and search read path lives in history-read.ts.
// Reaches the meetings folder only through the storage gateway and meeting-files.ts, never node:fs.
export { listMeetings, searchMeetings, searchMeetingsLatest, type HistoryRow } from './history-read'

// The recap's sibling section per document type (see isMeetingDocumentType in history-read.ts): History,
// search, recap editing, and erasure must never disagree about where a recap ends.
const FULL_TRANSCRIPT_HEADING_RE = /^## Full transcript\b/m
const RETENTION_HEADING_RE = /^## Retention\b/m

function recapSectionEndRe(type: string | undefined): RegExp {
  return type === 'meeting-summary' ? RETENTION_HEADING_RE : FULL_TRANSCRIPT_HEADING_RE
}

function recapSectionEndIndex(afterNotesHeading: string, type: string | undefined): number {
  return afterNotesHeading.search(recapSectionEndRe(type))
}

async function readMeetingBytes(folder: string, file: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const read = await storageAt(folder).read(file)
  if (read.status === 'missing') return { ok: false, error: 'Meeting file not found.' }
  if (read.status !== 'ok') return { ok: false, error: 'Could not read the meeting file.' }
  return { ok: true, bytes: read.bytes }
}

async function readMeetingText(folder: string, file: string): Promise<{ ok: true; text: string; encrypted: boolean } | { ok: false; error: string }> {
  const read = await readMeetingBytes(folder, file)
  if (!read.ok) return read
  const text = decodeSaved(read.bytes)
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }
  return { ok: true, text, encrypted: isEncryptedBytes(read.bytes) }
}

/** Background repair only fills missing notes. Nonempty incomplete notes may contain manual edits;
 *  replacing them requires the user's explicit Retry action, not a background pass. */
export function meetingTextNeedsRecap(text: string): boolean {
  if (!text.trim()) return true
  const startMatch = text.match(/^## Notes & follow-ups[\r\n]+/m)
  if (!startMatch) return true
  const afterStart = text.slice(startMatch.index! + startMatch[0].length)
  const endIdx = recapSectionEndIndex(afterStart, frontmatter(text).type)
  const recap = (endIdx === -1 ? afterStart : afterStart.slice(0, endIdx)).trim()
  return recap.length === 0
}

export async function listMeetingsNeedingRecap(): Promise<Array<{ file: string; mode: string; lines: TranscriptLine[] }>> {
  const folder = resolveMeetingsFolder(getSettings())
  const files = await meetingFiles(folder)
  const out: Array<{ file: string; mode: string; lines: TranscriptLine[] }> = []
  const reads = await readMeetings(folder, files)
  for (const [i, f] of files.entries()) {
    const read = reads[i]
    if (!read || read.sum.locked) continue
    if (!meetingTextNeedsRecap(read.text)) continue
    const parsed = await recallRead(f)
    if (!parsed.ok || !parsed.lines?.length) continue
    out.push({ file: f, mode: parsed.mode || read.sum.mode || 'meeting', lines: parsed.lines })
  }
  return out
}

/** An explicit open that needs a download while another meeting's download holds the one slot. */
export const HYDRATION_BUSY_MSG = 'Another meeting is still downloading. Open this one when it finishes.'
/** An explicit open whose download started and did not finish (offline, provider error, a minute passed). */
export const HYDRATION_FAILED_MSG = 'Could not download this meeting. Check your connection and try again.'

/** True while an explicit open of a file that may need a download holds the one hydration slot. */
let hydrating = false

/**
 * History's explicit open of one meeting (IPC.recallRead, IPC.recallOpen), reporting its download to the
 * renderer through `send`. `open` is the read itself (recallRead or meetingOpenTarget) given the options.
 *
 * Invariants:
 *   - At most one explicit open may hydrate at a time. The open classifies its file first: a file whose
 *     classify does not show it on this device (dataless, unknown, timed out, unavailable) is the only
 *     kind that takes the slot, from its classify until it settles; any other file opens without a
 *     download and never takes or waits on the slot. A may-download open that finds the slot taken
 *     answers HYDRATION_BUSY_MSG unread.
 *   - A download that starts sends 'hydrating', then exactly one 'done' or 'failed' once the open settles;
 *     an open that needed no download sends nothing. A failed download answers HYDRATION_FAILED_MSG.
 *   - `send` throwing (a closed window) never fails the open.
 */
export async function openExplicitly<T extends { ok: boolean; error?: string }>(
  file: string,
  send: (event: RecallHydration) => void,
  open: (options: Pick<ReadOptions, 'hydrate' | 'onProgress'>) => Promise<T>
): Promise<T | { ok: false; error: string }> {
  const report = (event: RecallHydration): void => {
    try {
      send(event)
    } catch {
      // the renderer went away; the open still answers its caller
    }
  }
  const safeName = safeMeetingBasename(file)
  const fileClass = safeName ? (await storageAt(resolveMeetingsFolder(getSettings())).classify([safeName])).get(safeName) : undefined
  if (!fileClass || fileClass.status === 'ok' || fileClass.status === 'missing') return open({ hydrate: false })
  if (hydrating) return { ok: false, error: HYDRATION_BUSY_MSG }
  hydrating = true
  let progress = null as HydrationProgress['state'] | null
  try {
    const result = await open({
      hydrate: true,
      onProgress: (p) => {
        progress = p.state
        if (p.state === 'hydrating') report({ file, state: 'hydrating' })
      }
    })
    if (progress === 'done') report({ file, state: 'done' })
    if (progress !== 'hydrating') return result
    report({ file, state: 'failed', error: HYDRATION_FAILED_MSG })
    return { ok: false, error: HYDRATION_FAILED_MSG }
  } finally {
    hydrating = false
  }
}

/**
 * Read a saved meeting file back into memory for "Resume session".
 * Parses frontmatter (title, mode, date → startedAt), the recap section, and the transcript lines.
 * Constrained to the meetings folder (same basename guard as recallOpen in index.ts — no traversal).
 */
export async function recallRead(
  file: string,
  { hydrate = false, onProgress }: { hydrate?: boolean; onProgress?: (progress: HydrationProgress) => void } = {}
): Promise<RecallReadResult> {
  const folder = resolveMeetingsFolder(getSettings())
  // basename blocks path traversal (mirrors the recallOpen guard in index.ts).
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  const gateway = storageAt(folder)
  // Classify decides only two things: a vanished file, and a FIFO, socket or device, which is refused
  // before any read (a plain gateway read would still open it once the detector answers). Its other
  // verdicts never skip a read: its deadline is shorter than a read's, so 'unknown' can name a local file.
  const fileClass = (await gateway.classify([safeName])).get(safeName)
  if (fileClass?.status === 'missing') return { ok: false, error: 'Meeting file not found.' }
  if (fileClass && 'isRegular' in fileClass && !fileClass.isRegular) return { ok: false, error: 'Could not read the meeting file.' }
  let read = await gateway.read(safeName)
  // An explicit open (`hydrate`) is the one place a cloud-only file is hydrated: this one file, under a
  // content permit, reporting progress. Listing, search and background passes never do.
  if (hydrate && (read.status === 'dataless' || read.status === 'unknown')) read = await gateway.read(safeName, { hydrate: true, onProgress })
  if (read.status === 'missing') return { ok: false, error: 'Meeting file not found.' }
  if (read.status !== 'ok') {
    return { ok: false, error: 'Could not read the meeting file.' }
  }
  const text = decodeSaved(read.bytes)
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }

  const fm = frontmatter(text)
  if (!isMeetingDocumentType(fm.type)) {
    return { ok: false, error: 'This does not look like a meeting file.' }
  }

  // Recover startedAt from the frontmatter `date` field (ISO string written by saveMeeting).
  let startedAt: number | undefined
  if (fm.date) {
    const ms = Date.parse(fm.date)
    if (!isNaN(ms)) startedAt = ms
  }

  // Extract the recap section (## Notes & follow-ups … up to its document type's sibling, Full transcript
  // for a transcript or Retention for a managed summary-only meeting). A transcript recap may legitimately
  // contain a user-authored “## Retention” subsection, so that heading is never a generic boundary. The
  // recap markdown itself starts with its own "## Overview:" heading
  // (RECAP_PROMPT's format), so stopping at any "## " would match that nested heading immediately and
  // capture nothing — the end must target the real sibling section specifically. Done as a plain slice +
  // a second, END-only regex rather than one combined lookahead: with the /m flag (needed for the "^"
  // start anchors), "$" matches before ANY newline, not just end-of-string, so a "\s*$" fallback inside
  // the same lookahead stops at the end of the first line too — the exact bug this replaces.
  let recap = ''
  const startMatch = text.match(/^## Notes & follow-ups[\r\n]+/m)
  if (startMatch) {
    const afterStart = text.slice(startMatch.index! + startMatch[0].length)
    const endIdx = recapSectionEndIndex(afterStart, fm.type)
    recap = (endIdx === -1 ? afterStart : afterStart.slice(0, endIdx)).trim()
  }

  // Parse transcript lines from the ## Full transcript section.
  // Format written by saveMeeting: **[HH:MM:SS] Them:**, **You:**, or an imported recording's **Speaker:**.
  const lines: TranscriptLine[] = []
  const transcriptMatch = text.match(/^## Full transcript[\r\n]+([\s\S]*)$/m)
  if (transcriptMatch) {
    const body = transcriptMatch[1]
    // Use the ISO date from frontmatter to reconstruct absolute timestamps (same calendar day).
    // When startedAt is missing (unparsable/absent date field), fall back to an arbitrary fixed
    // anchor (read time) so every line still gets a real, monotonically increasing timestamp instead
    // of collapsing to 0 — the parsed HH:MM:SS is real elapsed-time data even without a calendar date.
    const baseDate = startedAt ? new Date(startedAt) : new Date()
    // Optional group 5 captures a Speaker Intelligence display name — "Them (Jane Doe):**" — written by
    // transcripts.ts's formatTranscriptLine once one has been resolved; absent on every meeting saved
    // before that feature existed, and on any line no name was ever resolved for.
    // MQA-245: `Speaker 1` (a diarization cluster label standing alone) joins the accepted label set.
    // Older files wrote it as `Speaker (Speaker 1)` and still parse through the optional paren group
    // below — this only ADDS a form, so no previously-saved meeting changes meaning.
    const lineRe = /^\*\*\[(\d{2}):(\d{2}):(\d{2})\] (Them|You|Speaker(?: \d+)?)(?: \(([^)]*)\))?:\*\* (.+)$/gm
    let m: RegExpExecArray | null
    // Seeded at the SAME resolution the comparison runs at: the frontmatter `date` keeps milliseconds
    // while every reconstructed time below is floored to the whole second, so an unfloored seed reads a
    // first line inside the start's own second as a midnight crossing and pushes it — and, via prevT,
    // every line after it — a full day forward. Imported recordings hit that on almost every file: their
    // startedAt is a raw mtime and line 0 sits exactly on it (see import-jobs.ts).
    let prevT: number | undefined = startedAt !== undefined ? Math.floor(startedAt / 1000) * 1000 : undefined
    while ((m = lineRe.exec(body)) !== null) {
      const [, hh, mm, ss, speakerLabel, name, lineText] = m
      const d = new Date(baseDate)
      d.setHours(Number(hh), Number(mm), Number(ss), 0)
      // If the reconstructed time is before the previous line's timestamp (midnight crossing), push
      // to the next day — compares against the previous line rather than startedAt so this still
      // works when startedAt is unavailable.
      if (prevT !== undefined && d.getTime() < prevT) d.setDate(d.getDate() + 1)
      const t = d.getTime()
      prevT = t
      const line: TranscriptLine = {
        speaker: speakerLabel === 'Them' ? 'them' : speakerLabel === 'You' ? 'you' : 'unknown',
        text: lineText.trim(),
        t
      }
      // A bare cluster label carries the identity in the label slot, not the paren slot.
      if (name) line.name = name.trim()
      else if (/^Speaker \d+$/.test(speakerLabel)) line.name = speakerLabel
      // Re-derive the spoken-language tag the same way the live path does (commitLine). The saved file
      // carries language only as "_[conversation switches to …]_" marker PROSE, which this line regex
      // rightly skips — without re-tagging, a Speaker Intelligence backfill rewrite (updateMeetingNames
      // → formatTranscript over these reparsed lines) would silently strip every marker, and a
      // retroactive "Generate recap" on a reopened meeting would see no switches at all.
      const lang = detectLanguage(line.text).lang
      if (lang) line.lang = lang
      lines.push(line)
    }
  }

  return {
    ok: true,
    title: fm.title || safeName.replace(/\.md$/, ''),
    mode: fm.mode || 'general',
    startedAt,
    durationMs: fm.duration_ms ? measuredDurationMs(Number(fm.duration_ms)) : undefined,
    recap,
    recapStatus: readRecapStatus(fm.recap_status),
    lines,
    confidential: fm.confidential === 'true',
    // MQA-092 — the CRM payload fingerprint of the last push that this meeting's CRM connection
    // accepted, so re-opening it after a relaunch does not re-arm "Push to CRM" and file a duplicate.
    crmPushedKey: fm.crm_pushed || undefined
  }
}

/**
 * Delete a saved meeting: remove the .md file from disk and strip its row from index.md.
 * Constrains `file` to the meetings folder via basename() (mirrors the recallOpen guard — no traversal).
 */
export async function deleteMeeting(file: string): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(getSettings())
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  try {
    await removeMeetingFile(folder, safeName)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not delete meeting file.' }
  }
  // Remove the matching row from index.md (best-effort — a missing / unreadable index is not fatal).
  try {
    // Each row ends with `| [open](safeName) |` — match the exact filename in the link cell.
    const escaped = safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await editMeetingIndex(folder, (raw) =>
      raw
        .split('\n')
        .filter((line) => !new RegExp(`\\(${escaped}\\)`).test(line))
        .join('\n')
    )
  } catch {
    /* index update is best-effort; never fail the delete because of it */
  }
  return { ok: true }
}

// Sanitize a user-typed title for safe storage in YAML frontmatter and a markdown H1: strip
// control/newline characters (a raw newline would break out of the frontmatter's single-line `title:`
// value, or fork the H1 across lines), collapse whitespace, and cap length so an unbounded paste can't
// bloat the file. Duplicated from transcripts.ts's own cleanTitle/yamlSafeTitle (not exported there,
// and transcripts.ts is outside this feature's owned files) rather than imported.
const RENAME_TITLE_MAX = 120
function sanitizeRenameTitle(s: string): string {
  return (s || '')
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RENAME_TITLE_MAX)
}
function yamlSafeRenameTitle(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

/**
 * Rename a saved meeting after the fact (the recap-generated title can be wrong or too terse). Updates
 * the frontmatter `title:` value AND the body's first H1 heading in place — the FILE itself is never
 * renamed, so index.md rows, saved deep-links, and knowledge-graph edges (all keyed by filename) stay
 * valid. Same basename guard as deleteMeeting (no traversal, no touching index.md/README.md).
 *
 * Encryption is preserved exactly as found: `isEncryptedFile` (not the current `settings.encryptTranscripts`
 * toggle, which may have changed since this file was saved) decides whether to decrypt-edit-re-encrypt or
 * edit the plaintext in place, so a renamed encrypted meeting stays encrypted and still opens normally.
 */
export async function renameMeeting(
  settings: Settings,
  file: string,
  newTitle: string
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  const title = sanitizeRenameTitle(newTitle)
  if (!title) return { ok: false, error: 'Enter a title.' }

  const fullPath = join(folder, safeName)
  const read = await readMeetingText(folder, safeName)
  if (!read.ok) return read
  const { text, encrypted: wasEncrypted } = read

  // Replace the frontmatter `title:` value (always written double-quoted — see saveMeeting/saveNote)
  // within the frontmatter block only, so a coincidental "title:"-looking line in the transcript body
  // can never be mistaken for it.
  const fmMatch = text.match(/^---\n[\s\S]*?\n---/)
  if (!fmMatch) return { ok: false, error: 'Not a meeting transcript.' }
  const escapedTitle = yamlSafeRenameTitle(title)
  // Replacement FUNCTIONS, not template-literal strings: String.replace treats a string replacement's `$`
  // sequences ($$, $&, $`, $') as special, so a title containing them (e.g. "Deal $&Co") would otherwise
  // mangle the output (or splice in the old title / whole match) instead of being written verbatim.
  const newFmBlock = fmMatch[0].replace(/^title:\s*"(?:[^"\\]|\\.)*"\s*$/m, () => `title: "${escapedTitle}"`)
  if (newFmBlock === fmMatch[0]) return { ok: false, error: 'Could not find a title to rename in this file.' }
  let updated = text.slice(0, fmMatch.index!) + newFmBlock + text.slice(fmMatch.index! + fmMatch[0].length)

  // Replace the body's first H1 heading (the only "# " line — recap sections use "## "). Best-effort:
  // an old/malformed file missing it still gets the frontmatter update above.
  updated = updated.replace(/^#(?!#).*$/m, () => `# ${title}`)

  try {
    await writeSaved(fullPath, updated, wasEncrypted)
  } catch {
    return { ok: false, error: 'Could not save the new title.' }
  }

  // Mirror the matching row's Title column in index.md (best-effort — a missing/unreadable index is
  // not fatal, same as deleteMeeting). Skipped for encrypted meetings: index.md is plaintext, so it never
  // carries titles for encrypted files in the first place (see saveMeeting/appendIndexRow).
  if (!wasEncrypted) {
    try {
      const marker = `[open](${safeName})`
      const safeTitleCell = title.replace(/\|/g, '/')
      await editMeetingIndex(folder, (rawIndex) =>
        rawIndex
          .split('\n')
          .map((line) => {
            if (!line.includes(marker)) return line
            const cells = line.split('|')
            if (cells.length < 6) return line
            cells[2] = ` ${safeTitleCell} `
            return cells.join('|')
          })
          .join('\n')
      )
    } catch {
      /* index update is best-effort; never fail the rename because of it */
    }
  }

  return { ok: true }
}

// Sane cap on an edited recap so a runaway paste can't bloat the saved file. Kept in lockstep with the
// UpdateRecapPayloadSchema max in shared/ipc.ts (defense-in-depth: the renderer's textarea already caps too).
const RECAP_MAX = 20000
// Normalize an edited recap for storage: CRLF→LF (a textarea on Windows yields \r\n, which would drift the
// markdown vs. the always-\n files saveMeeting writes), strip a leading BOM, and cap length. Deliberately
// does NOT collapse newlines or strip headings — unlike a title, the recap IS multi-line markdown with its
// own "## " sub-headings (Overview / Decisions / Action items …), so that structure must survive editing.
function sanitizeRecap(s: string): string {
  return (s || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').slice(0, RECAP_MAX)
}

/**
 * Rewrite ONLY the recap section of a saved meeting after the fact (fix a mis-heard name, tick an action
 * item, annotate). Replaces the body of the "## Notes & follow-ups" section — the exact span recallRead
 * parses, bounded before the sibling heading for the document type — "## Full transcript" for a transcript
 * or "## Retention" for a managed summary-only meeting — with the edited
 * markdown, leaving the frontmatter, the H1, the meta line, and the sibling section untouched, except for
 * an explicitly supplied recapStatus. An omitted status preserves the existing outcome (manual edits
 * are not evidence that an interrupted generation completed). The FILE is
 * never renamed. If the meeting was saved with an empty recap (saveMeeting omits the heading entirely in
 * that case), the section is INSERTED immediately before its transcript/retention sibling so it parses
 * identically to a normally-saved recap. Same basename guard as renameMeeting/deleteMeeting (no traversal,
 * no index/README).
 *
 * Encryption is preserved exactly as found: isEncryptedFile (not the live `encryptTranscripts` toggle, which
 * may differ from when this file was saved) decides decrypt-edit-re-encrypt vs. edit-plaintext-in-place, so
 * an edited encrypted meeting stays encrypted and still opens. index.md is not touched: it carries only
 * title/date/duration/link, none of which the recap changes.
 */
export async function updateMeetingRecap(
  settings: Settings,
  file: string,
  newRecap: string,
  recapStatus?: RecapStatus
): Promise<{ ok: boolean; error?: string }> {
  const statusError = recapStatusValidationError(newRecap, recapStatus)
  if (statusError) return { ok: false, error: statusError }
  if (recapStatus !== undefined && newRecap.length > RECAP_MAX) {
    return { ok: false, error: 'The generated summary is too long to save without losing text.' }
  }
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }

  const recap = sanitizeRecap(newRecap)
  const body = recap.trim()
  const fullPath = join(folder, safeName)
  const read = await readMeetingText(folder, safeName)
  if (!read.ok) return read
  const { text, encrypted: wasEncrypted } = read
  const type = frontmatter(text).type
  const recapEndRe = recapSectionEndRe(type)
  // Guard only the actual sibling heading for this document type. A legacy/full transcript recap may use
  // “## Retention” as an ordinary user-authored subsection and must round-trip without truncation.
  if (recapEndRe.test(body)) {
    const heading = type === 'meeting-summary' ? '## Retention' : '## Full transcript'
    return { ok: false, error: `The "${heading}" heading is reserved. Please rename it in your notes.` }
  }

  let updated: string
  const startMatch = text.match(/^## Notes & follow-ups[\r\n]+/m)
  if (startMatch) {
    // Existing section: replace its body only. `head` runs up to and including the heading + the newlines
    // saveMeeting wrote after it; `tail` is the untouched transcript/retention sibling remainder (or
    // '' when, defensively, no such section exists). The rebuilt "\n\n" restores the single blank line
    // before the next section so the markdown — and recallRead's slice — stay well-formed.
    const bodyStart = startMatch.index! + startMatch[0].length
    const afterStart = text.slice(bodyStart)
    const endIdx = recapSectionEndIndex(afterStart, type)
    const head = text.slice(0, bodyStart)
    const tail = endIdx === -1 ? '' : afterStart.slice(endIdx)
    updated = tail
      ? `${head}${body}${body ? '\n\n' : ''}${tail}`
      : `${head}${body}${body ? '\n' : ''}`
  } else {
    // No notes section yet (meeting saved with an empty recap). Insert one immediately before its
    // transcript/retention sibling so recallRead parses it exactly as it would a normally-saved recap.
    const sectionMatch = text.match(recapEndRe)
    if (!sectionMatch) return { ok: false, error: 'This does not look like a meeting file.' }
    if (!body) {
      if (recapStatus === undefined) return { ok: true }
      updated = text // An empty failed attempt still has a durable outcome, without an empty section.
    } else {
      const at = sectionMatch.index!
      updated = `${text.slice(0, at)}## Notes & follow-ups\n\n${body}\n\n${text.slice(at)}`
    }
  }

  if (recapStatus !== undefined) {
    const fm = updated.match(/^---\n([\s\S]*?)\n---/)
    if (!fm) return { ok: false, error: 'Could not save the summary status: missing meeting frontmatter.' }
    const fields = fm[1].split('\n').filter((line) => !/^recap_status:/i.test(line))
    fields.push(`recap_status: ${recapStatus}`)
    updated = `---\n${fields.join('\n')}\n---${updated.slice(fm[0].length)}`
  }

  try {
    await writeSaved(fullPath, updated, wasEncrypted)
  } catch {
    return { ok: false, error: 'Could not save your changes.' }
  }
  return { ok: true }
}

/**
 * Speaker Intelligence backfill (Phase A) — rewrite ONLY the "## Full transcript" section of a saved
 * meeting with freshly-resolved speaker names (see main/graph-transcript.ts + shared/transcript-align.ts),
 * once a Teams transcript for the same meeting has been matched after the fact. Re-renders `lines`
 * through transcripts.ts's own formatTranscript — the exact shape this module's lineRe (in recallRead)
 * parses back — leaving the frontmatter, the H1/meta line, and any "## Notes & follow-ups" section
 * untouched. Same basename guard + "preserve encryption exactly as found" convention as
 * renameMeeting/updateMeetingRecap/setMeetingConfidential.
 */
export async function updateMeetingTranscript(
  settings: Settings,
  file: string,
  lines: TranscriptLine[]
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }

  const fullPath = join(folder, safeName)
  const read = await readMeetingText(folder, safeName)
  if (!read.ok) return read
  const { text, encrypted: wasEncrypted } = read

  const startMatch = text.match(/^## Full transcript[\r\n]+/m)
  if (!startMatch) return { ok: false, error: 'This does not look like a meeting file.' }

  // A debrief section (see transcripts.ts's appendDebrief) is always appended strictly AFTER "## Full
  // transcript" — preserve it exactly, mirroring updateMeetingRecap's own head/tail split against its
  // sibling "## Full transcript" boundary above.
  const bodyStart = startMatch.index! + startMatch[0].length
  const afterStart = text.slice(bodyStart)
  const debriefRe = new RegExp('^' + DEBRIEF_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm')
  const debriefIdx = afterStart.search(debriefRe)
  const tail = debriefIdx === -1 ? '' : afterStart.slice(debriefIdx)
  const head = text.slice(0, bodyStart)
  const rendered = formatTranscript(lines) || '_No speech captured._'
  const updated = tail ? `${head}${rendered}\n\n${tail}` : `${head}${rendered}\n`

  try {
    await writeSaved(fullPath, updated, wasEncrypted)
  } catch {
    return { ok: false, error: 'Could not save the updated transcript.' }
  }
  return { ok: true }
}

/**
 * MQA-092 — record that this meeting's recap was pushed to the CRM, durably.
 *
 * Review holds a session-scoped Set of accepted payloads, which stops the in-session re-arm (leave for
 * History, open another meeting, come back). It cannot survive a relaunch, and the push panel has no
 * other memory: reopen the meeting tomorrow and "Push to CRM" is armed again, sending a byte-identical
 * `{title, date, summary}` the receiving tool has nothing to dedupe on. One duplicate CRM record, and
 * it is outbound — the user's colleagues see it, not just the user.
 *
 * Stores the payload FINGERPRINT rather than a timestamp, matching the session Set's own key: an edited
 * recap is a genuinely different record and must re-arm the chip, which a bare `crmPushedAt: <date>`
 * could not express. Frontmatter, via the exact mechanism (and guards) `setMeetingConfidential` uses —
 * basename-constrained, encryption preserved as found, only the frontmatter block rewritten.
 */
export async function setMeetingCrmPushed(
  settings: Settings,
  file: string,
  key: string
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  // The fingerprint is written into a YAML scalar, so it must not be able to carry a newline or a colon
  // into the frontmatter block. Review generates it as a base-36 hash; anything else is refused rather
  // than escaped, because the only caller has no reason to send another shape.
  if (!/^[a-z0-9]{1,32}$/.test(key)) return { ok: false, error: 'Invalid CRM push key.' }

  const fullPath = join(folder, safeName)
  const read = await readMeetingText(folder, safeName)
  if (!read.ok) return read
  const { text, encrypted: wasEncrypted } = read

  const fmMatch = text.match(/^---\n[\s\S]*?\n---/)
  if (!fmMatch) return { ok: false, error: 'Not a meeting transcript.' }
  const newFmBlock = /^crm_pushed:\s*.*$/m.test(fmMatch[0])
    ? fmMatch[0].replace(/^crm_pushed:\s*.*$/m, `crm_pushed: ${key}`)
    : fmMatch[0].replace(/\n---$/, `\ncrm_pushed: ${key}\n---`)
  if (newFmBlock === fmMatch[0]) return { ok: true } // already recorded against this exact payload
  const updated = text.slice(0, fmMatch.index!) + newFmBlock + text.slice(fmMatch.index! + fmMatch[0].length)

  try {
    await writeSaved(fullPath, updated, wasEncrypted)
  } catch {
    return { ok: false, error: 'Could not record the CRM push.' }
  }
  return { ok: true }
}

/**
 * Task MI-5 — flag/unflag a saved meeting as confidential (frontmatter `confidential: true`). Read by
 * main/brain/publish.ts's readConfidentialMeetings: a confidential meeting is excluded from every
 * published wiki surface (note card, entity timelines/current-facts, indexes). Rewrites only the
 * frontmatter block in place — the H1, notes, and full transcript are untouched. Same basename guard,
 * and same "preserve encryption exactly as found" convention, as renameMeeting/updateMeetingRecap.
 */
export async function setMeetingConfidential(
  settings: Settings,
  file: string,
  confidential: boolean
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }

  const fullPath = join(folder, safeName)
  const read = await readMeetingText(folder, safeName)
  if (!read.ok) return read
  const { text, encrypted: wasEncrypted } = read

  const fmMatch = text.match(/^---\n[\s\S]*?\n---/)
  if (!fmMatch) return { ok: false, error: 'Not a meeting transcript.' }
  const hasFlag = /^confidential:\s*.*$/m.test(fmMatch[0])
  let newFmBlock: string
  if (confidential) {
    newFmBlock = hasFlag
      ? fmMatch[0].replace(/^confidential:\s*.*$/m, 'confidential: true')
      : fmMatch[0].replace(/\n---$/, '\nconfidential: true\n---')
  } else {
    // Unflagging removes the line entirely (absence = not confidential, same as a meeting that never
    // had the flag) rather than writing `confidential: false` — one canonical "no flag present" shape.
    newFmBlock = fmMatch[0].replace(/^confidential:\s*.*\r?\n/m, '')
  }
  if (newFmBlock === fmMatch[0] && confidential === hasFlag) return { ok: true } // already in the requested state
  const updated = text.slice(0, fmMatch.index!) + newFmBlock + text.slice(fmMatch.index! + fmMatch[0].length)

  try {
    await writeSaved(fullPath, updated, wasEncrypted)
  } catch {
    return { ok: false, error: 'Could not save the confidential flag.' }
  }
  return { ok: true }
}

/**
 * Disk-backed confidential check for MCP push (Wave 4 defense-in-depth). The renderer already gates
 * on its local flag, but a buggy/compromised UI could omit `args.confidential` — main must re-read
 * frontmatter. Unreadable / undecryptable / missing frontmatter fails CLOSED (same as publish MQA-077):
 * treat as confidential so nothing leaves the device.
 */
export async function isMeetingConfidentialOnDisk(settings: Settings, file: string): Promise<boolean> {
  const safeName = basename(file)
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return true
  }
  const folder = resolveMeetingsFolder(settings)
  const read = await storageAt(folder).read(safeName)
  if (read.status !== 'ok') return true // missing / unreadable — fail closed
  const text = decodeSaved(read.bytes)
  if (!text) return true
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return true
  const m = fmMatch[1].match(/^confidential:\s*(.*)\s*$/m)
  return !!m && /^"?true"?$/i.test(m[1].trim())
}

// Every file Métis itself writes into the meetings folder carries one of these frontmatter types (see
// saveMeeting / saveNote / saveDraftTranscript in transcripts.ts). Used as the ownership check for a
// file whose NAME no longer matches Métis's own shape (a transcript the user renamed by hand), so an
// erasure request still erases it.
const OWNED_FRONTMATTER_TYPES = new Set(['meeting-transcript', 'meeting-summary', 'meeting-transcript-draft', 'note'])

/**
 * Tri-state ownership verdict for a file in the meetings folder. The meetings folder is an arbitrary
 * user-chosen directory (Settings → Change folder), so the wipe below cannot delete by `.md` extension
 * alone: it would take the user's unrelated markdown with it, permanently, with no backup and no undo.
 * Filename shape first (the cheap decisive signal sweepExpiredMeetings already trusts), then the
 * frontmatter type, then the encrypted envelope — a save this device can't decrypt is still ours, and
 * must still go. A THROWN read is UNREADABLE, never `false`: "could not read it right now" is not the
 * same verdict as "confirmed not ours" — collapsing them lets a real, transiently-locked meeting be
 * silently skipped by an erasure request that then reports success (MQA-103). Mirrors the exact
 * tri-state discipline readMeetingUncached's UNREADABLE sentinel already establishes in history-read.ts.
 */
async function isOwnedMeetingFile(folder: string, file: string): Promise<boolean | typeof UNREADABLE> {
  if (DRAFT_FILENAME.test(file) || FILENAME_TIMESTAMP.test(file)) return true
  const raw = await storageAt(folder).read(file)
  if (raw.status !== 'ok') {
    // A THROWN read is a transient "can't read it right now" (an EBUSY/EPERM AV/EDR or OneDrive
    // upload-hash lock, or an unhydrated Files-On-Demand placeholder — routine on this folder, see
    // transcripts.ts), NOT "not a meeting file". Report UNREADABLE so deleteAllMeetings surfaces it as a
    // FAILURE rather than silently folding a possibly-owned (e.g. hand-renamed) transcript into `skipped`.
    return UNREADABLE
  }
  try {
    const text = decodeSaved(raw.bytes)
    if (!text) return isEncryptedBytes(raw.bytes)
    return OWNED_FRONTMATTER_TYPES.has(frontmatter(text).type)
  } catch {
    return false // decoded but unparseable — never guess, skip rather than risk deleting the wrong file
  }
}

/**
 * Delete every saved meeting + the index — a genuine "delete all my Métis data" action, for a
 * GDPR/CCPA erasure request or a full account wipe. The caller (index.ts) is responsible for also
 * purging the knowledge graph (purgeGraphArtifacts) and prompting for confirmation first; this
 * function does the actual file removal only. Best-effort per file — one failure doesn't abort the
 * rest, so a partial wipe still removes everything it can.
 *
 * Only Métis's own files are touched (isOwnedMeetingFile); anything else the user keeps in that folder
 * is returned in `skipped` instead of being unlinked, so what the confirmation counted and what the
 * wipe removes can never diverge.
 */
export async function deleteAllMeetings(): Promise<{
  ok: boolean
  deleted: number
  failed: string[]
  skipped: string[]
}> {
  const folder = resolveMeetingsFolder(getSettings())
  const files = await meetingFiles(folder)
  let deleted = 0
  const failed: string[] = []
  const skipped: string[] = []
  for (const file of files) {
    const owned = await isOwnedMeetingFile(folder, file)
    if (owned === UNREADABLE) {
      // Could not read the file to decide ownership (a transient lock or an unhydrated OneDrive
      // placeholder). Count it as FAILED, not `skipped`: a real meeting — especially a hand-renamed one
      // whose filename no longer identifies it — could be left un-erased, and an erasure request must
      // never report success while a transcript it was asked to delete is still on disk (MQA-103). This
      // flips `ok` false so the renderer's error path fires and the user can retry, instead of the wipe
      // silently folding it into the same bucket as their own unrelated markdown.
      failed.push(file)
      continue
    }
    if (!owned) {
      skipped.push(file)
      continue
    }
    try {
      await removeMeetingFile(folder, file)
      deleted++
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(file)
    }
  }
  try {
    await removeMeetingFile(folder, 'index.md') // recreated fresh (header-only) on the next save
  } catch {
    /* best-effort — a missing/unwritable index doesn't fail the overall wipe */
  }
  return { ok: failed.length === 0, deleted, failed, skipped }
}

// Filenames are always `YYYY-MM-DD_HHMMSS-<slug>.md` (see transcripts.ts) — parsed here rather than
// trusting file mtime, since mtime changes on copy/sync (this folder is often OneDrive-synced) and
// would silently corrupt age-based retention.
const FILENAME_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})-/

/**
 * Auto-delete meetings older than `retentionDays` (storage-limitation control for recorded third-party
 * speech). `retentionDays <= 0` means retention is off — keep everything, the historical default. Swept
 * once per app launch (see index.ts). Reuses deleteMeeting per file so index.md stays row-accurate,
 * unlike the wholesale deleteAllMeetings wipe.
 */
export async function sweepExpiredMeetings(retentionDays: number): Promise<{ deleted: number }> {
  if (!retentionDays || retentionDays <= 0) return { deleted: 0 }
  const folder = resolveMeetingsFolder(getSettings())
  const files = await meetingFiles(folder)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let deleted = 0
  for (const file of files) {
    const m = file.match(FILENAME_TIMESTAMP)
    if (!m) continue // unrecognized filename shape — never guess an age, skip rather than risk deleting the wrong file
    const [, y, mo, d, h, mi, s] = m
    const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime()
    if (!Number.isFinite(t) || t >= cutoff) continue
    const r = await deleteMeeting(file)
    if (r.ok) {
      deleted++
      // MQA-230: same provider-free excise the interactive delete performs — the expired meeting's own
      // extraction JSON + ledger row must not wait for a source refresh that needs a usable provider.
      await exciseDeletedMeeting(getSettings(), file).catch(() => {
        /* best-effort — the sweep's caller already requests the source refresh that re-derives */
      })
    }
  }
  return { deleted }
}
