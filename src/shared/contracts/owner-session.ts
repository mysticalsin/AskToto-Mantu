import { z } from 'zod'

export interface OwnerSessionRef {
  readonly v: 1
  /** HMAC-SHA256 hex, Main-derived, never an email. */
  readonly ownerKey: string
  readonly authGeneration: number
  /** Per sign-in uuid. */
  readonly sessionId: string
  /** processId:routingId */
  readonly frameOwner: `${number}:${number}`
  readonly contextRevision: number
  /** Epoch ms. */
  readonly issuedAt: number
}

/** Opaque, renderer-safe token. */
export type OwnerSessionHandle = string & { readonly __brand: 'OwnerSessionHandle' }

const nonNegativeSafeInt = z.number().int().nonnegative().safe()

const FrameOwnerSchema = z
  .string()
  .regex(/^\d+:\d+$/)
  .refine((value) => value.split(':').every((part) => Number.isSafeInteger(Number(part))), {
    message: 'frameOwner parts must be safe integers'
  })
  .transform((value) => value as `${number}:${number}`)

export const OwnerSessionRefSchema: z.ZodType<OwnerSessionRef, z.ZodTypeDef, unknown> = z
  .object({
    v: z.literal(1),
    ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
    authGeneration: nonNegativeSafeInt,
    sessionId: z.string().uuid(),
    frameOwner: FrameOwnerSchema,
    contextRevision: nonNegativeSafeInt,
    issuedAt: z.number().int().positive().safe()
  })
  .strict()

/**
 * Random base64url token. All-hex strings are refused so a hex ownerKey can never pass as a handle.
 */
export const OwnerSessionHandleSchema: z.ZodType<OwnerSessionHandle, z.ZodTypeDef, unknown> = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,64}$/)
  .refine((value) => !/^[0-9a-fA-F]+$/.test(value), { message: 'handle must not be hex' })
  .transform((value) => value as OwnerSessionHandle)

/** Owner-session IPC channels. Kept out of shared/ipc.ts so that file's FF-04 count does not grow. */
export const OWNER_SESSION_IPC = { status: 'ownerSession:status' } as const

export const OWNER_SESSION_REVOKE_REASONS = [
  'sign-out',
  'auth-changed',
  'renderer-reset',
  'lock-screen',
  'suspend',
  'quit'
] as const
export const OwnerSessionRevokeReasonSchema = z.enum(OWNER_SESSION_REVOKE_REASONS)
export type OwnerSessionRevokeReason = z.infer<typeof OwnerSessionRevokeReasonSchema>

export const OwnerSessionStatusSchema = z
  .object({
    signedIn: z.boolean(),
    handle: OwnerSessionHandleSchema.nullable(),
    authGeneration: nonNegativeSafeInt
  })
  .strict()
  .refine((status) => status.signedIn || status.handle === null, {
    message: 'signed-out status must not carry a handle',
    path: ['handle']
  })
export type OwnerSessionStatus = z.infer<typeof OwnerSessionStatusSchema>
