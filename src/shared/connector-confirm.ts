import { z } from 'zod'
import { CONNECTOR_EFFECT_CLASSES } from './connector-effects'

/**
 * Connector confirm card (G64). Every connector write (Outlook, MCP) waits for this card. Main mints the card's own
 * proposal id, which becomes the ActionGuard approval. The renderer sees a summary, the account label and the verified
 * recipients, never the arguments, and echoes the ids back with a yes or a no.
 */
export const CONNECTOR_CONFIRM_IPC = Object.freeze({
  state: 'connector-confirm:state',
  current: 'connector-confirm:current',
  decide: 'connector-confirm:decide',
  cancel: 'connector-confirm:cancel'
})

const Hex32 = z.string().regex(/^[a-f0-9]{32}$/)
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/)

export const ConnectorConfirmStateSchema = z.union([
  z.object({ proposalId: z.null() }).strict(),
  z
    .object({
      proposalId: Hex32,
      nonce: Hex64,
      argsHash: Hex64,
      summary: z.string().min(1).max(200),
      connectorLabel: z.string().min(1).max(60),
      accountLabel: z.string().min(1).max(60).optional(),
      maskedHint: z.string().max(120).optional(),
      effectClass: z.enum(CONNECTOR_EFFECT_CLASSES),
      subjectPreview: z.string().max(80).optional(),
      /** Verified recipients only: addresses main matched against trusted state. */
      recipients: z
        .array(z.object({ address: z.string().min(3).max(254), source: z.string().min(1).max(40) }).strict())
        .max(50)
        .optional(),
      expiresAt: z.number().int().nonnegative()
    })
    .strict()
])
export type ConnectorConfirmState = z.infer<typeof ConnectorConfirmStateSchema>
export type ConnectorConfirmCard = Exclude<ConnectorConfirmState, { proposalId: null }>

export const ConnectorConfirmDecisionSchema = z
  .object({ proposalId: Hex32, nonce: Hex64, argsHash: Hex64, confirm: z.boolean() })
  .strict()
export type ConnectorConfirmDecision = z.infer<typeof ConnectorConfirmDecisionSchema>

export const ConnectorConfirmCancellationSchema = z.object({ proposalId: Hex32, nonce: Hex64 }).strict()
export type ConnectorConfirmCancellation = z.infer<typeof ConnectorConfirmCancellationSchema>

export const CONNECTOR_CONFIRM_REFUSALS = [
  'auth_required',
  'invalid_input',
  'missing',
  'owner_mismatch',
  'nonce_mismatch',
  'args_mismatch',
  'already_decided',
  'expired',
  'too_soon',
  'stale'
] as const

export const ConnectorConfirmDecisionResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(CONNECTOR_CONFIRM_REFUSALS) }).strict()
])
export type ConnectorConfirmDecisionResponse = z.infer<typeof ConnectorConfirmDecisionResponseSchema>

export const ConnectorConfirmCancelResponseSchema = z.object({ ok: z.boolean() }).strict()
