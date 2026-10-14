import type { TranscriptLine } from '@shared/transcript-line'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { formatTranscript } from './transcript-format'
import type { MeetingSpeechPersistenceService, MeetingSpeechTimingName } from '../../infra/process/meeting-speech-host'
import {
  decodeMeetingSpeech,
  encodeSpeechTranscript,
  projectMeetingSpeech,
  rewriteSpeechTranscript
} from './speech-provenance'

let trustedBudget: Readonly<SpeechProvenanceLimits> | undefined
let persistence: MeetingSpeechPersistenceService | undefined

/** Installed by main after its trusted policy snapshot is available; null closes async provenance work. */
export function configureMeetingSpeechPersistence(service: MeetingSpeechPersistenceService | undefined): void {
  persistence = service
}

function requirePersistence(): MeetingSpeechPersistenceService {
  if (!persistence) throw new Error('Speech persistence is not configured.')
  return persistence
}

export function isMeetingSpeechPersistenceConfigured(): boolean {
  return persistence !== undefined
}

export function reportMeetingSpeechTiming(name: MeetingSpeechTimingName, durationMs: number): void {
  try {
    persistence?.reportTiming(name, durationMs)
  } catch {
    // Timing observers cannot change the persistence outcome.
  }
}

/** Physical maximum for the bounded meetings-gateway read; unavailable until both trusted policies exist. */
export function getMeetingSpeechReadLimitBytes(): number | undefined {
  try {
    return persistence?.readLimitBytes() ?? trustedBudget?.maxPayloadBytes
  } catch {
    return undefined
  }
}

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

/** Read-only view of the existing main-owned budget; worker services must not cache a second copy. */
export function getMeetingSpeechLimits(): Readonly<SpeechProvenanceLimits> | undefined {
  return trustedBudget
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

/** New speech-bearing saves use the isolated codec; legacy unprovenanced transcript formatting is unchanged. */
export function renderMeetingTranscriptAsync(lines: TranscriptLine[]): Promise<string> {
  if (!lines.some((line) => line.speech)) return Promise.resolve(formatTranscript(lines))
  if (!trustedBudget) return Promise.reject(new Error('Speech metadata could not be retained.'))
  return requirePersistence().render(lines)
}

/** Typed meeting reads use the worker even when the document has no v1 frame. */
export function decodeStoredMeetingSpeechAsync(text: string): Promise<ReturnType<typeof decodeMeetingSpeech>> {
  if (!persistence && !text.includes('metis-speech-'))
    return Promise.resolve({ ok: true, publicMarkdown: text, status: 'absent' })
  return requirePersistence().decode(text)
}

export function rewriteStoredSpeechTranscriptAsync(text: string, lines: TranscriptLine[]): Promise<string | null> {
  if (!persistence && !text.includes('metis-speech-')) return Promise.resolve(null)
  return requirePersistence().rewrite(text, lines)
}

export function publicMeetingTextAsync(text: string): Promise<string> {
  if (!persistence && !text.includes('metis-speech-')) return Promise.resolve(text)
  return requirePersistence().project(text)
}

export function encryptMeetingEnvelopeAsync(
  content: string,
  contentKey: Uint8Array,
  iv: Uint8Array,
  kLocal: string,
  kEscrow?: string
): Promise<Buffer> {
  return requirePersistence().encryptEnvelopeV2(content, contentKey, iv, kLocal, kEscrow)
}

export function decryptMeetingEnvelopeAsync(
  envelopeJson: Uint8Array,
  contentKey: Uint8Array,
  kLocal: string
): Promise<string> {
  return requirePersistence().decryptEnvelopeV2(envelopeJson, contentKey, kLocal)
}

export function rewrapMeetingEnvelopeAsync(envelopeJson: Uint8Array, kLocal: string): Promise<Buffer> {
  return requirePersistence().rewrapEnvelopeV2(envelopeJson, kLocal)
}
