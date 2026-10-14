import type { TranscriptLine } from './transcript-line'

/** Main-owned finite limits shared by the codec and its worker transport. */
export interface SpeechProvenanceLimits {
  maxRecords: number
  maxWords: number
  maxFieldBytes: number
  maxRecordBytes: number
  maxPayloadBytes: number
}

export type SpeechDecoded =
  | { ok: false; reason: 'FRAME_AMBIGUOUS' }
  | { ok: true; publicMarkdown: string; status: 'absent' | 'unavailable' }
  | { ok: true; publicMarkdown: string; status: 'valid'; lines: TranscriptLine[]; clocks: string[] }
