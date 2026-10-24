import { z } from 'zod'
import { ConnectorAccountHealthSchema, ConnectorAccountRefSchema } from './connector-accounts'

/**
 * Account ambiguity choice card (G62). When an operation could run against more than one connected account and no
 * trusted signal picks one, main does not run it: it issues this card instead. The renderer sees only renderer-safe
 * account views (an opaque ref, a label, a masked hint and the health state) and never the operation's arguments.
 */
export const ACCOUNT_CHOICE_IPC = Object.freeze({
  state: 'connector-account-choice:state',
  current: 'connector-account-choice:current',
  decide: 'connector-account-choice:decide',
  cancel: 'connector-account-choice:cancel'
})

export const AccountChoiceOptionSchema = z
  .object({
    accountRef: ConnectorAccountRefSchema,
    label: z.string().min(1).max(60),
    maskedHint: z.string().max(120).optional(),
    health: ConnectorAccountHealthSchema,
    /** False when the account cannot run this operation right now (it needs attention). Shown, never pickable. */
    selectable: z.boolean(),
    /** Why an account cannot be picked even though it is connected: it is not the signed-in identity. */
    reason: z.enum(['sign_in']).optional()
  })
  .strict()
export type AccountChoiceOption = z.infer<typeof AccountChoiceOptionSchema>

const Hex32 = z.string().regex(/^[a-f0-9]{32}$/)
const Hex64 = z.string().regex(/^[a-f0-9]{64}$/)

export const AccountChoiceStateSchema = z.union([
  z.object({ choiceId: z.null() }).strict(),
  z
    .object({
      choiceId: Hex32,
      nonce: Hex64,
      /** The hash of the exact operation this choice will resume. The renderer echoes it back. */
      argsHash: Hex64,
      expiresAt: z.number().int().nonnegative(),
      title: z.string().min(1).max(120),
      detail: z.string().min(1).max(300),
      options: z.array(AccountChoiceOptionSchema).min(2).max(50)
    })
    .strict()
])
export type AccountChoiceState = z.infer<typeof AccountChoiceStateSchema>
export type AccountChoiceCard = Exclude<AccountChoiceState, { choiceId: null }>

export const AccountChoiceDecisionSchema = z
  .object({ choiceId: Hex32, nonce: Hex64, argsHash: Hex64, accountRef: ConnectorAccountRefSchema })
  .strict()
export type AccountChoiceDecision = z.infer<typeof AccountChoiceDecisionSchema>

export const AccountChoiceCancellationSchema = z.object({ choiceId: Hex32, nonce: Hex64 }).strict()
export type AccountChoiceCancellation = z.infer<typeof AccountChoiceCancellationSchema>

export const ACCOUNT_CHOICE_REFUSALS = [
  'auth_required',
  'invalid_input',
  'missing',
  'owner_mismatch',
  'nonce_mismatch',
  'args_mismatch',
  'not_offered',
  'expired',
  'too_soon',
  'stale'
] as const

/** What running the chosen operation came to, in the shape the Outlook write buttons already understand. */
export const AccountChoiceRunResultSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().max(400).optional(),
    needsConsent: z.boolean().optional(),
    id: z.string().max(200).optional()
  })
  .strict()
export type AccountChoiceRunResult = z.infer<typeof AccountChoiceRunResultSchema>

export const AccountChoiceDecisionResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: AccountChoiceRunResultSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(ACCOUNT_CHOICE_REFUSALS) }).strict()
])
export type AccountChoiceDecisionResponse = z.infer<typeof AccountChoiceDecisionResponseSchema>

export const AccountChoiceCancelResponseSchema = z.object({ ok: z.boolean() }).strict()
