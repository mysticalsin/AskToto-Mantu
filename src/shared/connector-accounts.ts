import { z } from 'zod'
import { CONNECTOR_KINDS, type AccountRef, type ConnectorKind } from './connector-catalog'

export const ConnectorAccountRefSchema = z
  .string()
  .regex(/^acct_[A-Za-z0-9_-]{43}$/)
  .transform((value) => value as AccountRef)

export const ConnectorKindSchema = z.enum(CONNECTOR_KINDS)
export const CONNECTOR_ACCOUNT_HEALTH_STATES = [
  'connecting',
  'healthy',
  'degraded',
  'needs_reauth',
  'disconnected'
] as const
export const ConnectorAccountHealthSchema = z.enum(CONNECTOR_ACCOUNT_HEALTH_STATES)
export type ConnectorAccountHealth = z.infer<typeof ConnectorAccountHealthSchema>

export const CONNECTOR_ACCOUNT_HEALTH_SIGNALS = [
  'connect_started',
  'connect_resumed',
  'token_refresh_succeeded',
  'token_refresh_rejected',
  'token_refresh_transient',
  'operation_succeeded',
  'transient_failure',
  'consent_required',
  'user_disconnected',
  'auth_session_ended',
  'connect_timed_out',
  'connect_abandoned'
] as const
export const ConnectorAccountHealthSignalSchema = z.enum(CONNECTOR_ACCOUNT_HEALTH_SIGNALS)
export type ConnectorAccountHealthSignal = z.infer<typeof ConnectorAccountHealthSignalSchema>
export type ConnectorAccountHealthReason = ConnectorAccountHealthSignal

export const CONNECTOR_ONBOARDING_INTERRUPTION_REASONS = ['app_quit', 'sign_out', 'timeout', 'abandoned'] as const
export const ConnectorOnboardingInterruptionSchema = z.enum(CONNECTOR_ONBOARDING_INTERRUPTION_REASONS)
export type ConnectorOnboardingInterruption = z.infer<typeof ConnectorOnboardingInterruptionSchema>

export const ConnectorAccountViewSchema = z
  .object({
    accountRef: ConnectorAccountRefSchema,
    kind: ConnectorKindSchema,
    label: z.string().min(1).max(60),
    maskedHint: z.string().max(120).optional(),
    health: ConnectorAccountHealthSchema,
    reason: ConnectorAccountHealthSignalSchema,
    lastCheckedAt: z.number().int().nonnegative().nullable()
  })
  .strict()
export type ConnectorAccountView = z.infer<typeof ConnectorAccountViewSchema>

export const ConnectorOnboardingFlowViewSchema = z
  .object({
    flowId: z.string().uuid(),
    kind: ConnectorKindSchema,
    label: z.string().min(1).max(60),
    status: z.enum(['pending', 'paused', 'completed', 'abandoned']),
    reason: ConnectorOnboardingInterruptionSchema.optional(),
    accountRef: ConnectorAccountRefSchema.optional(),
    startedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative()
  })
  .strict()
export type ConnectorOnboardingFlowView = z.infer<typeof ConnectorOnboardingFlowViewSchema>

export const ConnectorAccountListPayloadSchema = z.object({}).strict()
export const ConnectorAccountListResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), accounts: z.array(ConnectorAccountViewSchema) }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['auth_required', 'invalid_input']) }).strict()
])
export type ConnectorAccountListResponse = z.infer<typeof ConnectorAccountListResponseSchema>

export const ConnectorOnboardingListPayloadSchema = z.object({}).strict()
export const ConnectorOnboardingListResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), flows: z.array(ConnectorOnboardingFlowViewSchema) }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['auth_required', 'invalid_input']) }).strict()
])
export type ConnectorOnboardingListResponse = z.infer<typeof ConnectorOnboardingListResponseSchema>

export const ConnectorOnboardingBeginPayloadSchema = z
  .object({ kind: ConnectorKindSchema, label: z.string().trim().min(1).max(60) })
  .strict()
export type ConnectorOnboardingBeginPayload = z.infer<typeof ConnectorOnboardingBeginPayloadSchema>

export const ConnectorOnboardingFlowPayloadSchema = z.object({ flowId: z.string().uuid() }).strict()
export const ConnectorOnboardingMutationResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), flow: ConnectorOnboardingFlowViewSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(['auth_required', 'invalid_input', 'flow_not_found', 'flow_expired'])
    })
    .strict()
])
export type ConnectorOnboardingMutationResponse = z.infer<typeof ConnectorOnboardingMutationResponseSchema>

export const CONNECTOR_ACCOUNTS_IPC = Object.freeze({
  list: 'connector-accounts:list',
  listOnboarding: 'connector-accounts:list-onboarding',
  begin: 'connector-accounts:begin',
  resume: 'connector-accounts:resume',
  abandon: 'connector-accounts:abandon'
})

export type ConnectorAccountKind = ConnectorKind
