import { sweepExpired, type SweepDeps } from './meeting-retention'
import { join, basename, resolve } from 'node:path'
import { safeMeetingBasename } from './meeting-path'
import {
  parse,
  readMeetingFields as frontmatter,
  recapSectionEndIndex,
  recapSectionEndRe,
  serialize,
  setMeetingField
} from './features/meetings/meeting-document'
import {
  resolveMeetingsFolder,
  decodeSavedMeetingAsync,
  isEncryptedBytes,
  writeSaved,
  DEBRIEF_HEADING
} from './transcripts'
import {
  decodeStoredMeetingSpeechAsync,
  getMeetingSpeechReadLimitBytes,
  renderMeetingTranscriptAsync,
  rewriteStoredSpeechTranscriptAsync
} from './features/meetings/meeting-speech'
import {
  meetingSpeechPrefix,
  rewriteMeetingSpeechRecap,
  refuseReservedSpeechProse
} from './features/meetings/speech-provenance'
import {
  PUSH_KEY_RE,
  nextStepsMarkerValue,
  parseKeyList,
  recapBodyOf,
  recapEditedAfterWrite
} from './features/meetings/meeting-markers'
import { storageAt } from './infra/storage/meetings-storage'
import { withMeetingMutation } from './infra/storage/meeting-mutation-lane'
import { writeWithAdmission } from './infra/storage/write-with-admission'
import type { HydrationProgress, ReadOptions } from './infra/storage/gateway'
import { UNREADABLE, isMeetingDocumentType, meetingFiles, readMeetings } from './history-read'
import { isMeetingConfidentialOnDisk, isOwnedMeetingFile } from './meeting-privacy'
import { editMeetingIndex, removeMeetingFile } from './meeting-files'
import { getSettings } from './store'
import { deleteMemoryForLocalMeeting } from './memory-server/meeting-deletion'
import { readLegacyTranscript } from './features/meetings/legacy-transcript'
import { measuredDurationMs } from '@shared/meeting-duration'
import { readRecapStatus, recapStatusValidationError, type RecapStatus } from '@shared/recap-status'
import {
  PUSH_MARKER_FIELDS,
  type PushMarkerField,
  type RecallReadResult,
  type Settings,
  type TranscriptLine
} from '@shared/ipc'
import type { RecallHydration } from '@shared/recall-hydration'

// Independent meeting-history backend (own implementation, no third-party source): reading one saved
// meeting back, editing it, and deleting it. History's list and search read path lives in history-read.ts.
// Reaches the meetings folder only through the storage gateway and meeting-files.ts, never node:fs.
export { listMeetings, searchMeetings, searchMeetingsLatest, type HistoryRow } from './history-read'
export { isMeetingConfidentialOnDisk } from './meeting-privacy'

async function readMeetingBytes(
  folder: string,
  file: string
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const maxBytes = getMeetingSpeechReadLimitBytes()
  const read = await storageAt(folder).read(file, { ...(maxBytes ? { maxBytes } : {}) })
  if (read.status === 'missing') return { ok: false, error: 'Meeting file not found.' }
  if (read.status !== 'ok') return { ok: false, error: 'Could not read the meeting file.' }
  return { ok: true, bytes: read.bytes }
}

async function readMeetingText(
  folder: string,
  file: string
): Promise<{ ok: true; text: string; encrypted: boolean } | { ok: false; error: string }> {
  const read = await readMeetingBytes(folder, file)
  if (!read.ok) return read
  const decoded = await decodeSavedMeetingAsync(read.bytes, false, join(folder, file))
  const text = decoded.ok ? decoded.text : ''
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }
  return { ok: true, text, encrypted: isEncryptedBytes(read.bytes) }
}

/** Background repair only fills missing notes. Nonempty incomplete notes may contain manual edits;
 *  replacing them requires the user's explicit Retry action, not a background pass. */
export function meetingTextNeedsRecap(text: string): boolean {
  if (!text.trim()) return true
  return recapBodyOf(text, frontmatter(text).type).length === 0
}

export async function listMeetingsNeedingRecap(): Promise<
  Array<{ file: string; mode: string; lines: TranscriptLine[] }>
> {
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

/** True while an explicit open of a file that may need a download, or the fs read its failed download
 *  left running, holds the one hydration slot. */
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
 *     answers HYDRATION_BUSY_MSG unread, taking no content permit.
 *   - A failed download (its deadline passed, the provider failed) keeps the slot until its fs read
 *     settles, so at most one hydrate read holds a content permit and list, search and local opens
 *     always keep the rest.
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
  const fileClass = safeName
    ? (await storageAt(resolveMeetingsFolder(getSettings())).classify([safeName])).get(safeName)
    : undefined
  if (!fileClass || fileClass.status === 'ok' || fileClass.status === 'missing') return open({ hydrate: false })
  if (hydrating) return { ok: false, error: HYDRATION_BUSY_MSG }
  hydrating = true
  let progress = null as HydrationProgress | null
  try {
    const result = await open({
      hydrate: true,
      onProgress: (p) => {
        progress = p
        if (p.state === 'hydrating') report({ file, state: 'hydrating' })
      }
    })
    if (!progress) return result
    if (progress.state === 'done') {
      report({ file, state: 'done' })
      return result
    }
    report({ file, state: 'failed', error: HYDRATION_FAILED_MSG })
    return { ok: false, error: HYDRATION_FAILED_MSG }
  } finally {
    if (progress?.state === 'failed') void progress.settled.then(() => (hydrating = false))
    else hydrating = false
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
): Promise<RecallReadResult & { speechProvenance?: 'valid' | 'unavailable' | 'absent' }> {
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
  if (fileClass && 'isRegular' in fileClass && !fileClass.isRegular)
    return { ok: false, error: 'Could not read the meeting file.' }
  const maxBytes = getMeetingSpeechReadLimitBytes()
  let read = await gateway.read(safeName, { ...(maxBytes ? { maxBytes } : {}) })
  // An explicit open (`hydrate`) is the one place a cloud-only file is hydrated: this one file, under a
  // content permit, reporting progress. Listing, search and background passes never do.
  if (hydrate && (read.status === 'dataless' || read.status === 'unknown'))
    read = await gateway.read(safeName, { hydrate: true, onProgress, ...(maxBytes ? { maxBytes } : {}) })
  if (read.status === 'missing') return { ok: false, error: 'Meeting file not found.' }
  if (read.status !== 'ok') {
    return { ok: false, error: 'Could not read the meeting file.' }
  }
  const decoded = await decodeSavedMeetingAsync(read.bytes, false, join(folder, safeName))
  if (!decoded.ok) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }
  const completeText = decoded.text
  const speech = await decodeStoredMeetingSpeechAsync(completeText)
  if (!speech.ok) return { ok: false, error: 'Meeting text could not be projected safely.' }
  const text = speech.publicMarkdown
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
  let recapText = text
  try {
    if (speech.status === 'valid') recapText = meetingSpeechPrefix(completeText) ?? text
  } catch {
    return { ok: false, error: 'Meeting text could not be projected safely.' }
  }
  let recap = ''
  const startMatch = recapText.match(/^## Notes & follow-ups[\r\n]+/m)
  if (startMatch) {
    const afterStart = recapText.slice(startMatch.index! + startMatch[0].length)
    const endIdx = recapSectionEndIndex(afterStart, fm.type)
    recap = (endIdx === -1 ? afterStart : afterStart.slice(0, endIdx)).trim()
  }

  const lines = speech.status === 'valid' ? speech.lines : readLegacyTranscript(text, startedAt)

  return {
    ok: true,
    title: fm.title || safeName.replace(/\.md$/, ''),
    mode: fm.mode || 'general',
    startedAt,
    durationMs: fm.duration_ms ? measuredDurationMs(Number(fm.duration_ms)) : undefined,
    recap,
    recapStatus: readRecapStatus(fm.recap_status),
    lines: fm.type === 'meeting-summary' ? [] : lines,
    speechProvenance: speech.status,
    confidential: fm.confidential === 'true',
    ...(fm.status === 'recovered' ? { recovered: true } : {}),
    // MQA-092 — the CRM payload fingerprint of the last push that this meeting's CRM connection
    // accepted, so re-opening it after a relaunch does not re-arm "Push to CRM" and file a duplicate.
    crmPushedKey: fm.crm_pushed || undefined,
    // Q07 — the same durable push memory for ClickUp and "Book next steps", and the hand-edited-notes flag.
    clickupPushedKey: fm.clickup_pushed || undefined,
    ...(fm.next_steps_pushed ? { nextStepsPushedKeys: parseKeyList(fm.next_steps_pushed) } : {}),
    ...(fm.recap_edited === 'true' ? { recapEdited: true } : {})
  }
}

/**
 * Saved-meeting read-modify-write is serialised per file (meeting-mutation-lane.ts): two writers on one meeting (a
 * speaker backfill and a recap save, a flag and a rename) can no longer read the same bytes and drop each other's
 * edit. The wrapped writers never call one another, so the non-reentrant lock cannot deadlock.
 */
function serialisedByMeeting<A extends unknown[], R extends { ok: boolean }>(
  fileOf: (settings: Settings, ...args: A) => string,
  write: (settings: Settings, ...args: A) => Promise<R>
): (settings: Settings, ...args: A) => Promise<R> {
  return (settings, ...args) => {
    const safeName = safeMeetingBasename(fileOf(settings, ...args))
    if (!safeName) return write(settings, ...args) // answers its own "Invalid meeting file name."
    return withMeetingMutation(join(resolveMeetingsFolder(settings), safeName), () => write(settings, ...args))
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
  return deleteMeetingInFolder(folder, safeName)
}

/** Delete a receipt-verified absolute path in the folder captured when it was saved. */
export async function deleteMeetingAtPath(settings: Settings, path: string): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(path)
  if (!safeName || resolve(path) !== resolve(join(folder, safeName))) {
    return { ok: false, error: 'Meeting path does not match its saved folder.' }
  }
  return deleteMeetingInFolder(folder, safeName)
}

function deleteMeetingInFolder(folder: string, safeName: string): Promise<{ ok: boolean; error?: string }> {
  return withMeetingMutation(join(folder, safeName), () => deleteMeetingUnlocked(folder, safeName))
}

async function deleteMeetingUnlocked(folder: string, safeName: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await removeMeetingFile(folder, safeName)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not delete meeting file.' }
  }
  // G59: main's configured server adapter receives the source tombstone only after the local delete succeeds.
  // With D-17 unprovisioned the adapter reports unavailable and the local history deletion remains usable.
  await deleteMemoryForLocalMeeting(safeName)
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
async function renameMeetingUnlocked(
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
  try {
    refuseReservedSpeechProse(title)
  } catch {
    return { ok: false, error: 'Meeting text contains reserved storage syntax.' }
  }

  const fullPath = join(folder, safeName)
  const read = await readMeetingText(folder, safeName)
  if (!read.ok) return read
  const { text, encrypted: wasEncrypted } = read

  // Replace the frontmatter `title:` value (always written double-quoted — see saveMeeting/saveNote)
  // within the frontmatter block only, so a coincidental "title:"-looking line in the transcript body
  // can never be mistaken for it.
  const doc = parse(text)
  if (!doc) return { ok: false, error: 'Not a meeting transcript.' }
  if (!doc.lines.some((line) => /^title:\s*"(?:[^"\\]|\\.)*"\s*$/.test(line))) {
    return { ok: false, error: 'Could not find a title to rename in this file.' }
  }
  // The codec writes the value verbatim: a title containing `$&`-style sequences (e.g. "Deal $&Co") is
  // never interpreted as a String.replace pattern.
  let updated = serialize(setMeetingField(doc, 'title', `"${yamlSafeRenameTitle(title)}"`))

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
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .slice(0, RECAP_MAX)
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
async function updateMeetingRecapUnlocked(
  settings: Settings,
  file: string,
  newRecap: string,
  recapStatus?: RecapStatus,
  beforeReplace?: () => void
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
  let framed: string | null
  try {
    framed = rewriteMeetingSpeechRecap(text, body)
  } catch {
    return { ok: false, error: 'Could not save your changes.' }
  }
  if (framed !== null) updated = framed
  else {
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
      updated = tail ? `${head}${body}${body ? '\n\n' : ''}${tail}` : `${head}${body}${body ? '\n' : ''}`
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
  }

  const doc = parse(updated)
  if (recapStatus !== undefined && !doc) {
    return { ok: false, error: 'Could not save the summary status: missing meeting frontmatter.' }
  }
  if (doc) {
    // Q07 (D4-3): the durable "a person wrote these notes" marker. Absent = never hand-edited, the same
    // canonical no-flag shape as `confidential`.
    let next = setMeetingField(doc, 'recap_edited', recapEditedAfterWrite(text, body, recapStatus) ? 'true' : null)
    if (recapStatus !== undefined) next = setMeetingField(next, 'recap_status', recapStatus)
    updated = serialize(next)
  }

  const write = await writeWithAdmission(beforeReplace, (guard) => writeSaved(fullPath, updated, wasEncrypted, guard))
  if (write.kind === 'admission-refused') throw write.error
  if (write.kind === 'write-failed') return { ok: false, error: 'Could not save your changes.' }
  return { ok: true }
}

/**
 * Speaker Intelligence backfill (Phase A) — rewrite ONLY the "## Full transcript" section of a saved
 * meeting with freshly-resolved speaker names (see main/graph-transcript.ts + shared/transcript-align.ts),
 * once a Teams transcript for the same meeting has been matched after the fact. Re-renders `lines`
 * through transcript-format.ts's formatTranscript — the exact shape this module's lineRe (in recallRead)
 * parses back — leaving the frontmatter, the H1/meta line, and any "## Notes & follow-ups" section
 * untouched. Same basename guard + "preserve encryption exactly as found" convention as
 * renameMeeting/updateMeetingRecap/setMeetingConfidential.
 */
async function updateMeetingTranscriptUnlocked(
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

  try {
    const framed = await rewriteStoredSpeechTranscriptAsync(text, lines)
    if (framed !== null) {
      await writeSaved(fullPath, framed, wasEncrypted)
      return { ok: true }
    }
  } catch {
    return { ok: false, error: 'Could not save the updated transcript.' }
  }

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
  const rendered = (await renderMeetingTranscriptAsync(lines)) || '_No speech captured._'
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
 * Q07 (D4-6): generalised over `crm_pushed`, `clickup_pushed` (one fingerprint) and `next_steps_pushed` (a bounded list).
 */
async function setMeetingPushMarkerUnlocked(
  settings: Settings,
  file: string,
  field: PushMarkerField,
  key: string
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  if (!PUSH_MARKER_FIELDS.includes(field)) return { ok: false, error: 'Unknown push marker.' }
  // The fingerprint is written into a YAML scalar, so it must not be able to carry a newline, a colon or (for the
  // next-steps list) a comma into the frontmatter block. Review generates it as a base-36 hash; anything else is
  // refused rather than escaped, because the only caller has no reason to send another shape.
  const label = field === 'crm_pushed' ? 'CRM push' : 'push'
  if (!PUSH_KEY_RE.test(key)) return { ok: false, error: `Invalid ${label} key.` }

  const fullPath = join(folder, safeName)
  const read = await readMeetingText(folder, safeName)
  if (!read.ok) return read
  const { text, encrypted: wasEncrypted } = read

  const doc = parse(text)
  if (!doc) return { ok: false, error: 'Not a meeting transcript.' }
  // `next_steps_pushed` is a bounded list of the tasks that landed; the other two hold one fingerprint.
  const value = field === 'next_steps_pushed' ? nextStepsMarkerValue(frontmatter(text).next_steps_pushed, key) : key
  if (value === null) return { ok: true } // already recorded
  const updated = serialize(setMeetingField(doc, field, value))
  if (updated === text) return { ok: true } // already recorded against this exact payload

  try {
    await writeSaved(fullPath, updated, wasEncrypted)
  } catch {
    return { ok: false, error: `Could not record the ${label}.` }
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
async function setMeetingConfidentialUnlocked(
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

  const doc = parse(text)
  if (!doc) return { ok: false, error: 'Not a meeting transcript.' }
  // Unflagging removes the line entirely (absence = not confidential, same as a meeting that never
  // had the flag) rather than writing `confidential: false` — one canonical "no flag present" shape.
  const updated = serialize(setMeetingField(doc, 'confidential', confidential ? 'true' : null))
  if (updated === text) return { ok: true } // already in the requested state

  try {
    await writeSaved(fullPath, updated, wasEncrypted)
  } catch {
    return { ok: false, error: 'Could not save the confidential flag.' }
  }
  return { ok: true }
}

export const renameMeeting = serialisedByMeeting(
  (_settings, file: string, _newTitle: string) => file,
  renameMeetingUnlocked
)

export const updateMeetingRecap = serialisedByMeeting(
  (_settings, file: string, _newRecap: string, _recapStatus?: RecapStatus, _beforeReplace?: () => void) => file,
  updateMeetingRecapUnlocked
)

export const updateMeetingTranscript = serialisedByMeeting(
  (_settings, file: string, _lines: TranscriptLine[]) => file,
  updateMeetingTranscriptUnlocked
)

export const setMeetingPushMarker = serialisedByMeeting(
  (_settings, file: string, _field: PushMarkerField, _key: string) => file,
  setMeetingPushMarkerUnlocked
)

/** The CRM marker, under its original name for the existing handler and tests. */
export const setMeetingCrmPushed = (settings: Settings, file: string, key: string) =>
  setMeetingPushMarker(settings, file, 'crm_pushed', key)

export const setMeetingConfidential = serialisedByMeeting(
  (_settings, file: string, _confidential: boolean) => file,
  setMeetingConfidentialUnlocked
)

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
      // Keep whole-account deletion on the same per-source tombstone path as one-at-a-time deletion.
      await deleteMemoryForLocalMeeting(file)
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

export { countExpiredMeetings } from './meeting-retention'

/** Auto-delete meetings past the retention window; see meeting-retention.ts. Reuses deleteMeeting per file. */
export function sweepExpiredMeetings(retentionDays: number, deps: SweepDeps = {}): Promise<{ deleted: number }> {
  return sweepExpired(retentionDays, deleteMeeting, deps)
}
