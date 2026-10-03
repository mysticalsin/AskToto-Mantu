import { app } from 'electron'
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  renameSync
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SaveMeeting, SaveNote, Settings, RecapExport, TranscriptLine } from '@shared/ipc'
import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { lockPathToCurrentUserWin32 } from './win-security'
import { resolveMeetingsFolder } from './infra/storage/paths'
import { safeMeetingBasename } from './meeting-path'
import { refuseIfDemoTagged } from '@shared/demo-guard'
import { recapStatusValidationError } from '@shared/recap-status'
import { measuredDurationMs, meetingDurationMinutes } from '@shared/meeting-duration'
import { classifyAll, storageAt } from './infra/storage/meetings-storage'
import { recordLocalWrite } from './infra/storage/local-writes'
import type { FileClass } from './infra/storage/gateway'
import { decodeSaved, isEncryptedBytes, tryDecodeSaved, writeSaved } from './infra/storage/saved-file'
export {
  decodeSaved,
  decodeSavedResult,
  envelopeKeyKind,
  isEncryptedBytes,
  writeSaved
} from './infra/storage/saved-file'
export type { SavedDecode } from './infra/storage/saved-file'

// Shown in place of a transcript that can't be decrypted on this device (e.g. encrypted under a different
// OS keychain/user — common when an encrypted file is OneDrive-synced to another machine). Beats a dead
// "Open" click or a silent unhandled rejection.
const UNDECRYPTABLE_MSG =
  '# This transcript can\'t be opened here\n\n' +
  'It was encrypted at rest on a different machine or user account, so this device\'s keychain cannot ' +
  'decrypt it. Open it on the machine where it was created, or turn off at-rest encryption in Settings ' +
  'before saving if you need transcripts portable across devices.\n'

/** True if the file on disk is one of Métis's encrypted transcripts. */
export function isEncryptedFile(path: string): boolean {
  try {
    return isEncryptedBytes(readFileSync(path))
  } catch {
    return false
  }
}

/** Read a saved transcript/note (sync), transparently decrypting if it was written encrypted. */
export function readSavedFile(path: string): string {
  return decodeSaved(readFileSync(path))
}

function rewrapRecoveredEnvelope(filePath: string, bytes: Buffer): void {
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 })
    renameSync(tmp, filePath)
    void recordLocalWrite(filePath)
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best-effort cleanup */
    }
  }
}

// Decrypted temp copies are tracked and deleted on quit so an encrypted transcript never leaves a
// permanent cleartext file behind (the name is randomized so it isn't a predictable target either).
const decryptedTemps = new Set<string>()
let tempCleanupHooked = false

/** Decrypt an encrypted transcript to a temp plaintext file so it can be opened in an editor. The file
 *  lives under the per-user temp dir (user-scoped ACL), has a randomized name, and is unlinked on app
 *  quit. Confidentiality: POSIX `mode: 0o600` on the write below (owner-only on macOS/Linux) is a no-op
 *  on Windows, so on win32 we additionally apply an explicit owner-only DACL via lockPathToCurrentUserWin32.
 *
 *  This is an explicit single-file user read (the only caller is recallOpen's "Open" click), so it opts
 *  into Keychain recovery for an old 'S:'-wrapped meeting despite the forced local keystore — see
 *  decryptEnvelopeV2's doc comment. Bulk list/search paths (recall.ts) go through decodeSaved instead and
 *  never set this, so they stay exactly as boot-prompt-free as commit 486227d intended. Given `bytes` (read
 *  through the storage gateway by History's Open, history-actions.ts), the file is never read here. */
export function decryptToTemp(path: string, bytes?: Buffer): string {
  // Read + decrypt defensively: a foreign-keychain file yields the notice instead of throwing and
  // leaving the user with a dead "Open" click.
  let content: string
  try {
    const decoded = tryDecodeSaved(bytes ?? readFileSync(path), true, path, rewrapRecoveredEnvelope)
    content = decoded.ok ? decoded.text : UNDECRYPTABLE_MSG
  } catch {
    content = UNDECRYPTABLE_MSG
  }
  const tmp = join(
    app.getPath('temp'),
    `asktoto-${randomBytes(6).toString('hex')}-${basename(path).replace(/\.md$/, '')}.md`
  )
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  lockPathToCurrentUserWin32(tmp) // mode bits are ignored on Windows; enforce owner-only via DACL
  decryptedTemps.add(tmp)
  if (!tempCleanupHooked) {
    tempCleanupHooked = true
    app.on('will-quit', () => {
      for (const t of decryptedTemps) {
        try {
          if (existsSync(t)) unlinkSync(t)
        } catch {
          /* best-effort cleanup */
        }
      }
      decryptedTemps.clear()
    })
  }
  return tmp
}

/**
 * Startup sweep: removes orphaned `asktoto-<hex>-*.md` cleartext temp files left by a previous
 * session that was hard-killed (SIGKILL) before the will-quit cleanup hook could run.
 *
 * INTEGRATOR: call this from the main process immediately after `app.whenReady()` resolves,
 * before any transcript is opened, e.g.:
 *   import { sweepStaleTempFiles } from './transcripts'
 *   app.whenReady().then(() => { sweepStaleTempFiles(); … })
 */
export function sweepStaleTempFiles(): void {
  try {
    const tmp = app.getPath('temp')
    for (const name of readdirSync(tmp)) {
      if (/^asktoto-[0-9a-f]+-.*\.md$/.test(name)) {
        try {
          unlinkSync(join(tmp, name))
        } catch {
          /* best-effort — file may already be deleted or still open */
        }
      }
    }
  } catch {
    /* ignore — temp dir unreadable */
  }
}

const README = `# Métis — Meeting transcripts

This folder is created and maintained by **Métis**. Every meeting you run the copilot in is
saved here automatically as one markdown file: AI notes + the full timestamped transcript, with
frontmatter (\`type: meeting-transcript\`, \`status: ready-for-followup\`).

## For your Dust agents
- Read **index.md** for the running list of meetings, or scan the \`*.md\` files directly.
- Each file is tagged \`status: ready-for-followup\` — generate follow-ups, then update the status.
- Filenames are \`YYYY-MM-DD_HHMMSS-<slug>.md\`; frontmatter carries date, mode, participants, duration.

Do not rename this folder — Métis and your agents read from here.
`

const INDEX_HEADER = `# Métis Meetings — Index

| Date | Title | Mode | Duration | File |
|------|-------|------|----------|------|
`

/** Ensure the meetings folder exists and is self-documenting (README + index). Safe to call repeatedly. */
export function ensureMeetingsFolder(settings: Settings): string {
  const folder = resolveMeetingsFolder(settings)
  try {
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    const readme = join(folder, 'README.md')
    if (!existsSync(readme)) writeFileSync(readme, README, 'utf8')
    const index = join(folder, 'index.md')
    if (!existsSync(index)) writeFileSync(index, INDEX_HEADER, 'utf8')
  } catch {
    /* fail-open: folder may be offline/unwritable */
  }
  return folder
}

function appendIndexRow(folder: string, dateStr: string, title: string, mode: string, durMin: number, fileName: string): void {
  try {
    const index = join(folder, 'index.md')
    if (!existsSync(index)) writeFileSync(index, INDEX_HEADER, 'utf8')
    const safeTitle = title.replace(/\|/g, '/')
    const safeMode = mode.replace(/\|/g, '/').replace(/[\r\n]/g, ' ')
    appendFileSync(index, `| ${dateStr} | ${safeTitle} | ${safeMode} | ${durMin} min | [open](${fileName}) |\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

// The meetings root is resolved in infra/storage/paths.ts; re-exported for this module's importers.
export { detectOneDrive } from './infra/storage/paths'
export { resolveMeetingsFolder }

const pad = (n: number): string => String(n).padStart(2, '0')
function slug(s: string): string {
  return (
    (s || 'meeting')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'meeting'
  )
}
function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
/** Non-reversible filename segment used in place of the title slug when encryptTranscripts is on — the
 *  file CONTENTS are already encrypted, but a readable `-${slug(title)}` in the filename itself leaks the
 *  plaintext title at rest (e.g. via a OneDrive-synced folder listing). A random token carries no
 *  relationship to the title (unlike a hash, which a small guessable title space could dictionary-attack).
 *  Keeps the `stamp(started)-` prefix untouched so recall.ts's STUB_FILENAME_TIMESTAMP/NOTE_FILENAME
 *  regexes (timestamp-prefix only) still recognize the file as a real meeting/note. */
function opaqueNamePart(): string {
  return randomBytes(6).toString('hex')
}
const cleanTitle = (s: string): string => {
  // Collapse whitespace, strip control/newline chars, limit length for YAML/frontmatter safety.
  return (s || '')
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}
const speakerLabel = (speaker: TranscriptLine['speaker']): 'Them' | 'You' | 'Speaker' =>
  speaker === 'them' ? 'Them' : speaker === 'you' ? 'You' : 'Speaker'
/** A diarization cluster label ("Speaker 1"), as minted by speaker-cluster.ts. Shared with recall.ts's
 *  parser via the same shape, so the writer and the reader cannot disagree about what one looks like. */
export const CLUSTER_LABEL_RE = /^Speaker \d+$/
const isClusterLabel = (name: string): boolean => CLUSTER_LABEL_RE.test(name)
const yamlSafeTitle = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

// Speaker Intelligence: `name` can come from a THIRD PARTY (a Teams VTT transcript — see
// main/graph-transcript.ts), not just the trusted signed-in account, so it must be sanitized before it
// ever reaches the saved markdown. Strips control/newline characters (would break the single-line
// "**[HH:MM:SS] Label (Name):**" shape below) and parentheses specifically — they're the round-trip
// delimiter recall.ts's parser depends on, so a name containing one would corrupt the parse — then caps
// length in line with the other name-shaped fields in this codebase (see ipc.ts's AsrCorrectionPairSchema).
function sanitizeSpeakerName(name: string | undefined): string {
  if (!name) return ''
  return name
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** Render one transcript line in the fixed on-disk shape recall.ts's parser reads back:
 *  `**[HH:MM:SS] Label:** text`, or `**[HH:MM:SS] Label (Name):** text` once Speaker Intelligence has
 *  resolved a display name for that line (see shared/transcript-align.ts). */
function formatTranscriptLine(l: TranscriptLine): string {
  const d = new Date(l.t)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const name = sanitizeSpeakerName(l.name)
  // MQA-245: a diarization cluster label IS the speaker identity, not a name for one. Wrapping it in the
  // generic role label rendered "Speaker (Speaker 1)" in the durable file the user reads and may share.
  // Emit the cluster label alone; recall.ts's line regex accepts this form and reads the label back as
  // the name, so the round trip is unchanged. Only the generic role collapses — "Them (Jane Doe)" says
  // two different things and keeps both.
  const label = isClusterLabel(name) && speakerLabel(l.speaker) === 'Speaker' ? name : name ? `${speakerLabel(l.speaker)} (${name})` : speakerLabel(l.speaker)
  return `**[${t}] ${label}:** ${l.text}`
}

/** Render a full transcript body. saveMeeting and saveDraftTranscript share this exact shape so a
 *  promoted draft (see recoverOrphanDrafts) parses identically to a normally-saved meeting.
 *
 *  Mixed-language meetings get an italic `_[conversation switches to …]_` marker paragraph wherever the
 *  tagged line language changes (TranscriptLine.lang — absent on untagged/older lines, so those never
 *  emit markers). The marker deliberately does NOT match recall.ts's `**[HH:MM:SS] Label:**` line regex:
 *  re-parsing a saved meeting simply skips it, same as any other non-line prose. */
export function formatTranscript(lines: TranscriptLine[]): string {
  const parts: string[] = []
  let prevLang: string | undefined
  for (const l of lines) {
    if (l.lang && prevLang && l.lang !== prevLang) parts.push(`_[conversation switches to ${l.lang}]_`)
    if (l.lang) prevLang = l.lang
    parts.push(formatTranscriptLine(l))
  }
  return parts.join('\n\n')
}

/** Save any single Q&A / answer as a Dust-readable markdown note. Returns the file path. */
export async function saveNote(settings: Settings, n: SaveNote): Promise<string> {
  // MQA-278 — refuses Act 2 onboarding-demo-tagged data before touching disk. See @shared/demo-guard.
  refuseIfDemoTagged('saveNote', n.title, n.mode, n.question)
  const folder = ensureMeetingsFolder(settings)
  const started = Date.now()
  const title = cleanTitle(n.title || n.question || 'Note') || 'Note'
  // Encrypted at rest → the filename must not leak the plaintext title either (see opaqueNamePart above).
  const namePart = settings.encryptTranscripts ? opaqueNamePart() : slug(title)
  let file = join(folder, `${stamp(started)}-note-${namePart}.md`)
  for (let i = 2; existsSync(file); i++) {
    file = join(folder, `${stamp(started)}-note-${namePart}-${i}.md`)
  }
  const frontmatter = [
    '---',
    'type: note',
    'source: Métis',
    `mode: "${yamlSafeTitle(cleanTitle(n.mode))}"`,
    `date: ${new Date(started).toISOString()}`,
    `title: "${yamlSafeTitle(title)}"`,
    'status: ready-for-followup',
    '---',
    ''
  ].join('\n')
  const body =
    `# ${title}\n\n_${new Date(started).toLocaleString()} · note · Métis_\n\n` +
    (n.question ? `## Question\n\n${n.question}\n\n` : '') +
    `## Answer\n\n${n.answer}\n`
  // Atomic write (encrypted at rest when enabled).
  await writeSaved(file, frontmatter + body, settings.encryptTranscripts)

  // The plaintext index.md would leak titles/dates, defeating encryption — skip it in that mode.
  if (!settings.encryptTranscripts) {
    const di = new Date(started)
    const dateStr = `${di.getFullYear()}-${pad(di.getMonth() + 1)}-${pad(di.getDate())} ${pad(di.getHours())}:${pad(di.getMinutes())}`
    appendIndexRow(folder, dateStr, title, 'note', 0, file.slice(folder.length + 1))
  }
  return file
}

/** Whole minutes of recording when measured, or a legacy transcript-span estimate. The value saveMeeting stamps into
 *  the frontmatter AND the value recordMeetingSummarized credits, so the tile and the on-disk meetings
 *  can never disagree about how long a call was. */
export function meetingDurationMin(m: { startedAt: number; durationMs?: number; lines: { t: number }[] }): number {
  return meetingDurationMinutes(m)
}

/** Write a meeting as Dust-readable markdown + frontmatter. Returns the file path. */
export async function saveMeeting(settings: Settings, m: SaveMeeting): Promise<string> {
  const statusError = recapStatusValidationError(m.recap, m.recapStatus)
  if (statusError) throw new Error(statusError)
  // MQA-278 — refuses Act 2 onboarding-demo-tagged data before touching disk. See @shared/demo-guard.
  refuseIfDemoTagged('saveMeeting', m.title, m.mode)
  const folder = ensureMeetingsFolder(settings)

  // Guard against non-finite/out-of-range values (e.g. Infinity), not just falsy ones: Date's valid
  // range is +/-8.64e15ms from epoch, and anything outside it throws RangeError from toISOString()
  // below with no surrounding try/catch, losing the whole meeting.
  const started =
    m.startedAt && Number.isFinite(m.startedAt) && Math.abs(m.startedAt) <= 8.64e15 ? m.startedAt : Date.now()
  const heuristicTitle = cleanTitle(m.title) || `${m.mode} meeting`

  // Main is the single source of truth for the final title: when a recap was generated, prefer its
  // "## Title" (2-4 real words naming the topic) over the renderer's "first sentence of theirs" heuristic.
  // Falls back to the renderer-provided title when there's no recap yet, or the model left Title empty.
  const recapParsed = m.recap ? parseRecapMarkdown(m.recap) : null
  const title = cleanTitle(recapParsed?.title24 || '') || heuristicTitle
  const tags = recapParsed?.tags || []

  // Encrypted at rest → the filename must not leak the plaintext title either (see opaqueNamePart above).
  const namePart = settings.encryptTranscripts ? opaqueNamePart() : slug(title)
  let file = join(folder, `${stamp(started)}-${namePart}.md`)
  for (let n = 2; existsSync(file); n++) {
    file = join(folder, `${stamp(started)}-${namePart}-${n}.md`)
  }

  const durMin = meetingDurationMin(m)
  const participants = Array.from(new Set(m.lines.map((l) => speakerLabel(l.speaker))))

  // Enterprise-live SUMMARY_ONLY: omit fresh Full transcript section. Never rewrite/delete older files.
  const summaryOnly = isSummaryOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive ?? settings))
  const transcript = summaryOnly ? '' : formatTranscript(m.lines)

  const frontmatter =
    [
      '---',
      summaryOnly ? 'type: meeting-summary' : 'type: meeting-transcript',
      'source: Métis',
      `mode: "${yamlSafeTitle(cleanTitle(m.mode))}"`,
      `date: ${new Date(started).toISOString()}`,
      `title: "${yamlSafeTitle(title)}"`,
      `participants: [${participants.join(', ')}]`,
      `duration_min: ${durMin}`,
      ...(measuredDurationMs(m.durationMs) !== undefined ? [`duration_ms: ${measuredDurationMs(m.durationMs)}`] : []),
      `lines: ${summaryOnly ? 0 : m.lines.length}`,
      ...(m.recapStatus ? [`recap_status: ${m.recapStatus}`] : []),
      ...(tags.length ? [`topics: [${tags.map((t) => yamlSafeTitle(t)).join(', ')}]`] : []),
      ...(summaryOnly ? ['retention: summary-only'] : []),
      'status: ready-for-followup',
      '---',
      ''
    ].join('\n')

  const body =
    `# ${title}\n\n_${new Date(started).toLocaleString()} · ${m.mode} · ${durMin} min · Métis_\n\n` +
    (m.recap ? `## Notes & follow-ups\n\n${m.recap}\n\n` : '') +
    (summaryOnly
      ? `## Retention\n\n_Summary/action record — full transcript not retained under managed enterprise profile._\n`
      : `## Full transcript\n\n${transcript || '_No speech captured._'}\n`)

  await writeSaved(file, frontmatter + body, settings.encryptTranscripts) // atomic; encrypted at rest when on

  if (!settings.encryptTranscripts) {
    const di = new Date(started)
    const dateStr = `${di.getFullYear()}-${pad(di.getMonth() + 1)}-${pad(di.getDate())} ${pad(di.getHours())}:${pad(di.getMinutes())}`
    appendIndexRow(folder, dateStr, title, m.mode, durMin, file.slice(folder.length + 1))
  }
  return file
}

/** Neutralize any line that would be parsed as a markdown heading (e.g. "## Sneaky heading") inside a
 *  user-authored debrief body. Without this, a heading-shaped line in the user's OWN text is
 *  indistinguishable from a real document section — both to appendDebrief's own replace-boundary search
 *  below and to any markdown renderer. Escaping the leading `#`s keeps the text fully visible, just not
 *  heading syntax. */
function escapeHeadingLines(s: string): string {
  return s.replace(/^(#{1,6})(\s)/gm, '\\$1$2')
}

/**
 * 90-Second Debrief (innovation #6): append the user's post-meeting gut-read — what was NOT said
 * aloud, hallway remarks, instinct — to the saved meeting as its own section. This is the off-record
 * layer: the transcript records what was spoken; the debrief records what the user sensed. It lives in
 * the same file so it inherits encryption, retention, deletion, and brain ingest (the extraction reads
 * the full markdown, so debrief observations feed signals/missed_signals on the next ingest).
 *
 * Idempotent: a second save REPLACES the debrief section rather than stacking copies. `file` must be a
 * bare basename inside the meetings folder (callers pass basename; we re-basename for defense).
 *
 * The section boundary is TWO layers deep, since either alone can be defeated by adversarial-looking-
 * but-perfectly-normal user text (e.g. a debrief that itself starts with "## "):
 *   1. The debrief body is sanitized on write (escapeHeadingLines) so it can never contain a real
 *      "## "-shaped line in the first place.
 *   2. The section is terminated by an explicit `DEBRIEF_END_MARKER` HTML comment, so the replace logic
 *      finds the exact end of the PREVIOUS debrief instead of scanning for the next "## " (which would
 *      match text inside the debrief body on an older, pre-marker file). Files written before this
 *      marker existed fall back to the old "next heading" search.
 */
export const DEBRIEF_HEADING = '## Debrief (off the record)'
const DEBRIEF_END_MARKER = '<!-- /debrief -->'
export async function appendDebrief(
  settings: Settings,
  file: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const folder = resolveMeetingsFolder(settings)
  const safeName = safeMeetingBasename(file)
  if (!safeName) return { ok: false, error: 'Invalid meeting file name.' }
  const path = join(folder, safeName)
  const read = await storageAt(folder).read(safeName)
  if (read.status === 'missing') return { ok: false, error: 'Meeting file not found.' }
  if (read.status !== 'ok') {
    return { ok: false, error: 'Could not read the meeting file.' }
  }
  const md = decodeSaved(read.bytes)
  if (!md) return { ok: false, error: 'Meeting file could not be decrypted on this device.' }
  if (!/^type: meeting-transcript$/m.test(md)) return { ok: false, error: 'Not a meeting transcript.' }
  const safeText = escapeHeadingLines(text.trim())
  const section =
    `${DEBRIEF_HEADING}\n\n_Captured right after the meeting — impressions, not transcript._\n\n` +
    `${safeText}\n${DEBRIEF_END_MARKER}\n`
  const start = md.indexOf(DEBRIEF_HEADING)
  let updated: string
  if (start < 0) {
    updated = md.trimEnd() + '\n\n' + section
  } else {
    const markerIdx = md.indexOf(DEBRIEF_END_MARKER, start + DEBRIEF_HEADING.length)
    if (markerIdx >= 0) {
      // Exact boundary: everything after the marker's own line belongs to whatever comes next.
      const afterMarker = md.indexOf('\n', markerIdx)
      updated = md.slice(0, start) + section + (afterMarker >= 0 ? md.slice(afterMarker + 1) : '')
    } else {
      // Legacy file written before this marker existed: fall back to the old heuristic.
      const next = md.indexOf('\n## ', start + DEBRIEF_HEADING.length)
      updated = md.slice(0, start) + section + (next >= 0 ? md.slice(next + 1) : '')
    }
  }
  // Preserve the file's ORIGINAL at-rest encryption exactly as found (mirrors updateMeetingRecap /
  // renameMeeting), NOT the live encryptTranscripts toggle. Otherwise appending a debrief to a file
  // that was saved while encryption was on would rewrite the whole transcript as plaintext once the
  // toggle is later turned off — a silent at-rest downgrade of already-recorded third-party speech.
  const wasEncrypted = isEncryptedBytes(read.bytes)
  await writeSaved(path, updated, wasEncrypted)
  return { ok: true }
}

// Keyed by the meeting's OWN startedAt (like saveMeeting's real filename), not a single fixed name.
// A fixed name would let the NEXT meeting's very first autosave tick silently overwrite a PREVIOUS
// meeting's crash-recovery copy before anyone had a chance to notice it — defeating the whole point.
// stamp() alone only has 1-second (HHMMSS) resolution, so two meetings starting in the same wall-clock
// second would still collide on it — the millisecond suffix (kept behind its own "-", so it still reads
// as "<HHMMSS>-<ms>" for recall.ts's FILENAME_TIMESTAMP retention regex, which only requires a literal
// "-" right after the 6-digit time) closes that gap down to true per-meeting uniqueness.
const draftFilename = (started: number): string =>
  `.autosave-draft-${stamp(started)}-${String(started % 1000).padStart(3, '0')}.md`

/**
 * Periodic best-effort snapshot of an IN-PROGRESS meeting (see the renderer's autosave timer while
 * Listen is active). Overwrites this ONE meeting's own draft file every tick — never touches index.md.
 * `type: meeting-transcript-draft` (not `meeting-transcript`) means readMeeting/listMeetings already
 * ignore it (see recall.ts's frontmatter-type guard) — no extra filtering needed there.
 *
 * Without this, a renderer crash or force-quit mid-meeting loses the whole transcript with zero disk
 * footprint (it exists only in React state until the recap-triggered save at the end). With it, the
 * worst case is losing the last autosave interval, not the whole meeting. clearDraftTranscript removes
 * it once the meeting ends normally and its real saveMeeting() has already succeeded. A crashed meeting's
 * draft is left on disk (dot-prefixed, so it doesn't clutter the meetings list) rather than auto-recovered
 * — that's a real, disclosed limitation: this closes the data-loss gap, it doesn't build recovery UX.
 */
export async function saveDraftTranscript(settings: Settings, m: SaveMeeting): Promise<void> {
  try {
    const folder = ensureMeetingsFolder(settings)
    const started = m.startedAt || Date.now()
    const file = join(folder, draftFilename(started))
    const title = cleanTitle(m.title) || `${m.mode} meeting`
const transcript = formatTranscript(m.lines)
    // Same duration_min/participants calc as saveMeeting above — without these, a draft promoted by
    // recoverOrphanDrafts (which only swaps the type:/status: lines, never adds fields) reads back with
    // durationMin 0 and an empty participants list forever, silently losing that badge on recovery.
    const last = m.lines.length ? m.lines[m.lines.length - 1].t : started
    const durMin = m.lines.length ? Math.max(1, Math.round((last - started) / 60000)) : 0
    const participants = Array.from(new Set(m.lines.map((l) => speakerLabel(l.speaker))))
    const frontmatter = [
      '---',
      'type: meeting-transcript-draft',
      'source: Métis',
      `mode: "${yamlSafeTitle(cleanTitle(m.mode))}"`,
      `date: ${new Date(started).toISOString()}`,
      `title: "${yamlSafeTitle(title)}"`,
      `participants: [${participants.join(', ')}]`,
      `duration_min: ${durMin}`,
      'status: interrupted',
      '---',
      ''
    ].join('\n')
    const body =
      `# ${title} (in progress — autosaved draft)\n\n` +
      'This is an automatic snapshot of a meeting still in progress, or one that ended without a normal ' +
      'save (crash / force quit). If Métis is still running this meeting, ignore this file — the real ' +
      'save replaces it when the meeting ends.\n\n' +
      `## Transcript so far\n\n${transcript || '_No speech captured yet._'}\n`
    await writeSaved(file, frontmatter + body, settings.encryptTranscripts)
  } catch {
    /* best-effort — an autosave failure must never interrupt the meeting */
  }
}

/**
 * Remove one meeting's autosave draft once it ends normally (its real saveMeeting() already succeeded).
 *
 * The unlink gets the same bounded retry writeSaved() uses for rename: the default meetings folder is
 * OneDrive-synced, which routinely holds a just-written file open for upload hashing, and AV/EDR
 * real-time scanning grabs it too — unlink then throws EPERM/EBUSY on Windows even though nothing is
 * wrong. A single best-effort attempt leaves the draft on disk, and recoverOrphanDrafts() promotes it
 * on the next launch, so the user sees their meeting twice with the second copy labelled
 * "(recovered)". Retrying rides out the transient lock; a genuinely stuck file still degrades to the
 * old behaviour rather than failing the meeting end.
 */
export async function clearDraftTranscript(settings: Settings, startedAt: number): Promise<void> {
  try {
    const file = join(resolveMeetingsFolder(settings), draftFilename(startedAt))
    if (!existsSync(file)) return
    for (let attempt = 0; ; attempt++) {
      try {
        await unlink(file)
        return
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw e
        await new Promise((r) => setTimeout(r, 40 * 2 ** attempt))
      }
    }
  } catch {
    /* best-effort — a stuck draft is recovered on next launch, it must never fail the meeting end */
  }
}

const IN_PROGRESS_SUFFIX = ' (in progress — autosaved draft)'

// Never follow a symlink planted with a draft-shaped name: `FileClass.isSymlink` is the directory
// entry's own type (from lstat), not the target's, so a symlink to another meeting already inside the
// folder is rejected here even though the gateway's `read()` would otherwise follow it.
function isFile(fileClass: FileClass | undefined): boolean {
  return !!fileClass && 'isSymlink' in fileClass && !fileClass.isSymlink
}

/**
 * Promote orphaned autosave drafts into real, visible meetings (run once at launch). A draft only
 * survives on disk when its meeting never reached a normal save — a crash or force-quit — so leaving
 * it as an invisible dot-file meant the recording of third-party speech sat outside History, outside
 * the retention sweep, and outside recovery, forever. Promotion re-enters it into the normal
 * lifecycle: it appears in History as "(recovered)", retention applies (the recovered filename keeps
 * the stamp prefix the sweep parses), and the user loses at most the final autosave interval instead
 * of the whole meeting. Runs before any Listen session starts, and drafts are keyed by their own
 * startedAt, so a live meeting's draft can never be promoted out from under it. Undecryptable drafts
 * (foreign keychain) are left in place for the device that can read them. Idempotent across repeated
 * runs: a draft whose promoted file already exists (e.g. because a prior run's unlink failed after a
 * successful write) is never re-promoted — only its stale source file is retried for cleanup — and,
 * in plaintext mode, the recovered meeting gets an index.md row exactly like a normally-saved one.
 */
export async function recoverOrphanDrafts(settings: Settings): Promise<{ recovered: number }> {
  let recovered = 0
  try {
    const folder = resolveMeetingsFolder(settings)
    const gateway = storageAt(folder)
    const listing = await gateway.list('')
    if (listing.status !== 'ok') return { recovered }
    const draftNames = listing.names.filter((name) => name.startsWith('.autosave-draft-') && name.endsWith('.md'))
    const draftClasses = await classifyAll(gateway, draftNames)
    const occupied = new Set(listing.names)
    for (const f of draftNames) {
      if (!isFile(draftClasses.get(f))) continue
      const draftPath = join(folder, f)
      try {
        const stampPart = f.slice('.autosave-draft-'.length, -'.md'.length)
        const primaryOut = join(folder, `${stampPart}-recovered.md`)
        if (occupied.has(basename(primaryOut))) {
          // Already promoted by a previous run — this draft only still exists because that run's
          // unlink below failed afterward (transient EBUSY/EPERM; this folder is often OneDrive-synced).
          // Re-promoting would write a second, fully duplicate "-recovered-2.md" copy of the same
          // meeting, so just retry the cleanup and move on without touching `recovered`.
          await unlink(draftPath).catch(() => {
            /* still stale for the next run — harmless; the occupied-name guard prevents a dupe */
          })
          continue
        }
        // Preserve the DRAFT's own at-rest encryption exactly as found (mirrors appendDebrief /
        // renameMeeting), NOT the live encryptTranscripts toggle. A draft written while encryption was
        // on holds recorded third-party speech; promoting it under a since-disabled toggle would rewrite
        // it as unmarked cleartext into the (OneDrive-synced) meetings folder — a silent at-rest
        // downgrade, with no prompt and no way back.
        const read = await gateway.read(f)
        if (read.status !== 'ok') continue
        const wasEncrypted = isEncryptedBytes(read.bytes)
        const text = decodeSaved(read.bytes)
        if (!text) continue // undecryptable on this device — leave it alone
        const promoted = text
          .replace('type: meeting-transcript-draft', 'type: meeting-transcript')
          .replace('status: interrupted', 'status: recovered')
          .replace(IN_PROGRESS_SUFFIX, ' (recovered)')
        let out = primaryOut
        for (let n = 2; occupied.has(basename(out)); n++) out = join(folder, `${stampPart}-recovered-${n}.md`)
        await writeSaved(out, promoted, wasEncrypted)
        occupied.add(basename(out))
        try {
          await unlink(draftPath)
        } catch {
          // The promoted copy is already safely on disk; a future run will see primaryOut exists and
          // skip re-promoting this same stale draft (see the guard above), only retrying its cleanup.
        }
        recovered++

        // Mirror saveMeeting's exact plaintext-mode index.md bookkeeping (same row shape) — a recovered
        // meeting should be just as discoverable from index.md as a normal one. Keyed on the file we
        // just wrote, not the live toggle: index.md is always cleartext, so a preserved-encrypted
        // recovery would otherwise leak the meeting's title and date beside the ciphertext.
        if (!wasEncrypted) {
          const lines = text.split('\n')
          const dateLine = lines.find((l) => l.startsWith('date: '))
          const modeLine = lines.find((l) => l.startsWith('mode: '))
          const h1Line = lines.find((l) => l.startsWith('# ') && l.endsWith(IN_PROGRESS_SUFFIX))
          const d = dateLine ? new Date(dateLine.slice('date: '.length)) : new Date()
          const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
          const title = h1Line ? h1Line.slice(2, -IN_PROGRESS_SUFFIX.length) : 'Recovered meeting'
          // mode is now written quoted (see saveDraftTranscript); strip the wrapping quotes so a
          // recovered meeting's index row shows the bare value, same as before that change.
          const mode = modeLine ? modeLine.slice('mode: '.length).replace(/^"|"$/g, '') : 'meeting'
          appendIndexRow(folder, dateStr, title, mode, 0, basename(out))
        }
      } catch {
        /* one unreadable draft must not block recovering the others */
      }
    }
  } catch {
    /* best-effort — recovery must never block launch */
  }
  return { recovered }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Minimal, deterministic markdown→HTML for RECAP_PROMPT's fixed shape only (## headings, "-"/"*" bullet
 * lists, plain paragraphs) — not a general markdown parser. Used solely to print a recap to PDF via
 * Electron's webContents.printToPDF(); no npm dependency needed for that one job.
 */
export function recapMarkdownToHtml(markdown: string, title?: string): string {
  const body: string[] = []
  let inList = false
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd()
    const h2 = /^##\s+(.*)/.exec(line)
    const bullet = /^[-*]\s+(.*)/.exec(line)
    if (h2) {
      if (inList) {
        body.push('</ul>')
        inList = false
      }
      body.push(`<h2>${escapeHtml(h2[1])}</h2>`)
    } else if (bullet) {
      if (!inList) {
        body.push('<ul>')
        inList = true
      }
      body.push(`<li>${escapeHtml(bullet[1])}</li>`)
    } else if (line.trim()) {
      if (inList) {
        body.push('</ul>')
        inList = false
      }
      body.push(`<p>${escapeHtml(line)}</p>`)
    }
  }
  if (inList) body.push('</ul>')
  const style =
    'body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;padding:32px;line-height:1.5}' +
    'h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.02em;' +
    'color:#444;margin:20px 0 8px}ul{margin:0 0 8px;padding-left:20px}li{margin-bottom:4px}p{margin:0 0 8px}'
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : ''
  const csp =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${style}</style></head><body>${heading}${body.join('\n')}</body></html>`
}

const RECAP_SECTION_ALIASES: Readonly<Record<string, string>> = {
  titre: 'title',
  etiquettes: 'tags',
  'mots-cles': 'tags',
  'mots cles': 'tags',
  resume: 'recap',
  synthese: 'overview',
  apercu: 'overview',
  "vue d'ensemble": 'overview',
  sujets: 'topics',
  'sujets abordes': 'topics',
  themes: 'topics',
  'themes abordes': 'topics',
  'questions-reponses': 'key q&a',
  'questions-reponses cles': 'key q&a',
  'questions et reponses': 'key q&a',
  'questions et reponses cles': 'key q&a',
  actions: 'action items',
  'actions a mener': 'action items',
  "points d'action": 'action items',
  "elements d'action": 'action items',
  'prochaines etapes': 'next steps',
  'etapes suivantes': 'next steps',
  suivis: 'follow-ups',
  'questions ouvertes': 'open questions',
  'questions en suspens': 'open questions',
  'citations notables': 'notable quotes',
  'citations marquantes': 'notable quotes'
}

const foldRecapLabel = (text: string): string =>
  text.trim().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase()

export function recapSectionKey(text: string): string {
  const folded = foldRecapLabel(text)
  return Object.prototype.hasOwnProperty.call(RECAP_SECTION_ALIASES, folded)
    ? RECAP_SECTION_ALIASES[folded]
    : folded
}

/**
 * Parse a RECAP_PROMPT markdown document into a structured export (for piping into Jira/Asana/Notion).
 * Sections come from RECAP_PROMPT's fixed "## Name:" headings; action-item owners are pulled from the
 * common "task (Owner)" / "task — Owner" / "task - Owner" trailers when present. Best-effort: unknown or
 * reworded sections fall through to empty arrays, and the full original markdown is always included so
 * nothing is ever lost.
 */
export function parseRecapMarkdown(markdown: string): RecapExport {
  const md = typeof markdown === 'string' ? markdown : ''

  // Split on "## " headings; map each heading (colon-trimmed, lowercased) to its body up to the next "## ".
  // Models sometimes emit the content INLINE on the heading line ("## Title: Renault Contract Renewal")
  // instead of on the next line — the prompt's own "## Title: 2 to 4 words…" template invites that shape.
  // For KNOWN section names, split at the first colon and treat the remainder as the body's first line;
  // unknown headings keep the strict whole-line key so a legitimate colon in prose isn't mis-split.
  const KNOWN = new Set([
    'title', 'tags', 'overview', 'topics', 'key q&a', 'key qa',
    'decisions', 'action items', 'next steps', 'follow-ups', 'follow ups',
    'open questions', 'notable quotes', 'recap',
    'outcome', 'key numbers', 'deal snapshot', 'buying signals', 'objections',
    'what the seller must know', 'stakeholders', 'candidate', 'background',
    'motivations', 'projects', 'compensation and contract', 'availability',
    'ratings', 'strengths and concerns', 'role', 'questions and answers',
    'examples given', 'next rounds', 'positions', 'interests', 'concessions',
    'agreed terms', 'still open', 'what landed', 'audience questions',
    'confusion or pushback', 'follow-ups promised', 'reported problem',
    'steps tried', 'resolution', 'how the call went', 'qualifying facts',
    'commitment'
  ])
  const sections: Record<string, string> = {}
  for (const part of md.split(/^##\s+/m)) {
    const nl = part.indexOf('\n')
    const headRaw = (nl === -1 ? part : part.slice(0, nl)).trim()
    let body = nl === -1 ? '' : part.slice(nl + 1).trim()
    let heading = recapSectionKey(headRaw.replace(/:\s*$/, ''))
    const colon = headRaw.indexOf(':')
    if (colon > 0 && colon < headRaw.length - 1) {
      const maybeKey = recapSectionKey(headRaw.slice(0, colon))
      if (KNOWN.has(maybeKey)) {
        heading = maybeKey
        const inline = headRaw.slice(colon + 1).trim()
        body = body ? `${inline}\n${body}` : inline
      }
    }
    if (heading) sections[heading] = body
  }

  const bullets = (text: string | undefined): string[] =>
    (text || '')
      .split('\n')
      .map((l) => l.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '').trim()) // strip bullet + optional [ ]/[x] checkbox
      .filter((l) => l.length > 0 && !/^(?:none|aucun(?:e|s|es)?|neant)\.?$/.test(foldRecapLabel(l)))

  // Best-effort trailing "by <phrase>" clause on the OWNER-STRIPPED text (e.g. "Send the deck by Friday"
  // → dueDateText "Friday"). Never parsed into a Date — RECAP_PROMPT only asks the model for "an owner
  // when stated", never a structured date, so this is display text only (see RecapExportSchema).
  const splitDueDate = (text: string): { text: string; dueDateText: string | null } => {
    const by = text.match(/^(.*\S)\s+by\s+(.+)$/i)
    return by ? { text: by[1].trim(), dueDateText: by[2].trim() } : { text, dueDateText: null }
  }

  // Wave 1D / QA: SUMMARY_PROMPT uses "## Next steps" (and historically "**Follow-ups**"); RECAP_PROMPT
  // uses "## Action items". Prefer the first non-empty body so local summaries feed Book-next-steps,
  // wiki publish, and RecapExport the same way cloud recaps do.
  const actionBody =
    sections['action items'] ||
    sections['next steps'] ||
    sections['follow-ups'] ||
    sections['follow ups'] ||
    sections['follow-ups promised'] ||
    sections['commitment'] ||
    ''
  const actionItems = bullets(actionBody).map((raw) => {
    // "Do the thing (Alice)". Non-greedy text + a paren-free owner anchored to the end, so a stray inner
    // paren (e.g. "(Alice (boss))") degrades gracefully to owner:null rather than a wrong split.
    const paren = raw.match(/^(.*?\S)\s*\(([^()]+)\)\s*$/)
    if (paren) return { ...splitDueDate(paren[1].trim()), owner: paren[2].trim() }
    const dash = raw.match(/^(.*\S)\s+[—-]\s+(.+)$/) // "Do the thing — Alice" / "Do the thing - Alice"
    if (dash) return { ...splitDueDate(dash[1].trim()), owner: dash[2].trim() }
    return { ...splitDueDate(raw), owner: null as string | null }
  })

  // "## Title:" body — first line only, wrapping quotes/emphasis (models mirror the prompt's quoted
  // example) and trailing punctuation stripped, capped for filename/UI safety.
  const titleBody = (sections['title'] || '').split('\n')[0].trim()
  const title24 = titleBody
    .replace(/^["'“”*_\s]+|["'“”*_\s]+$/g, '')
    .replace(/[.!?,;:]+$/, '')
    .trim()
    .slice(0, 60)

  // "## Tags:" body — usually one comma-separated line, but tolerate the model emitting a bullet list.
  // Tags feed unquoted YAML flow-sequence frontmatter and React keys, so strip quote/bracket/backslash
  // characters, dedup case-insensitively, cap at 5.
  const tagsSection = sections['tags'] || ''
  const tagList = /^\s*[-*]/m.test(tagsSection) ? bullets(tagsSection) : [tagsSection]
  const tags: string[] = []
  const seenTags = new Set<string>()
  for (const raw of tagList.flatMap((t) => t.split(/[,\n]/))) {
    const tag = raw.replace(/["'“”\\[\]]/g, '').trim()
    if (!tag || seenTags.has(tag.toLowerCase())) continue
    seenTags.add(tag.toLowerCase())
    tags.push(tag)
    if (tags.length === 5) break
  }

  return {
    title24,
    tags,
    // SUMMARY_PROMPT's first section used to be "**Recap**" / "## Recap"; RECAP uses "## Overview".
    overview: sections['overview'] || sections['recap'] || sections['outcome'] || '',
    topics: bullets(sections['topics']),
    keyQA: bullets(sections['key q&a'] || sections['key qa']),
    decisions: bullets(sections['decisions']),
    actionItems,
    openQuestions: bullets(sections['open questions']),
    notableQuotes: bullets(sections['notable quotes']),
    markdown: md
  }
}
