import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { resolveMeetingsFolder, decodeSaved } from './transcripts'
import { getSettings } from './store'
import type { MeetingSummary, RecallHit, RecallReadResult, TranscriptLine } from '@shared/ipc'

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
        ...(topics.length ? { topics } : {})
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
  // Format written by saveMeeting: **[HH:MM:SS] Them:** text  or  **[HH:MM:SS] You:** text
  const lines: TranscriptLine[] = []
  const transcriptMatch = text.match(/^## Full transcript[\r\n]+([\s\S]*)$/m)
  if (transcriptMatch) {
    const body = transcriptMatch[1]
    // Use the ISO date from frontmatter to reconstruct absolute timestamps (same calendar day).
    // When startedAt is missing (unparsable/absent date field), fall back to an arbitrary fixed
    // anchor (read time) so every line still gets a real, monotonically increasing timestamp instead
    // of collapsing to 0 — the parsed HH:MM:SS is real elapsed-time data even without a calendar date.
    const baseDate = startedAt ? new Date(startedAt) : new Date()
    const lineRe = /^\*\*\[(\d{2}):(\d{2}):(\d{2})\] (Them|You):\*\* (.+)$/gm
    let m: RegExpExecArray | null
    let prevT: number | undefined = startedAt
    while ((m = lineRe.exec(body)) !== null) {
      const [, hh, mm, ss, speakerLabel, lineText] = m
      const d = new Date(baseDate)
      d.setHours(Number(hh), Number(mm), Number(ss), 0)
      // If the reconstructed time is before the previous line's timestamp (midnight crossing), push
      // to the next day — compares against the previous line rather than startedAt so this still
      // works when startedAt is unavailable.
      if (prevT !== undefined && d.getTime() < prevT) d.setDate(d.getDate() + 1)
      const t = d.getTime()
      prevT = t
      lines.push({
        speaker: speakerLabel === 'Them' ? 'them' : 'you',
        text: lineText.trim(),
        t
      })
    }
  }

  return {
    ok: true,
    title: fm.title || safeName.replace(/\.md$/, ''),
    mode: fm.mode || 'general',
    startedAt,
    recap,
    lines
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

/**
 * Delete every saved meeting + the index — a genuine "delete all my AskToto data" action, for a
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
