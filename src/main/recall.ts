import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { resolveMeetingsFolder, decodeSaved, isEncryptedFile, writeSaved, formatTranscript, DEBRIEF_HEADING } from './transcripts'
import { getSettings } from './store'
import type { MeetingSummary, RecallHit, RecallReadResult, Settings, TranscriptLine } from '@shared/ipc'

// Independent meeting-history backend (own implementation, no third-party source). Reads the saved
// transcript markdown files and provides list + keyword search so managers (and Dust agents) can
// recall past meetings. Reads are ASYNC (off the main-process event loop) and each file is read once.

function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i)
    if (kv) out[kv[1]] = kv[2].replace(/^["[]|["\]]$/g, '').trim()
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

// Per-file read cache validated by (mtimeMs, size) on every use. List and search previously re-read
// AND re-decrypted every meeting file on every call — per keystroke while searching — the one path
// that degrades linearly as the library grows, with decryption work on the main process. A stat()
// replaces the full read+decode when the file is unchanged; any mtime/size change re-reads, and a
// vanished file drops its entry. Saved meetings are immutable-after-write, so hits are the norm.
// Null results (non-meeting or undecryptable files) are cached too, so they stop costing reads.
const readCache = new Map<string, { mtimeMs: number; size: number; read: Read | null }>()
// Safety valve: the cache is bounded by the meetings folder size in practice, but never let a
// pathological folder (or repeated folder switches) grow it without limit.
const READ_CACHE_MAX = 2000

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
  if (readCache.size >= READ_CACHE_MAX) readCache.clear()
  readCache.set(path, { mtimeMs, size, read })
  return read
}

async function readMeetingUncached(path: string, file: string): Promise<Read | null> {
  try {
    const text = decodeSaved(await readFile(path))
    if (!text) return null
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
    let prevT: number | undefined = startedAt
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
    confidential: fm.confidential === 'true'
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

/**
 * Delete every saved meeting + the index — a genuine "delete all my Métis data" action, for a
 * GDPR/CCPA erasure request or a full account wipe. The caller (index.ts) is responsible for also
 * purging the knowledge graph (purgeGraphArtifacts) and prompting for confirmation first; this
 * function does the actual file removal only. Best-effort per file — one failure doesn't abort the
 * rest, so a partial wipe still removes everything it can.
 */
export async function deleteAllMeetings(): Promise<{ ok: boolean; deleted: number; failed: string[] }> {
  const folder = resolveMeetingsFolder(getSettings())
  const files = await meetingFiles(folder)
  let deleted = 0
  const failed: string[] = []
  for (const file of files) {
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
  return { ok: failed.length === 0, deleted, failed }
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
    if (r.ok) deleted++
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
