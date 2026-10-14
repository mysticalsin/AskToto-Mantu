import { detectLanguage } from '@shared/lang-id'
import type { TranscriptLine } from '@shared/transcript-line'

/** Backward-compatible public Markdown parser; it makes no claim of retained word provenance. */
export function readLegacyTranscript(text: string, startedAt?: number): TranscriptLine[] {
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
    // transcript-format.ts's formatTranscriptLine once one has been resolved; absent on every meeting saved
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

  return lines
}
