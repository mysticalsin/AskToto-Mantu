import { z } from 'zod'

/**
 * Renderer-safe command state. It intentionally excludes transcript text and action request data.
 * `argsHash` is the SHA-256 of the exact request the proposal authorizes: the renderer echoes it back on
 * confirmation, so approval is bound to the request and not only to the nonce (ActionGuard, G04).
 */
export type MetisCommandState =
  | { proposalId: null }
  | { proposalId: string; nonce: string; argsHash: string; expiresAt: number; revision: number }

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
