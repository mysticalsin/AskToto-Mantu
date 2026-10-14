import { z } from 'zod'
import { CaptureGenerationSchema, TrackSchema, type Track } from '../../../src/shared/contracts/speech'

const SessionIdSchema = z.string().uuid()
const TimestampSchema = z.number().int().positive()
const TrackListSchema = z.array(TrackSchema).min(1).max(2).superRefine((tracks, context) => {
  if (new Set(tracks).size !== tracks.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'tracks must be unique' })
})

const ConsentAttestationSchema = z.object({
  accepted: z.literal(true),
  captureGeneration: CaptureGenerationSchema,
  tracks: TrackListSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema
}).strict()

export const SpeechSessionRequestSchema = z.object({
  operation: z.literal('create-session'),
  captureGeneration: CaptureGenerationSchema,
  tracks: TrackListSchema,
  language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).max(5).optional(),
  consent: ConsentAttestationSchema
}).strict().superRefine((request, context) => {
  if (request.captureGeneration !== request.consent.captureGeneration) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'consent generation must match capture', path: ['consent', 'captureGeneration'] })
  }
  if (request.tracks.length !== request.consent.tracks.length || request.tracks.some((track, index) => track !== request.consent.tracks[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'consent tracks must exactly match requested tracks', path: ['consent', 'tracks'] })
  }
})
export type SpeechSessionRequest = z.infer<typeof SpeechSessionRequestSchema>

export const SpeechCancelRequestSchema = z.object({
  operation: z.literal('cancel-session'),
  sessionId: SessionIdSchema
}).strict()
export type SpeechCancelRequest = z.infer<typeof SpeechCancelRequestSchema>

export type SpeechSafeFailureCode =
  | 'INVALID_REQUEST'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_EXPIRED'
  | 'AUTH_REQUIRED'
  | 'NOT_AUTHORIZED'
  | 'POLICY_UNAVAILABLE'
  | 'ROUTE_NOT_READY'
  | 'PRIVACY_UNVERIFIED'
  | 'TRANSPORT_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'CONCURRENCY_LIMIT'
  | 'BUDGET_LIMIT'
  | 'SESSION_NOT_FOUND'
  | 'GRANT_REJECTED'

/** Diagnostic shape is intentionally content-free and can never carry a grant token. */
export const SpeechFailureSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    'INVALID_REQUEST', 'CONSENT_REQUIRED', 'CONSENT_EXPIRED', 'AUTH_REQUIRED', 'NOT_AUTHORIZED',
    'POLICY_UNAVAILABLE', 'ROUTE_NOT_READY', 'PRIVACY_UNVERIFIED', 'TRANSPORT_UNAVAILABLE',
    'DATABASE_UNAVAILABLE', 'CONCURRENCY_LIMIT', 'BUDGET_LIMIT', 'SESSION_NOT_FOUND', 'GRANT_REJECTED'
  ]),
  error: z.string().max(100)
}).strict()

export type SpeechTrack = Track

export function parseSpeechSessionRequest(value: unknown, now: number):
  | { ok: true; request: SpeechSessionRequest }
  | { ok: false; code: 'INVALID_REQUEST' | 'CONSENT_REQUIRED' | 'CONSENT_EXPIRED' } {
  const parsed = SpeechSessionRequestSchema.safeParse(value)
  if (!parsed.success) {
    const consentMissing = parsed.error.issues.some((issue) => issue.path[0] === 'consent')
    return { ok: false, code: consentMissing ? 'CONSENT_REQUIRED' : 'INVALID_REQUEST' }
  }
  const { issuedAt, expiresAt } = parsed.data.consent
  if (issuedAt > now || expiresAt <= now || expiresAt - issuedAt > 120_000) {
    return { ok: false, code: 'CONSENT_EXPIRED' }
  }
  return { ok: true, request: parsed.data }
}

export async function readSpeechBody(request: Request): Promise<string | null> {
  const contentLength = request.headers.get('content-length')
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > 8_192)) {
    await request.body?.cancel().catch(() => undefined)
    return null
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts: string[] = []
  let bytes = 0
  let complete = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        complete = true
        break
      }
      bytes += chunk.value.byteLength
      if (bytes > 8_192) {
        await reader.cancel().catch(() => undefined)
        complete = true
        return null
      }
      parts.push(decoder.decode(chunk.value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } catch {
    return null
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
