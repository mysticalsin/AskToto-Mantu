import type { SaveMeeting } from '@shared/ipc'
import { measuredDurationMs } from '@shared/meeting-duration'
import { escapeSpeechMarkers } from './speech-provenance'

const yamlSafe = (text: string): string => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

/** Pure final-save projection. The existing encrypted writer still owns the one atomic file. */
export function buildMeetingSaveDocument(input: {
  meeting: SaveMeeting
  title: string
  mode: string
  started: number
  durationMin: number
  participants: string[]
  tags: string[]
  summaryOnly: boolean
  transcript: string
}): string {
  const { meeting: m, title, mode, started, durationMin, participants, tags, summaryOnly, transcript } = input
  const frontmatter = [
    '---',
    summaryOnly ? 'type: meeting-summary' : 'type: meeting-transcript',
    'source: Métis',
    `mode: "${yamlSafe(mode)}"`,
    `date: ${new Date(started).toISOString()}`,
    `title: "${yamlSafe(title)}"`,
    `participants: [${participants.join(', ')}]`,
    `duration_min: ${durationMin}`,
    ...(measuredDurationMs(m.durationMs) !== undefined ? [`duration_ms: ${measuredDurationMs(m.durationMs)}`] : []),
    `lines: ${summaryOnly ? 0 : m.lines.length}`,
    ...(m.recapStatus ? [`recap_status: ${m.recapStatus}`] : []),
    ...(tags.length ? [`topics: [${tags.map(yamlSafe).join(', ')}]`] : []),
    ...(summaryOnly ? ['retention: summary-only'] : []),
    'status: ready-for-followup',
    '---',
    ''
  ].join('\n')
  const recap = m.lines.some((line) => line.speech) ? escapeSpeechMarkers(m.recap) : m.recap
  return (
    frontmatter +
    `# ${title}\n\n_${new Date(started).toLocaleString()} · ${m.mode} · ${durationMin} min · Métis_\n\n` +
    (recap ? `## Notes & follow-ups\n\n${recap}\n\n` : '') +
    (summaryOnly
      ? '## Retention\n\n_Summary/action record — full transcript not retained under managed enterprise profile._\n'
      : `## Full transcript\n\n${transcript || '_No speech captured._'}\n`)
  )
}
