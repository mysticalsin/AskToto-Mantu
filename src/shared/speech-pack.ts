import { z } from 'zod'

const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.string().regex(/^[0-9a-f]{64}$/)
export const SpeechPackComponentIdSchema = z.enum(['asr.whisper-base-q8', 'asr.parakeet-tdt-0.6b-v3-int8'])
export const SpeechPackActionReasonSchema = z.enum([
  'invalid-request',
  'disabled',
  'profile-invalid',
  'not-selected',
  'stale-manifest',
  'policy-blocked',
  'busy',
  'not-configured',
  'unavailable'
])
export const SpeechPackActionRequestSchema = z
  .object({
    componentId: SpeechPackComponentIdSchema,
    action: z.enum(['download', 'pause', 'cancel', 'retry', 'repair']),
    manifestIdentity: identity
  })
  .strict()
export const SpeechPackActionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: SpeechPackActionReasonSchema }).strict()
])

export const SpeechPackProgressSchema = z
  .object({
    componentId: SpeechPackComponentIdSchema,
    manifestIdentity: identity,
    bytesDone: byteCount,
    bytesTotal: byteCount.positive(),
    state: z.enum(['queued', 'downloading', 'verifying', 'self-testing', 'ready', 'paused', 'error'])
  })
  .strict()
  .refine((value) => value.bytesDone <= value.bytesTotal, { path: ['bytesDone'], message: 'Invalid byte count' })

const sourceHost = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
export const SpeechPackComponentSnapshotSchema = z
  .object({
    componentId: SpeechPackComponentIdSchema,
    manifestIdentity: identity,
    version: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._-]+$/),
    state: z.enum([
      'not-installed',
      'repair-needed',
      'not-configured',
      'queued',
      'downloading',
      'verifying',
      'self-testing',
      'ready',
      'paused',
      'error'
    ]),
    downloadBytes: byteCount.positive(),
    installedBytes: byteCount.positive(),
    sourceHost: sourceHost.nullable(),
    integrity: z.enum(['not-verified', 'prior-activation-and-size-checked', 'freshly-hash-verified-and-self-tested']),
    requiredBytes: byteCount.optional(),
    freeBytes: byteCount.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.sourceHost === null) !== (value.state === 'not-configured')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceHost'], message: 'Invalid source state' })
    }
    if (value.state === 'ready' && value.integrity === 'not-verified') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['integrity'], message: 'Missing activation evidence' })
    }
  })

export const SpeechPackSnapshotSchema = z
  .object({
    featureEnabled: z.boolean(),
    profile: z.enum(['full', 'lean', 'development']).nullable(),
    profileError: z.literal('invalid-profile').nullable(),
    selectedEngine: z.enum(['whisper', 'parakeet', 'apple']),
    selectedComponent: SpeechPackComponentIdSchema.nullable(),
    components: z.array(SpeechPackComponentSnapshotSchema).max(2),
    progress: SpeechPackProgressSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected =
      value.selectedEngine === 'whisper'
        ? 'asr.whisper-base-q8'
        : value.selectedEngine === 'parakeet'
          ? 'asr.parakeet-tdt-0.6b-v3-int8'
          : null
    if (value.selectedComponent !== expected)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selectedComponent'], message: 'Invalid engine selection' })
    if ((value.profile === null) !== (value.profileError === 'invalid-profile'))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profileError'], message: 'Invalid package profile' })
    if (new Set(value.components.map((row) => row.componentId)).size !== value.components.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: 'Duplicate component' })
    if (value.selectedComponent && !value.components.some((row) => row.componentId === value.selectedComponent))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: 'Missing selected component' })
    if (
      value.progress &&
      !value.components.some(
        (row) =>
          row.componentId === value.progress?.componentId && row.manifestIdentity === value.progress.manifestIdentity
      )
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['progress'], message: 'Unknown progress identity' })
  })

export type SpeechPackComponentId = z.infer<typeof SpeechPackComponentIdSchema>
export type SpeechPackActionReason = z.infer<typeof SpeechPackActionReasonSchema>
export type SpeechPackActionRequest = z.infer<typeof SpeechPackActionRequestSchema>
export type SpeechPackActionResult = z.infer<typeof SpeechPackActionResultSchema>
export type SpeechPackProgress = z.infer<typeof SpeechPackProgressSchema>
export type SpeechPackComponentSnapshot = z.infer<typeof SpeechPackComponentSnapshotSchema>
export type SpeechPackSnapshot = z.infer<typeof SpeechPackSnapshotSchema>
