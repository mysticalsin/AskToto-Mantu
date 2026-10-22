import { createHash } from 'node:crypto'
import type { SpeechDecoded, SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { TRANSCRIPT_LINE_KEYS, TranscriptLineSchema, type TranscriptLine } from '@shared/transcript-line'
import { formatTranscriptWithClocks, sanitizeSpeakerName } from './transcript-format'

export type { SpeechDecoded, SpeechProvenanceLimits } from '@shared/meeting-speech-contract'

/** Trusted main-owned budgets. A duration is not a bound on event density; there is no default. */
const PRIVATE_BEGIN = '<!-- metis-speech-provenance:v1 -->'
const PRIVATE_END = '<!-- /metis-speech-provenance -->'
export const SPEECH_TRANSCRIPT_BEGIN = '<!-- metis-speech-transcript:v1 -->'
export const SPEECH_TRANSCRIPT_END = '<!-- /metis-speech-transcript -->'
const FAILURE = 'Speech metadata could not be retained.'
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
function refuse(): never {
  throw new Error(FAILURE)
}

function trustedLimits(limits: SpeechProvenanceLimits): void {
  const keys = ['maxRecords', 'maxWords', 'maxFieldBytes', 'maxRecordBytes', 'maxPayloadBytes'] as const
  if (!limits || keys.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0)) refuse()
}

/** Bound every primitive and structure before schema cloning or serializing a complete record. */
function preflight(value: unknown, limits: SpeechProvenanceLimits, depth = 0, nodes = { count: 0, bytes: 0 }): void {
  const charge = (size: number): void => {
    nodes.bytes += size
    if (nodes.bytes > limits.maxRecordBytes) refuse()
  }
  if (depth > 8 || ++nodes.count > 4096) refuse()
  if (typeof value === 'string') {
    if (bytes(value) > limits.maxFieldBytes) refuse()
    charge(bytes(safeJson(value)))
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse()
    charge(bytes(String(value)))
    return
  }
  if (value === undefined) return
  if (typeof value === 'boolean') {
    charge(value ? 4 : 5)
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 256) refuse()
    charge(2 + Math.max(0, value.length - 1))
    for (const item of value) preflight(item, limits, depth + 1, nodes)
    return
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) refuse()
  const entries = Object.entries(value)
  if (entries.length > 32) refuse()
  charge(2 + Math.max(0, entries.filter(([, item]) => item !== undefined).length - 1))
  for (const [key, item] of entries) {
    if (bytes(key) > 128) refuse()
    if (item !== undefined) charge(bytes(safeJson(key)) + 1)
    preflight(item, limits, depth + 1, nodes)
  }
}

function canonicalLines(input: unknown, limits: SpeechProvenanceLimits): TranscriptLine[] {
  trustedLimits(limits)
  if (!Array.isArray(input) || input.length === 0 || input.length > limits.maxRecords) refuse()
  const identities = new Set<string>()
  const out: TranscriptLine[] = []
  let words = 0
  let encodedBytes = 0
  for (const raw of input) {
    preflight(raw, limits)
    if (!raw || typeof raw !== 'object' || Object.keys(raw).some((key) => !TRANSCRIPT_LINE_KEYS.has(key))) refuse()
    const candidate = raw as TranscriptLine
    if (!Number.isFinite(candidate.t) || Math.abs(candidate.t) > 8.64e15 || candidate.provisional === true) refuse()
    if (candidate.speech) {
      if (candidate.speech.words !== undefined && !Array.isArray(candidate.speech.words)) refuse()
      words += candidate.speech.words?.length ?? 0
      if (words > limits.maxWords) refuse()
    }
    const parsed = TranscriptLineSchema.safeParse(raw)
    if (!parsed.success) refuse()
    const line = parsed.data
    if (line.name !== undefined) line.name = sanitizeSpeakerName(line.name)
    if (line.speech) {
      const event = line.speech
      const identity = [
        event.captureId,
        event.captureGeneration,
        event.segment.stream.track,
        event.segment.stream.epoch,
        event.segment.index
      ].join(':')
      if (identities.has(identity)) refuse()
      identities.add(identity)
    }
    const size = bytes(safeJson(line))
    if (size > limits.maxRecordBytes || (encodedBytes += size) > limits.maxPayloadBytes) refuse()
    out.push(line)
  }
  return out
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

/** Prevent user prose from introducing owned delimiters; structured text remains exact in the frame. */
export function escapeSpeechMarkers(text: string): string {
  return text.replace(/<!--\s*\/?metis-speech-/g, (marker) => '&lt;' + marker.slice(1))
}

export function refuseReservedSpeechProse(...values: string[]): void {
  if (values.some((value) => /<!--\s*\/?metis-speech-/.test(value)))
    throw new Error('Meeting text contains reserved storage syntax.')
}

function displayClock(t: number): string {
  const date = new Date(t)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

export function encodeSpeechTranscript(
  input: TranscriptLine[],
  limits: SpeechProvenanceLimits,
  savedClocks?: readonly string[]
): string {
  try {
    return encodeTranscript(input, limits, savedClocks)
  } catch {
    return refuse()
  }
}

function encodeTranscript(
  input: TranscriptLine[],
  limits: SpeechProvenanceLimits,
  savedClocks?: readonly string[]
): string {
  const lines = canonicalLines(input, limits)
  if (!lines.some((line) => line.speech)) refuse()
  if (savedClocks && (savedClocks.length !== lines.length || savedClocks.some((clock) => !clockPattern.test(clock))))
    refuse()
  const clocks = savedClocks ?? lines.map((line) => displayClock(line.t))
  const transcript = escapeSpeechMarkers(formatTranscriptWithClocks(lines, clocks)).replaceAll('\r\n', '\n')
  const serialized = lines.map((line) => safeJson(line))
  const prefix = `{"version":1,"clocks":${safeJson(clocks)},"lines":[`
  const suffix = `],"transcriptSha256":"${hash(transcript)}"}`
  const total =
    bytes(prefix) + bytes(suffix) + serialized.reduce((n, item) => n + bytes(item), 0) + serialized.length - 1
  if (total > limits.maxPayloadBytes) refuse()
  const payload = prefix + serialized.join(',') + suffix
  return `${SPEECH_TRANSCRIPT_BEGIN}\n${transcript}\n${SPEECH_TRANSCRIPT_END}\n\n${PRIVATE_BEGIN}\n${payload}\n${PRIVATE_END}`
}

export type SpeechProjection = { ok: true; publicMarkdown: string } | { ok: false; reason: 'FRAME_AMBIGUOUS' }
interface Span {
  start: number
  end: number
}
function markers(text: string, pattern: RegExp): Span[] {
  return Array.from(text.matchAll(pattern), (match) => ({ start: match.index!, end: match.index! + match[0].length }))
}
function frame(
  text: string
):
  | { ok: true; normalized: string; begin?: Span; end?: Span; transcriptBegin?: Span; transcriptEnd?: Span }
  | { ok: false; reason: 'FRAME_AMBIGUOUS' } {
  const normalized = text.replaceAll('\r\n', '\n')
  const begin = markers(normalized, /^<!-- metis-speech-provenance:[^\r\n>]* -->$/gm)
  const end = markers(normalized, /^<!-- \/metis-speech-provenance -->$/gm)
  const transcriptBegin = markers(normalized, /^<!-- metis-speech-transcript:v1 -->$/gm)
  const transcriptEnd = markers(normalized, /^<!-- \/metis-speech-transcript -->$/gm)
  const reserved = markers(normalized, /<!--\s*\/?metis-speech-/g)
  if (reserved.length !== begin.length + end.length + transcriptBegin.length + transcriptEnd.length)
    return { ok: false, reason: 'FRAME_AMBIGUOUS' }
  if (
    begin.length > 1 ||
    end.length > 1 ||
    transcriptBegin.length > 1 ||
    transcriptEnd.length > 1 ||
    (end.length && !begin.length) ||
    (begin.length && end.length && begin[0].end >= end[0].start) ||
    transcriptBegin.length !== transcriptEnd.length ||
    (transcriptBegin.length &&
      (transcriptBegin[0].end >= transcriptEnd[0].start || !begin.length || transcriptEnd[0].end > begin[0].start))
  )
    return { ok: false, reason: 'FRAME_AMBIGUOUS' }
  return {
    ok: true,
    normalized,
    begin: begin[0],
    end: end[0],
    transcriptBegin: transcriptBegin[0],
    transcriptEnd: transcriptEnd[0]
  }
}

export function projectMeetingSpeech(text: string): SpeechProjection {
  const located = frame(text)
  if (!located.ok) return located
  if (!located.begin) return { ok: true, publicMarkdown: text }
  const privateEnd = located.end ? located.end.end : located.normalized.length
  let publicMarkdown = located.normalized.slice(0, located.begin.start) + located.normalized.slice(privateEnd)
  if (located.transcriptBegin && located.transcriptEnd)
    publicMarkdown = publicMarkdown
      .replace(SPEECH_TRANSCRIPT_BEGIN + '\n', '')
      .replace('\n' + SPEECH_TRANSCRIPT_END, '')
  return { ok: true, publicMarkdown }
}

export function decodeMeetingSpeech(text: string, limits?: SpeechProvenanceLimits): SpeechDecoded {
  const projected = projectMeetingSpeech(text)
  if (!projected.ok) return projected
  const located = frame(text)
  if (!located.ok) return located
  if (!located.begin) return { ...projected, status: 'absent' }
  const unavailable = { ...projected, status: 'unavailable' as const }
  if (!limits || !located.end || !located.transcriptBegin || !located.transcriptEnd) return unavailable
  try {
    trustedLimits(limits)
    if (located.normalized.slice(located.begin.start, located.begin.end) !== PRIVATE_BEGIN) return unavailable
    const payloadText = located.normalized.slice(located.begin.end, located.end.start).trim()
    if (bytes(payloadText) > limits.maxPayloadBytes) return unavailable
    const payload = JSON.parse(payloadText) as Record<string, unknown>
    if (
      !payload ||
      typeof payload !== 'object' ||
      Object.keys(payload).sort().join(',') !== 'clocks,lines,transcriptSha256,version' ||
      payload.version !== 1 ||
      !Array.isArray(payload.clocks) ||
      !Array.isArray(payload.lines) ||
      payload.clocks.length !== payload.lines.length ||
      payload.clocks.some((clock) => typeof clock !== 'string' || !clockPattern.test(clock)) ||
      typeof payload.transcriptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.transcriptSha256)
    )
      return unavailable
    const lines = canonicalLines(payload.lines, limits)
    if (!lines.some((line) => line.speech)) return unavailable
    const transcript = located.normalized.slice(located.transcriptBegin.end + 1, located.transcriptEnd.start - 1)
    const canonical = escapeSpeechMarkers(formatTranscriptWithClocks(lines, payload.clocks as string[])).replaceAll(
      '\r\n',
      '\n'
    )
    if (canonical !== transcript || hash(transcript) !== payload.transcriptSha256) return unavailable
    return { ...projected, status: 'valid', lines, clocks: payload.clocks as string[] }
  } catch {
    return unavailable
  }
}

/** Replace only the validated owned range; unsupported or edited frames are never silently erased. */
export function rewriteSpeechTranscript(
  text: string,
  lines: TranscriptLine[],
  limits?: SpeechProvenanceLimits
): string | null {
  const located = frame(text)
  if (!located.ok) refuse()
  if (!located.begin) return null
  const decoded = decodeMeetingSpeech(text, limits)
  if (!decoded.ok || decoded.status !== 'valid' || !limits || !located.transcriptBegin || !located.end) refuse()
  const savedClocks = new Map(decoded.lines.map((line, index) => [line.t, decoded.clocks[index]]))
  // Preserve clock evidence for unchanged timestamps. Deliberately new timestamps use current local time.
  const clocks = lines.map((line) => savedClocks.get(line.t) ?? displayClock(line.t))
  const rendered = lines.some((line) => line.speech)
    ? encodeSpeechTranscript(lines, limits, clocks)
    : formatTranscriptWithClocks(lines, clocks)
  return (
    located.normalized.slice(0, located.transcriptBegin.start) + rendered + located.normalized.slice(located.end.end)
  )
}

/** Unrelated append/edit operations must not mistake user speech for an owned document section. */
export function meetingSpeechTailOffset(text: string): number {
  const located = frame(text)
  if (!located.ok || (located.begin && !located.end)) refuse()
  // Callers use the original string; CRLF normalization changes offsets, so search the validated end.
  return located.end ? text.indexOf(PRIVATE_END) + PRIVATE_END.length : 0
}

/** The owned sibling heading directly precedes its frame; spoken headings live inside that frame. */
export function meetingSpeechPrefix(text: string): string | null {
  const located = frame(text)
  if (!located.ok) refuse()
  if (!located.begin) return null
  if (!located.transcriptBegin || !located.end) refuse()
  const before = located.normalized.slice(0, located.transcriptBegin.start)
  const sibling = /(?:^|\n)## Full transcript\n+$/.exec(before)
  if (!sibling) refuse()
  return before.slice(0, sibling.index + (before[sibling.index] === '\n' ? 1 : 0))
}

export function rewriteMeetingSpeechRecap(text: string, recap: string): string | null {
  const prefix = meetingSpeechPrefix(text)
  if (prefix === null) return null
  const normalized = text.replaceAll('\r\n', '\n')
  const tail = normalized.slice(prefix.length)
  const notes = /^## Notes & follow-ups[\n]+/m.exec(prefix)
  const head = notes ? prefix.slice(0, notes.index + notes[0].length) : prefix + '## Notes & follow-ups\n\n'
  return head + escapeSpeechMarkers(recap).trim() + '\n\n' + tail
}
