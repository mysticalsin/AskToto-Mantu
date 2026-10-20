import { z } from 'zod'
import { PrivacyClassSchema } from './privacy-class'

export const CONTRACT_AUDIT_EVENTS = [
  'ipc.refused',
  'dig_up.recall.query',
  'dig_up.index.update',
  'dig_up.index.delete',
  'dig_up.capture',
  'dig_up.explain.dispatch',
  'component.acquire',
  'component.verify'
] as const

export const ContractAuditEventNameSchema = z.enum(CONTRACT_AUDIT_EVENTS)
export type ContractAuditEventName = z.infer<typeof ContractAuditEventNameSchema>

export const AuditOutcomeSchema = z.enum(['allowed', 'refused', 'failed'])
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>

/** Audit records are content-free, so only P0 and P1 are representable. */
export const AuditPrivacyClassSchema = PrivacyClassSchema.extract(['P0', 'P1'])

export const AuditEventRecordSchema = z
  .object({
    v: z.literal(1),
    event: ContractAuditEventNameSchema,
    ownerKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    sessionId: z.string().uuid().nullable(),
    surface: z.string().regex(/^[a-zA-Z][a-zA-Z0-9.]{0,63}$/),
    outcome: AuditOutcomeSchema,
    // An enum-like token, never free text.
    reason: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    privacyClass: AuditPrivacyClassSchema,
    ts: z.number().int().positive().safe()
  })
  .strict()
export type AuditEventRecord = z.infer<typeof AuditEventRecordSchema>
