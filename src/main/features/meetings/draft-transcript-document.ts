import type { SaveMeeting } from '@shared/ipc'
import type { TranscriptLine } from '@shared/transcript-line'
import { speakerLabel } from './transcript-format'
import { cleanTitle, pad, yamlSafeTitle } from './transcript-document-format'

const IN_PROGRESS_SUFFIX = ' (in progress — autosaved draft)'

/**
 * The `duration_min` and `participants` frontmatter values for a draft's lines. Same calc as saveMeeting: without
 * them, a draft promoted by recoverOrphanDrafts (which only swaps the type:/status: lines, never adds fields) reads
 * back with durationMin 0 and an empty participants list forever, silently losing that badge on recovery.
 */
export function draftSummaryFields(
  lines: readonly TranscriptLine[],
  started: number
): { durMin: number; participants: string[] } {
  const last = lines.length ? lines[lines.length - 1].t : started
  const durMin = lines.length ? Math.max(1, Math.round((last - started) / 60000)) : 0
  return { durMin, participants: Array.from(new Set(lines.map((l) => speakerLabel(l.speaker)))) }
}

export function buildDraftTranscriptDocument(
  m: SaveMeeting,
  started: number,
  title: string,
  transcript: string
): string {
  const { durMin, participants } = draftSummaryFields(m.lines, started)
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
    `# ${title}${IN_PROGRESS_SUFFIX}\n\n` +
    'This is an automatic snapshot of a meeting still in progress, or one that ended without a normal ' +
    'save (crash / force quit). If Métis is still running this meeting, ignore this file — the real ' +
    'save replaces it when the meeting ends.\n\n' +
    `## Transcript so far\n\n${transcript || '_No speech captured yet._'}\n`
  return frontmatter + body
}

export function promoteDraftTranscript(text: string): string {
  return text
    .replace('type: meeting-transcript-draft', 'type: meeting-transcript')
    .replace('status: interrupted', 'status: recovered')
    .replace(/^## Transcript so far$/m, '## Full transcript')
    .replace(IN_PROGRESS_SUFFIX, ' (recovered)')
}

export function recoveredDraftIndexFields(text: string): { dateStr: string; title: string; mode: string } {
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
  return { dateStr, title, mode }
}
