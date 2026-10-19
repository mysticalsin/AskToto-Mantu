import { z } from 'zod'

/** Interactive capture sources compete for one lease. Meeting capture is reserved separately. */
export const INTERACTIVE_INPUT_SOURCES = [
  'wake', 'deliberate-talk', 'push-to-talk', 'application-probe'
] as const

export const InteractiveInputSourceSchema = z.enum(INTERACTIVE_INPUT_SOURCES)
export type InteractiveInputSource = z.infer<typeof InteractiveInputSourceSchema>
export const InputPurposeSchema = z.enum(['conversation', 'dictation', 'command'])
export type InputPurpose = z.infer<typeof InputPurposeSchema>

/** Source, purpose, and activation are separate so PTT can explicitly request command or dictation. */
export const InputSessionStartSchema = z
  .object({
    source: InteractiveInputSourceSchema,
    purpose: InputPurposeSchema,
    activation: z.enum(['ambient', 'explicit'])
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.source === 'wake' || input.source === 'application-probe') !== (input.activation === 'ambient')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: input.source === 'wake' || input.source === 'application-probe'
          ? 'Wake and application probes must be ambient.'
          : 'This source requires explicit activation.'
      })
    }
    if (input.source === 'wake' && input.purpose !== 'conversation') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Wake alone cannot grant command or dictation authority.' })
    }
    if (input.source === 'application-probe' && input.purpose !== 'conversation') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Application probes cannot request command or dictation authority.' })
    }
  })
export type InputSessionStart = z.infer<typeof InputSessionStartSchema>

export const InputSessionStopSchema = z.object({ sessionId: z.string().regex(/^[a-f0-9]{48}$/) }).strict()
export type InputSessionStop = z.infer<typeof InputSessionStopSchema>

/** Public revision snapshot; not a credential. Callers retain it across async work and echo it on start/stop. */
export const InputSessionContextSchema = z.object({
  authSessionGeneration: z.number().int().nonnegative().safe(),
  contextRevision: z.number().int().nonnegative().safe()
}).strict()
export type InputSessionContext = z.infer<typeof InputSessionContextSchema>

export const InputSessionStartRequestSchema = z.object({
  input: InputSessionStartSchema,
  context: InputSessionContextSchema
}).strict()
export type InputSessionStartRequest = z.infer<typeof InputSessionStartRequestSchema>
export const InputSessionStopRequestSchema = z.object({
  sessionId: z.string().regex(/^[a-f0-9]{48}$/),
  context: InputSessionContextSchema
}).strict()
export type InputSessionStopRequest = z.infer<typeof InputSessionStopRequestSchema>
export const InputSessionConfirmRequestSchema = InputSessionStopRequestSchema
export type InputSessionConfirmRequest = z.infer<typeof InputSessionConfirmRequestSchema>

/** Main-owned, renderer-safe lease. It intentionally contains no transcript, device id, or owner identity. */
export const InputSessionLeaseSchema = z
  .object({
    sessionId: z.string().regex(/^[a-f0-9]{48}$/),
    source: InteractiveInputSourceSchema,
    purpose: InputPurposeSchema,
    activation: z.enum(['ambient', 'explicit']),
    authSessionGeneration: z.number().int().nonnegative().safe(),
    contextRevision: z.number().int().nonnegative().safe(),
    revision: z.number().int().positive().safe(),
    startedAt: z.number().finite(),
    actionAuthority: z.boolean()
  })
  .strict()
export type InputSessionLease = z.infer<typeof InputSessionLeaseSchema>

export const InputSessionFailureReasonSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'busy',
  'meeting_reserved',
  'window_hidden',
  'stale_session',
  'shutdown'
])
export type InputSessionFailureReason = z.infer<typeof InputSessionFailureReasonSchema>

export type InputSessionResult =
  | { ok: true; lease: InputSessionLease }
  | { ok: false; reason: InputSessionFailureReason }

export type InputSessionStopResult = { ok: true } | { ok: false; reason: InputSessionFailureReason }

export const InputSessionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), lease: InputSessionLeaseSchema }).strict(),
  z.object({ ok: z.literal(false), reason: InputSessionFailureReasonSchema }).strict()
])
export const InputSessionStopResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: InputSessionFailureReasonSchema }).strict()
])

export const INPUT_SESSION_STOP_REASONS = [
  'user-stop',
  'cancelled',
  'owner-replaced',
  'window-hidden',
  'auth-revoked',
  'sign-out',
  'device-change',
  'system-suspend',
  'screen-locked',
  'shutdown'
] as const
export const InputSessionStopReasonSchema = z.enum(INPUT_SESSION_STOP_REASONS)
export type InputSessionStopReason = z.infer<typeof InputSessionStopReasonSchema>

/** Main-to-renderer notice for synchronously releasing resources owned by one revoked lease. */
export const InputSessionRevokedSchema = z.object({
  sessionId: z.string().regex(/^[a-f0-9]{48}$/),
  revision: z.number().int().positive().safe(),
  reason: InputSessionStopReasonSchema
}).strict()
export type InputSessionRevoked = z.infer<typeof InputSessionRevokedSchema>

export const MeetingMicCaptureGrantSchema = z.object({
  captureId: z.string().uuid(),
  startedAt: z.number().int().positive().safe()
}).strict()
export type MeetingMicCaptureGrant = z.infer<typeof MeetingMicCaptureGrantSchema>
export const MeetingMicCaptureConfirmRequestSchema = z.object({
  captureId: z.string().uuid(),
  startedAt: z.number().int().positive().safe()
}).strict()
export const MeetingMicCaptureReleaseRequestSchema = z.object({ captureId: z.string().uuid() }).strict()
export const MeetingMicCaptureRevokedSchema = z.object({
  captureId: z.string().uuid().optional(),
  startedAt: z.number().int().positive().safe(),
  reason: InputSessionStopReasonSchema
}).strict()
export type MeetingMicCaptureRevoked = z.infer<typeof MeetingMicCaptureRevokedSchema>

/** Only the owner binding that main derives from the IPC sender is trusted. */
export interface TrustedInputOwner {
  readonly webContentsId: number
  readonly frameId: string
  readonly isTopFrame: boolean
  readonly authSessionGeneration: number
  readonly contextRevision: number
}

