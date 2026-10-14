import type { TranscriptLine } from '@shared/transcript-line'
import { formatTranscript } from './transcript-format'
import {
  decodeMeetingSpeech,
  encodeSpeechTranscript,
  projectMeetingSpeech,
  rewriteSpeechTranscript,
  type SpeechProvenanceLimits
} from './speech-provenance'

let trustedBudget: Readonly<SpeechProvenanceLimits> | undefined

/** Main owns this configuration; no renderer setting/IPC accepts it. No production default is guessed. */
export function configureMeetingSpeechLimits(limits: SpeechProvenanceLimits | undefined): void {
  const keys = ['maxFieldBytes', 'maxPayloadBytes', 'maxRecordBytes', 'maxRecords', 'maxWords']
  if (
    limits &&
    (Object.keys(limits).sort().join(',') !== keys.join(',') ||
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
  )
    throw new Error('Speech metadata budget is invalid.')
  trustedBudget = limits ? Object.freeze({ ...limits }) : undefined
}

export function renderMeetingTranscript(lines: TranscriptLine[]): string {
  if (!lines.some((line) => line.speech)) return formatTranscript(lines)
  if (!trustedBudget) throw new Error('Speech metadata could not be retained.')
  return encodeSpeechTranscript(lines, trustedBudget)
}

export function decodeStoredMeetingSpeech(text: string): ReturnType<typeof decodeMeetingSpeech> {
  return decodeMeetingSpeech(text, trustedBudget)
}

export function rewriteStoredSpeechTranscript(text: string, lines: TranscriptLine[]): string | null {
  return rewriteSpeechTranscript(text, lines, trustedBudget)
}

/** Public export/search/LLM projection. Internal mutations and explicit Open retain the complete file. */
export function publicMeetingText(text: string): string {
  const projected = projectMeetingSpeech(text)
  if (!projected.ok) throw new Error('Meeting text could not be projected safely.')
  return projected.publicMarkdown
}
