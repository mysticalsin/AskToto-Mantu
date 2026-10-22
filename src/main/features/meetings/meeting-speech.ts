import type { TranscriptLine } from '@shared/transcript-line'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { formatTranscript } from './transcript-format'
import type { MeetingSpeechPersistenceService, MeetingSpeechTimingName } from '../../infra/process/meeting-speech-host'
import {
  decryptMeetingEnvelopeInline,
  encryptMeetingEnvelopeInline,
  rewrapMeetingEnvelopeInline
} from './meeting-envelope-codec'
import {
  decodeMeetingSpeech,
  encodeSpeechTranscript,
  projectMeetingSpeech,
  rewriteSpeechTranscript
} from './speech-provenance'

let trustedBudget: Readonly<SpeechProvenanceLimits> | undefined
let persistence: MeetingSpeechPersistenceService | undefined
let trustedReadLimitBytes: number | undefined

/** Installed by main after its trusted policy snapshot is available; null closes async provenance work. */
export function configureMeetingSpeechPersistence(service: MeetingSpeechPersistenceService | undefined): void {
  persistence = service
}

/**
 * Worker failures that only mean "the isolated codec could not take this request"; the inline codec produces the
 * same bytes, so the caller falls back to it. RESOURCE_LIMIT is a real refusal and is never retried inline.
 */
const INLINE_FALLBACK_CODES: ReadonlySet<string> = new Set(['UNCONFIGURED', 'QUEUE_FULL', 'CANCELLED', 'WORKER_FAILED'])

function canFallBackInline(error: unknown): boolean {
  return error instanceof Error && INLINE_FALLBACK_CODES.has(error.name)
}

/** Runs `viaWorker` when a service is configured, else (or on a fallback-class failure) `inline` on main. */
async function workerOrInline<T>(
  viaWorker: (service: MeetingSpeechPersistenceService) => Promise<T>,
  inline: () => T
): Promise<T> {
  const service = persistence
  if (!service) return inline()
  try {
    return await viaWorker(service)
  } catch (error) {
    if (canFallBackInline(error)) return inline()
    throw error
  }
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
    return persistence?.readLimitBytes() ?? trustedReadLimitBytes ?? trustedBudget?.maxPayloadBytes
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
  if (!limits) trustedReadLimitBytes = undefined
}

/** Main-owned physical read cap for saved meeting files, installed with the budget by the speech policy. */
export function configureMeetingSpeechReadLimitBytes(bytes: number | undefined): void {
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes <= 0))
    throw new Error('Speech read limit is invalid.')
  trustedReadLimitBytes = bytes
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
  const budget = trustedBudget
  if (!budget) return Promise.reject(new Error('Speech metadata could not be retained.'))
  return workerOrInline(
    (service) => service.render(lines),
    () => encodeSpeechTranscript(lines, budget)
  )
}

/** Typed meeting reads use the worker even when the document has no v1 frame. */
export function decodeStoredMeetingSpeechAsync(text: string): Promise<ReturnType<typeof decodeMeetingSpeech>> {
  if (!persistence && !text.includes('metis-speech-'))
    return Promise.resolve({ ok: true, publicMarkdown: text, status: 'absent' })
  return workerOrInline(
    (service) => service.decode(text),
    () => decodeStoredMeetingSpeech(text)
  )
}

export function rewriteStoredSpeechTranscriptAsync(text: string, lines: TranscriptLine[]): Promise<string | null> {
  if (!persistence && !text.includes('metis-speech-')) return Promise.resolve(null)
  return workerOrInline(
    (service) => service.rewrite(text, lines),
    () => rewriteStoredSpeechTranscript(text, lines)
  )
}

export function publicMeetingTextAsync(text: string): Promise<string> {
  if (!persistence && !text.includes('metis-speech-')) return Promise.resolve(text)
  return workerOrInline(
    (service) => service.project(text),
    () => publicMeetingText(text)
  ).catch((error: unknown) => {
    // The message stays generic, but a resource refusal keeps its name so History can tell it (retry later) from
    // bytes that can never project.
    const refused = new Error('Meeting text could not be projected safely.')
    if (error instanceof Error && error.name === 'RESOURCE_LIMIT') refused.name = 'RESOURCE_LIMIT'
    return Promise.reject(refused)
  })
}

export function encryptMeetingEnvelopeAsync(
  content: string,
  contentKey: Uint8Array,
  iv: Uint8Array,
  kLocal: string,
  kEscrow?: string
): Promise<Buffer> {
  return workerOrInline(
    (service) => service.encryptEnvelopeV2(content, contentKey, iv, kLocal, kEscrow),
    () => encryptMeetingEnvelopeInline(content, contentKey, iv, kLocal, kEscrow)
  )
}

export function decryptMeetingEnvelopeAsync(
  envelopeJson: Uint8Array,
  contentKey: Uint8Array,
  kLocal: string
): Promise<string> {
  return workerOrInline(
    (service) => service.decryptEnvelopeV2(envelopeJson, contentKey, kLocal),
    () => decryptMeetingEnvelopeInline(envelopeJson, contentKey, kLocal)
  )
}

export function rewrapMeetingEnvelopeAsync(envelopeJson: Uint8Array, kLocal: string): Promise<Buffer> {
  return workerOrInline(
    (service) => service.rewrapEnvelopeV2(envelopeJson, kLocal),
    () => rewrapMeetingEnvelopeInline(envelopeJson, kLocal)
  )
}
