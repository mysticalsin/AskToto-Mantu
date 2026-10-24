import { z } from 'zod'
import { FailureModeSchema } from './component-failure-matrix'

const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.string().regex(/^[0-9a-f]{64}$/)
export const SpeechPackComponentIdSchema = z.enum(['asr.whisper-base-q8', 'asr.parakeet-tdt-0.6b-v3-int8'])
export const SpeechRuntimeComponentIdSchema = z.enum([
  'runtime.asr-whisper-worker',
  'runtime.asr-sherpa-onnx',
  'runtime.speaker-embedding',
  'runtime.llama-server'
])
export const SpeechPackActionReasonSchema = z.enum([
  'invalid-request',
  'disabled',
  'profile-invalid',
  'not-selected',
  'stale-manifest',
  'policy-blocked',
  'busy',
  'not-configured',
  'plan-expired',
  'stale-plan',
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

export const OptionalComponentIdSchema = z.enum(['local-llm', 'whisper', 'parakeet'])
/**
 * One optional on-device component as Settings and the first-hold offer describe it (G11). `presence` is what
 * this install already carries: 'bundled' (a full 1.9.x package ships it), 'installed' (a verified download),
 * 'model-only' (verified weights without a runtime that can run them) or 'absent'. `blockedBy` says why it
 * cannot be offered today; `installable` is true only when an explicit, consented download could complete.
 */
export const OptionalComponentStatusSchema = z
  .object({
    id: OptionalComponentIdSchema,
    label: z.string().min(1).max(80),
    provider: z.string().min(1).max(120),
    sourceHost,
    privacy: z.literal('on-device'),
    privacyNote: z.string().min(1).max(240),
    downloadBytes: byteCount.positive(),
    installedBytes: byteCount.positive(),
    presence: z.enum(['bundled', 'installed', 'model-only', 'absent']),
    blockedBy: z.enum(['runtime-not-published', 'package-invalid', 'package-incompatible']).nullable(),
    /** The live failure, one distinct kind (G87); null when nothing is wrong. `blockedBy` stays for compatibility. */
    failure: FailureModeSchema.nullable(),
    installable: z.boolean(),
    /** True only when verified optional files are on disk and may be offloaded (G87); never for a bundled component. */
    removable: z.boolean(),
    /** Display only: the descriptor's installed size. The offload receipt carries the measured figure. */
    removableBytes: byteCount,
    offer: z.object({ surface: z.enum(['first-hold', 'settings']), consent: z.literal('required') }).strict()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.installable &&
      (value.blockedBy !== null || value.presence === 'bundled' || value.presence === 'installed')
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['installable'], message: 'Invalid installable state' })
    }
    if (value.removable && (value.presence === 'bundled' || value.presence === 'absent')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['removable'], message: 'Invalid removable state' })
    }
  })

export const SpeechPackSnapshotSchema = z
  .object({
    featureEnabled: z.boolean(),
    profile: z.enum(['full', 'lean', 'development']).nullable(),
    profileError: z.literal('invalid-profile').nullable(),
    selectedEngine: z.enum(['whisper', 'parakeet', 'apple']),
    selectedComponent: SpeechPackComponentIdSchema.nullable(),
    packageProfile: z
      .object({
        status: z.enum(['verified', 'legacy-full', 'development', 'invalid']),
        profile: z.enum(['full', 'lean', 'development']).nullable(),
        identity: identity.nullable(),
        platform: z.enum(['darwin', 'win32']).nullable(),
        arch: z.enum(['arm64', 'x64', 'universal']).nullable(),
        reason: z
          .enum(['profile-invalid', 'profile-mismatch', 'inventory-invalid', 'target-mismatch', 'inventory-missing'])
          .nullable()
      })
      .strict(),
    engineReadiness: z
      .object({
        engine: z.enum(['whisper', 'parakeet', 'apple']),
        state: z.enum([
          'ready',
          'model-needed',
          'runtime-needed',
          'not-configured',
          'incompatible',
          'repair-needed',
          'unavailable'
        ]),
        modelComponentId: SpeechPackComponentIdSchema.nullable(),
        runtimeComponentIds: z.array(SpeechRuntimeComponentIdSchema).max(4)
      })
      .strict(),
    optionalRuntimeReadiness: z
      .object({
        speakerEmbedding: z.enum(['ready', 'not-configured', 'incompatible']),
        localLlm: z.enum(['ready', 'not-configured', 'incompatible'])
      })
      .strict(),
    components: z.array(SpeechPackComponentSnapshotSchema).max(2),
    optionalComponents: z.array(OptionalComponentStatusSchema).max(3).optional(),
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
    if (
      value.optionalComponents &&
      new Set(value.optionalComponents.map((row) => row.id)).size !== value.optionalComponents.length
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['optionalComponents'], message: 'Duplicate component' })
    if (value.selectedComponent && !value.components.some((row) => row.componentId === value.selectedComponent))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: 'Missing selected component' })
    if (value.engineReadiness.engine !== value.selectedEngine)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['engineReadiness'], message: 'Readiness engine mismatch' })
    if (value.engineReadiness.modelComponentId !== expected)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engineReadiness', 'modelComponentId'],
        message: 'Readiness component mismatch'
      })
    if (
      value.progress &&
      !value.components.some(
        (row) =>
          row.componentId === value.progress?.componentId && row.manifestIdentity === value.progress.manifestIdentity
      )
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['progress'], message: 'Unknown progress identity' })
  })

const planComponent = z
  .object({
    componentId: SpeechPackComponentIdSchema,
    manifestIdentity: identity,
    downloadBytes: byteCount.positive(),
    storageBytes: byteCount.positive(),
    license: z.string().min(1).max(120).nullable(),
    sourceHost: sourceHost
  })
  .strict()

export const SpeechPackPlanPreviewRequestSchema = z
  .object({
    componentId: SpeechPackComponentIdSchema,
    manifestIdentity: identity,
    action: z.enum(['install', 'repair']).default('install')
  })
  .strict()
export const SpeechPackPlanPreviewResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      plan: z
        .object({
          planId: z.guid(),
          action: z.enum(['install', 'repair']),
          feature: z.literal('asr'),
          selectedComponent: SpeechPackComponentIdSchema,
          missingComponents: z.array(planComponent).min(1).max(2),
          totalDownloadBytes: byteCount.positive(),
          totalStorageBytes: byteCount.positive(),
          profile: z.enum(['full', 'lean', 'development']),
          profileIdentity: identity.nullable()
        })
        .strict()
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: SpeechPackActionReasonSchema }).strict()
])
export const SpeechPackInstallWithPlanRequestSchema = z
  .object({ planId: z.guid(), action: z.enum(['install', 'repair']) })
  .strict()
export const SpeechPackInstallWithPlanResultSchema = SpeechPackActionResultSchema

export type SpeechPackComponentId = z.infer<typeof SpeechPackComponentIdSchema>
export type SpeechRuntimeComponentId = z.infer<typeof SpeechRuntimeComponentIdSchema>
export type OptionalComponentId = z.infer<typeof OptionalComponentIdSchema>
export type OptionalComponentStatus = z.infer<typeof OptionalComponentStatusSchema>
export type SpeechPackActionReason = z.infer<typeof SpeechPackActionReasonSchema>
export type SpeechPackActionRequest = z.infer<typeof SpeechPackActionRequestSchema>
export type SpeechPackActionResult = z.infer<typeof SpeechPackActionResultSchema>
export type SpeechPackProgress = z.infer<typeof SpeechPackProgressSchema>
export type SpeechPackComponentSnapshot = z.infer<typeof SpeechPackComponentSnapshotSchema>
export type SpeechPackSnapshot = z.infer<typeof SpeechPackSnapshotSchema>
export type SpeechPackPlanPreviewRequest = z.infer<typeof SpeechPackPlanPreviewRequestSchema>
export type SpeechPackPlanPreviewResult = z.infer<typeof SpeechPackPlanPreviewResultSchema>
export type SpeechPackInstallWithPlanRequest = z.infer<typeof SpeechPackInstallWithPlanRequestSchema>
export type SpeechPackInstallWithPlanResult = z.infer<typeof SpeechPackInstallWithPlanResultSchema>
