import type { TranscriptLine } from '@shared/ipc'

const pad = (n: number): string => String(n).padStart(2, '0')

export const speakerLabel = (speaker: TranscriptLine['speaker']): 'Them' | 'You' | 'Speaker' =>
  speaker === 'them' ? 'Them' : speaker === 'you' ? 'You' : 'Speaker'

/** A diarization cluster label ("Speaker 1"), as minted by speaker-cluster.ts. Shared with recall.ts's
 * parser via the same shape, so the writer and the reader cannot disagree about what one looks like. */
export const CLUSTER_LABEL_RE = /^Speaker \d+$/
const isClusterLabel = (name: string): boolean => CLUSTER_LABEL_RE.test(name)

// Names can come from a third-party Teams VTT transcript. Keep the display-line delimiter intact,
// strip controls/newlines and cap length before rendering saved Markdown.
export function sanitizeSpeakerName(name: string | undefined): string {
  if (!name) return ''
  return name
    .replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** The display-line shape recall.ts reads back, with an optional resolved speaker name. */
function formatTranscriptLine(l: TranscriptLine, clock?: string): string {
  const d = new Date(l.t)
  const t = clock ?? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const name = sanitizeSpeakerName(l.name)
  // A diarization cluster label carries the identity itself; a real name still qualifies the role.
  const label =
    isClusterLabel(name) && speakerLabel(l.speaker) === 'Speaker'
      ? name
      : name
        ? `${speakerLabel(l.speaker)} (${name})`
        : speakerLabel(l.speaker)
  return `**[${t}] ${label}:** ${l.text}`
}

/** Shared display projection for final saves, autosaves and speaker-name rewrites. Language-switch
 * marker paragraphs deliberately do not match recall.ts's saved-line regex. */
export function formatTranscript(lines: TranscriptLine[]): string {
  return formatTranscriptWithClocks(lines)
}

/** Explicit saved clocks reproduce the original display across timezone and DST changes. */
export function formatTranscriptWithClocks(lines: TranscriptLine[], clocks?: readonly string[]): string {
  const parts: string[] = []
  let prevLang: string | undefined
  for (const [index, l] of lines.entries()) {
    if (l.lang && prevLang && l.lang !== prevLang) parts.push(`_[conversation switches to ${l.lang}]_`)
    if (l.lang) prevLang = l.lang
    parts.push(formatTranscriptLine(l, clocks?.[index]))
  }
  return parts.join('\n\n')
}
