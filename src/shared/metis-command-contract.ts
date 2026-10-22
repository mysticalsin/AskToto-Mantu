import { z } from 'zod'

/** One lifetime for a proposal everywhere (the runtime and CommandControl). Expiry always cancels; it never confirms. */
export const COMMAND_PROPOSAL_TTL_MS = 12_000
/** With assistive technology on, reading the card and finding its buttons takes longer. */
export const COMMAND_PROPOSAL_TTL_ASSISTIVE_MS = 30_000

export const METIS_COMMAND_RISKS = ['read', 'reversible', 'create', 'send', 'type', 'delete'] as const
export type MetisCommandRisk = (typeof METIS_COMMAND_RISKS)[number]

/**
 * What the confirmation card says. Main builds it from a per-action template and the exact request arguments, never
 * from the transcript. `argument` is the person's own text and is quoted verbatim; `detail` is a fixed sentence.
 */
export type MetisCommandPreview = {
  title: string
  argument?: string
  detail?: string
  /** A verb for the default button ("Create", "Open"), never "OK" or "Confirm". */
  confirmLabel: string
}

/**
 * Renderer-safe command state. It intentionally excludes transcript text and action request data.
 * `argsHash` is the SHA-256 of the exact request the proposal authorizes: the renderer echoes it back on
 * confirmation, so approval is bound to the request and not only to the nonce (ActionGuard, G04). `preview` is
 * the exact consequence main allowlisted for that request; a proposal without one is never published.
 */
export type MetisCommandState =
  | { proposalId: null }
  | {
      proposalId: string
      nonce: string
      argsHash: string
      expiresAt: number
      revision: number
      actionId: string
      risk: MetisCommandRisk
      preview: MetisCommandPreview
      appIconKey?: string
    }

/** Why a command could not start. Honest copy, delivered instead of a card that cannot succeed. */
export const METIS_COMMAND_NOTICE_CODES = [
  'signed_out',
  'meeting_recording',
  'app_missing',
  'automation_denied',
  'accessibility_needed',
  'check_failed'
] as const
export type MetisCommandNoticeCode = (typeof METIS_COMMAND_NOTICE_CODES)[number]
export const METIS_COMMAND_SETTINGS_KINDS = ['automation', 'accessibility'] as const

export const MetisCommandNoticeSchema = z
  .object({
    code: z.enum(METIS_COMMAND_NOTICE_CODES),
    copy: z.string().min(1).max(400),
    settingsKind: z.enum(METIS_COMMAND_SETTINGS_KINDS).optional()
  })
  .strict()
export type MetisCommandNotice = z.infer<typeof MetisCommandNoticeSchema>

export const MetisCommandRecoveryNoticeSchema = z
  .object({ taskId: z.string().min(1).max(200), actionId: z.string().max(100), copy: z.string().min(1).max(400) })
  .strict()
export type MetisCommandRecoveryNotice = z.infer<typeof MetisCommandRecoveryNoticeSchema>

/** Channels for the confirmation card's extras. They live here, not in the shared ipc.ts, which is at its size cap. */
export const COMMAND_CONFIRM_IPC = {
  notice: 'metis-command:notice',
  recoveryNotices: 'metis-command:recovery-notices'
} as const

export const MetisCommandConfirmationSchema = z
  .object({
    proposalId: z.string().regex(/^[a-f0-9]{32}$/),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    argsHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export type MetisCommandConfirmation = z.infer<typeof MetisCommandConfirmationSchema>

/** Cancelling authorizes nothing, so the opaque id and nonce are enough. */
export const MetisCommandCancellationSchema = MetisCommandConfirmationSchema.omit({ argsHash: true })
export type MetisCommandCancellation = z.infer<typeof MetisCommandCancellationSchema>
