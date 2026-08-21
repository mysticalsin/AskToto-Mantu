import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { exciseDeletedMeeting } from './brain/ingest'
import { join, basename } from 'node:path'
import { resolveMeetingsFolder, decodeSaved, isEncryptedFile, writeSaved, formatTranscript, DEBRIEF_HEADING } from './transcripts'
import { getSettings } from './store'
import { detectLanguage } from '@shared/lang-id'
import type { MeetingSummary, RecallHit, RecallReadResult, Settings, TranscriptLine } from '@shared/ipc'

// Independent meeting-history backend (own implementation, no third-party source). Reads the saved
// transcript markdown files and provides list + keyword search so managers (and Dust agents) can
// recall past meetings. Reads are ASYNC (off the main-process event loop) and each file is read once.

// A well-formed double-quoted YAML scalar, capturing its body: the shape every title/mode value is
// written in (see saveMeeting's frontmatter block in transcripts.ts, and renameMeeting below).
const QUOTED_SCALAR = /^"((?:[^"\\]|\\.)*)"\s*$/

function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i)
    if (!kv) continue
    // Undo the YAML escaping the writers apply (`\` → `\\`, `"` → `\"` — transcripts.ts's yamlSafeTitle
    // and yamlSafeRenameTitle below): this is the only reader, so without the inverse the escapes reach
    // History verbatim AND the rename box, which is pre-filled from this same value, re-escapes what was
    // already escaped on every commit — the backslashes double per rename, unbounded. Anything that is
    // not a well-formed quoted scalar (the `[a, b]` flow lists this frontmatter also carries, or a plain
    // unquoted value like `date:`) keeps the original outer-character strip untouched.
    const quoted = kv[2].match(QUOTED_SCALAR)
    out[kv[1]] = quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : kv[2].replace(/^["[]|["\]]$/g, '').trim()
  }
  return out
}

async function meetingFiles(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md' && e.name !== 'index.md')
      .map((e) => e.name)
  } catch {
    return []
  }
}

interface Read {
  sum: MeetingSummary
  text: string
}

/** A MeetingSummary stub for a REAL encrypted meeting that failed to decrypt on this device (foreign
 *  keychain — see transcripts.ts's UNDECRYPTABLE_MSG), kept in list/search results instead of dropped,
 *  with `locked: true` as the affordance signal. NOTE: `locked` is not yet declared on the shared
 *  MeetingSummary type (src/shared/ipc.ts, outside this file's scope) — it still flows through at
 *  runtime (see lockedStub/readMeetingUncached below) since it's a real own property on the object, not
 *  a type-only annotation. A renderer that wants to show a lock icon needs a `'locked' in m` runtime
 *  check today, or `locked?: boolean` added to MeetingSummary itself as a follow-up. */
interface LockedMeetingSummary extends MeetingSummary {
  locked: true
}

// Métis's own filenames are always `YYYY-MM-DD_HHMMSS-<slug>.md` (see stamp()/slug() in transcripts.ts).
// These two patterns are the only signal left to tell a real meeting from a non-meeting file once
// decryption has failed — its `type:` frontmatter can't be read — so lockedStub() below uses them to
// keep genuinely non-meeting files dropped, same as the decryptable path already does via fm.type.
const DRAFT_FILENAME = /^\.autosave-draft-/ // saveDraftTranscript's in-progress autosave — never a real meeting
const NOTE_FILENAME = /^\d{4}-\d{2}-\d{2}_\d{6}-note-/ // saveNote always inserts this literal segment
// Deliberately a separate copy of sweepExpiredMeetings' own FILENAME_TIMESTAMP regex further down this
// file, rather than hoisting one shared const above both — keeps this change scoped to the read path
// without reordering unrelated retention-sweep code.
const STUB_FILENAME_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})-/

/** Best-effort display stub for a real meeting file we can't render right now, so it stays visible
 *  (instead of silently vanishing) with a lock affordance. Returns null for the one case a filename
 *  alone can still rule out as NOT a meeting: a draft autosave or a quick note (see DRAFT_FILENAME/
 *  NOTE_FILENAME). `label` names the reason in the title — undecryptable on this device ("Locked", the
 *  default) vs. temporarily unreadable ("Unavailable", see UNREADABLE); both need the same visible row. */
function lockedStub(file: string, label = 'Locked'): LockedMeetingSummary | null {
  if (DRAFT_FILENAME.test(file) || NOTE_FILENAME.test(file)) return null
  const m = file.match(STUB_FILENAME_TIMESTAMP)
  const date = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) : null
  const slugPart = file.replace(/\.md$/, '').replace(STUB_FILENAME_TIMESTAMP, '').replace(/-/g, ' ').trim()
  return {
    file,
    title: `${label} — ${slugPart || file}`,
    date: date && !isNaN(date.getTime()) ? date.toISOString() : '',
    mode: 'general',
    durationMin: 0,
    participants: [],
    locked: true
  }
}

// Per-file read cache validated by (mtimeMs, size) on every use. List and search previously re-read
// AND re-decrypted every meeting file on every call — per keystroke while searching — the one path
// that degrades linearly as the library grows, with decryption work on the main process. A stat()
// replaces the full read+decode when the file is unchanged; any mtime/size change re-reads, and a
// vanished file drops its entry. Saved meetings are immutable-after-write, so hits are the norm.
// Null results (non-meeting or undecryptable files) are cached too, so they stop costing reads — but
// a file that could not be READ at all is deliberately never cached (see UNREADABLE below).
const readCache = new Map<string, { mtimeMs: number; size: number; read: Read | null }>()
// Safety valve: the cache is bounded by the meetings folder size in practice, but never let a
// pathological folder (or repeated folder switches) grow it without limit.
const READ_CACHE_MAX = 2000

/** Sentinel for "this file could not be READ at all" — an unhydrated OneDrive Files-On-Demand
 *  placeholder while offline, or an AV/EDR share-lock (the same transient conditions writeSaved
 *  already retries around, see transcripts.ts). Kept distinct from `null` ("not a meeting file"),
 *  which is a permanent verdict and safe to cache. A thrown read is neither: stat() still succeeds on
 *  a placeholder, and hydration changes neither mtimeMs nor size, so caching that failure would key it
 *  to a value nothing invalidates and the meeting would stay invisible until the app restarts. */
const UNREADABLE = Symbol('unreadable')

/** Read + decode one file (async), parse its frontmatter. Null if it isn't a meeting transcript.
 *  Served from readCache when the file is unchanged since the last read. */
async function readMeeting(folder: string, file: string): Promise<Read | null> {
  const path = join(folder, file)
  let mtimeMs: number
  let size: number
  try {
    const st = await stat(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    readCache.delete(path)
    return null
  }
  const hit = readCache.get(path)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.read
  const read = await readMeetingUncached(path, file)
  if (read === UNREADABLE) {
    // Drop any stale entry and cache nothing, so the next list/search retries the read instead of
    // serving a transient failure the user has no way to invalidate. The meeting keeps its row as a
    // stub rather than disappearing from History and search with no signal at all.
    readCache.delete(path)
    const stub = lockedStub(file, 'Unavailable')
    return stub ? { text: '', sum: stub } : null
  }
  if (readCache.size >= READ_CACHE_MAX) readCache.clear()
  readCache.set(path, { mtimeMs, size, read })
  return read
}

async function readMeetingUncached(path: string, file: string): Promise<Read | null | typeof UNREADABLE> {
  let raw: Buffer
  try {
    raw = await readFile(path)
  } catch {
    // A THROWN read means "can't read it right now", which is not the same verdict as "not a meeting
    // file" — the caller must not cache it, and must not drop the meeting. Split out from the catch
    // below so only the read itself can produce it: decodeSaved never throws (see transcripts.ts).
    return UNREADABLE
  }
  try {
    const text = decodeSaved(raw)
    if (!text) {
      // decodeSaved returns '' both for "not a meeting file" and for a REAL meeting encrypted at rest
      // that this device's keychain can't decrypt (a different machine/user — see transcripts.ts's
      // UNDECRYPTABLE_MSG). Only the latter should still show up, as a locked stub, so it never just
      // vanishes; a file that isn't one of Métis's encrypted saves at all stays dropped.
      if (!isEncryptedFile(path)) return null
      const stub = lockedStub(file)
      return stub ? { text: '', sum: stub } : null
    }
    const fm = frontmatter(text)
    if (fm.type && fm.type !== 'meeting-transcript') return null
    const topics = (fm.topics || '').split(',').map((s) => s.trim()).filter(Boolean)
    return {
      text,
      sum: {
        file,
        title: fm.title || file.replace(/\.md$/, ''),
        date: fm.date || '',
        mode: fm.mode || 'general',
        durationMin: Number(fm.duration_min || 0),
        participants: (fm.participants || '').split(',').map((s) => s.trim()).filter(Boolean),
        ...(topics.length ? { topics } : {}),
        ...(fm.confidential === 'true' ? { confidential: true } : {})
      }
    }
  } catch {
    return null
  }
}

/** Newest-first list of saved meetings. */
export async function listMeetings(): Promise<MeetingSummary[]> {
  const folder = resolveMeetingsFolder(getSettings())
  const read = await Promise.all((await meetingFiles(folder)).map((f) => readMeeting(folder, f)))
  return read
    .filter((r): r is Read => r !== null)
    .map((r) => r.sum)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

/**
 * Read a saved meeting file back into memory for "Resume session".
 * Parses frontmatter (title, mode, date → startedAt), the recap section, and the transcript lines.
 * Constrained to the meetings folder (same basename guard as recallOpen in index.ts — no traversal).
 */
export async function recallRead(file: string): Promise<RecallReadResult> {
  const folder = resolveMeetingsFolder(getSettings())
  // basename blocks path traversal (mirrors the recallOpen guard in index.ts).
  const safeName = basename(file)
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  const fullPath = join(folder, safeName)
  let text: string
  try {
    text = decodeSaved(await readFile(fullPath))
  } catch {
    return { ok: false, error: 'Could not read the meeting file.' }
  }
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }

  const fm = frontmatter(text)

  // Recover startedAt from the frontmatter `date` field (ISO string written by saveMeeting).
  let startedAt: number | undefined
  if (fm.date) {
    const ms = Date.parse(fm.date)
    if (!isNaN(ms)) startedAt = ms
  }

  // Extract the recap section (## Notes & follow-ups … up to ## Full transcript, saveMeeting's only
  // other top-level section). The recap markdown itself starts with its own "## Overview:" heading
  // (RECAP_PROMPT's format), so stopping at any "## " would match that nested heading immediately and
  // capture nothing — the end must target the real sibling section specifically. Done as a plain slice +
  // a second, END-only regex rather than one combined lookahead: with the /m flag (needed for the "^"
  // start anchors), "$" matches before ANY newline, not just end-of-string, so a "\s*$" fallback inside
  // the same lookahead stops at the end of the first line too — the exact bug this replaces.
  let recap = ''
  const startMatch = text.match(/^## Notes & follow-ups[\r\n]+/m)
  if (startMatch) {
    const afterStart = text.slice(startMatch.index! + startMatch[0].length)
    const endIdx = afterStart.search(/^## Full transcript/m)
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
    const lineRe = /^\*\*\[(\d{2}):(\d{2}):(\d{2})\] (Them|You|Speaker)(?: \(([^)]*)\))?:\*\* (.+)$/gm
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
      if (name) line.name = name.trim()
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
    recap,
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
  const safeName = basename(file) // block traversal
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  const fullPath = join(folder, safeName)
  try {
    await unlink(fullPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not delete meeting file.' }
  }
  // Remove the matching row from index.md (best-effort — a missing / unreadable index is not fatal).
  try {
    const indexPath = join(folder, 'index.md')
    const raw = await readFile(indexPath, 'utf8')
    // Each row ends with `| [open](safeName) |` — match the exact filename in the link cell.
    const escaped = safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const filtered = raw
      .split('\n')
      .filter((line) => !new RegExp(`\\(${escaped}\\)`).test(line))
      .join('\n')
    if (filtered !== raw) await writeFile(indexPath, filtered, 'utf8')
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
  const safeName = basename(file) // block traversal
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  const title = sanitizeRenameTitle(newTitle)
  if (!title) return { ok: false, error: 'Enter a title.' }

  const fullPath = join(folder, safeName)
  let raw: Buffer
  try {
    raw = await readFile(fullPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not read the meeting file.' }
  }

  const wasEncrypted = isEncryptedFile(fullPath)
  const text = decodeSaved(raw)
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }

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
      const indexPath = join(folder, 'index.md')
      const rawIndex = await readFile(indexPath, 'utf8')
      const marker = `[open](${safeName})`
      const safeTitleCell = title.replace(/\|/g, '/')
      let changed = false
      const updatedIndex = rawIndex
        .split('\n')
        .map((line) => {
          if (!line.includes(marker)) return line
          const cells = line.split('|')
          if (cells.length < 6) return line
          cells[2] = ` ${safeTitleCell} `
          changed = true
          return cells.join('|')
        })
        .join('\n')
      if (changed) await writeFile(indexPath, updatedIndex, 'utf8')
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
 * parses, bounded before the sibling "## Full transcript" heading — with the edited markdown, leaving the
 * frontmatter, the H1, the meta line, and the entire "## Full transcript" section untouched. The FILE is
 * never renamed. If the meeting was saved with an empty recap (saveMeeting omits the heading entirely in
 * that case), the section is INSERTED immediately before "## Full transcript" so it parses identically to a
 * normally-saved recap. Same basename guard as renameMeeting/deleteMeeting (no traversal, no index/README).
 *
 * Encryption is preserved exactly as found: isEncryptedFile (not the live `encryptTranscripts` toggle, which
 * may differ from when this file was saved) decides decrypt-edit-re-encrypt vs. edit-plaintext-in-place, so
 * an edited encrypted meeting stays encrypted and still opens. index.md is not touched: it carries only
 * title/date/duration/link, none of which the recap changes.
 */
export async function updateMeetingRecap(
  settings: Settings,
  file: string,
  newRecap: string
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = basename(file) // block traversal
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return { ok: false, error: 'Invalid meeting file name.' }
  }

  const recap = sanitizeRecap(newRecap)
  // Guard the one string that would corrupt the round-trip: recallRead ends the recap at the FIRST line
  // beginning "## Full transcript". If the edited notes contained that heading, re-reading would swallow
  // everything after it into the transcript. Reject rather than silently mangle the user's own text.
  if (/^## Full transcript/m.test(recap)) {
    return { ok: false, error: 'The "## Full transcript" heading is reserved. Please rename it in your notes.' }
  }
  const body = recap.trim()

  const fullPath = join(folder, safeName)
  let raw: Buffer
  try {
    raw = await readFile(fullPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not read the meeting file.' }
  }

  const wasEncrypted = isEncryptedFile(fullPath)
  const text = decodeSaved(raw)
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }

  let updated: string
  const startMatch = text.match(/^## Notes & follow-ups[\r\n]+/m)
  if (startMatch) {
    // Existing section: replace its body only. `head` runs up to and including the heading + the newlines
    // saveMeeting wrote after it; `tail` is the untouched remainder from "## Full transcript" onward (or
    // '' when, defensively, no such section exists). The rebuilt "\n\n" restores the single blank line
    // before the next section so the markdown — and recallRead's slice — stay well-formed.
    const bodyStart = startMatch.index! + startMatch[0].length
    const afterStart = text.slice(bodyStart)
    const endIdx = afterStart.search(/^## Full transcript/m)
    const head = text.slice(0, bodyStart)
    const tail = endIdx === -1 ? '' : afterStart.slice(endIdx)
    updated = tail
      ? `${head}${body}${body ? '\n\n' : ''}${tail}`
      : `${head}${body}${body ? '\n' : ''}`
  } else {
    // No notes section yet (meeting saved with an empty recap). Insert one immediately before the
    // "## Full transcript" heading so recallRead parses it exactly as it would a normally-saved recap.
    const txMatch = text.match(/^## Full transcript/m)
    if (!txMatch) return { ok: false, error: 'This does not look like a meeting file.' }
    if (!body) return { ok: true } // nothing to add and no section to change — a no-op success
    const at = txMatch.index!
    updated = `${text.slice(0, at)}## Notes & follow-ups\n\n${body}\n\n${text.slice(at)}`
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
  const safeName = basename(file) // block traversal
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return { ok: false, error: 'Invalid meeting file name.' }
  }

  const fullPath = join(folder, safeName)
  let raw: Buffer
  try {
    raw = await readFile(fullPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not read the meeting file.' }
  }

  const wasEncrypted = isEncryptedFile(fullPath)
  const text = decodeSaved(raw)
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }

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
  const safeName = basename(file) // block traversal
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return { ok: false, error: 'Invalid meeting file name.' }
  }
  // The fingerprint is written into a YAML scalar, so it must not be able to carry a newline or a colon
  // into the frontmatter block. Review generates it as a base-36 hash; anything else is refused rather
  // than escaped, because the only caller has no reason to send another shape.
  if (!/^[a-z0-9]{1,32}$/.test(key)) return { ok: false, error: 'Invalid CRM push key.' }

  const fullPath = join(folder, safeName)
  let raw: Buffer
  try {
    raw = await readFile(fullPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not read the meeting file.' }
  }

  const wasEncrypted = isEncryptedFile(fullPath)
  const text = decodeSaved(raw)
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }

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
  const safeName = basename(file) // block traversal
  if (!safeName || !safeName.endsWith('.md') || safeName === 'index.md' || safeName === 'README.md') {
    return { ok: false, error: 'Invalid meeting file name.' }
  }

  const fullPath = join(folder, safeName)
  let raw: Buffer
  try {
    raw = await readFile(fullPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: 'Meeting file not found.' }
    return { ok: false, error: 'Could not read the meeting file.' }
  }

  const wasEncrypted = isEncryptedFile(fullPath)
  const text = decodeSaved(raw)
  if (!text) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }

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

// Every file Métis itself writes into the meetings folder carries one of these frontmatter types (see
// saveMeeting / saveNote / saveDraftTranscript in transcripts.ts). Used as the ownership check for a
// file whose NAME no longer matches Métis's own shape (a transcript the user renamed by hand), so an
// erasure request still erases it.
const OWNED_FRONTMATTER_TYPES = new Set(['meeting-transcript', 'meeting-transcript-draft', 'note'])

/**
 * Tri-state ownership verdict for a file in the meetings folder. The meetings folder is an arbitrary
 * user-chosen directory (Settings → Change folder), so the wipe below cannot delete by `.md` extension
 * alone: it would take the user's unrelated markdown with it, permanently, with no backup and no undo.
 * Filename shape first (the cheap decisive signal sweepExpiredMeetings already trusts), then the
 * frontmatter type, then the encrypted envelope — a save this device can't decrypt is still ours, and
 * must still go. A THROWN read is UNREADABLE, never `false`: "could not read it right now" is not the
 * same verdict as "confirmed not ours" — collapsing them lets a real, transiently-locked meeting be
 * silently skipped by an erasure request that then reports success (MQA-103). Mirrors the exact
 * tri-state discipline readMeetingUncached's UNREADABLE sentinel already establishes above.
 */
async function isOwnedMeetingFile(folder: string, file: string): Promise<boolean | typeof UNREADABLE> {
  if (DRAFT_FILENAME.test(file) || FILENAME_TIMESTAMP.test(file)) return true
  const path = join(folder, file)
  let raw: Buffer
  try {
    raw = await readFile(path)
  } catch {
    // A THROWN read is a transient "can't read it right now" (an EBUSY/EPERM AV/EDR or OneDrive
    // upload-hash lock, or an unhydrated Files-On-Demand placeholder — routine on this folder, see
    // transcripts.ts), NOT "not a meeting file". Report UNREADABLE so deleteAllMeetings surfaces it as a
    // FAILURE rather than silently folding a possibly-owned (e.g. hand-renamed) transcript into `skipped`.
    return UNREADABLE
  }
  try {
    const text = decodeSaved(raw)
    if (!text) return isEncryptedFile(path)
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
      await unlink(join(folder, file))
      deleted++
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(file)
    }
  }
  try {
    await unlink(join(folder, 'index.md')) // recreated fresh (header-only) on the next save
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

/** Keyword search across saved meetings; returns scored hits with a snippet. */
export async function searchMeetings(query: string): Promise<RecallHit[]> {
  const folder = resolveMeetingsFolder(getSettings())
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
  if (!terms.length) return []
  const read = await Promise.all((await meetingFiles(folder)).map((f) => readMeeting(folder, f)))
  const hits: RecallHit[] = []
  for (const r of read) {
    if (!r) continue
    const { sum, text } = r
    // Strip the frontmatter block before scoring/snippeting so boilerplate keys (type, source,
    // status, etc.) don't manufacture hits or snippets for terms that never appear in the actual
    // recap/transcript body (mirrors the delimiter the frontmatter() helper already uses).
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
    const lc = body.toLowerCase()
    let score = 0
    for (const t of terms) {
      const inTitle = sum.title.toLowerCase().includes(t) ? 3 : 0
      const count = lc.split(t).length - 1
      score += inTitle + count
    }
    if (score === 0) continue
    // Anchor the snippet on a term that actually occurs in the body, falling back to terms[0] only
    // if none do (a multi-word search whose first word only matched via the title bonus).
    const anchor = terms.find((t) => lc.includes(t)) ?? terms[0]
    const first = lc.indexOf(anchor)
    const start = Math.max(0, first - 60)
    const snippet = body.slice(start, start + 200).replace(/\s+/g, ' ').trim()
    hits.push({ ...sum, snippet, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 25)
}
