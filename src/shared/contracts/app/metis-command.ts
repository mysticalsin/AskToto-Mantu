import { z } from 'zod'

export type MetisCommandState =
  | { proposalId: null }
  | { proposalId: string; nonce: string; expiresAt: number; revision: number }

export const MetisCommandConfirmationSchema = z
  .object({ proposalId: z.string().regex(/^[a-f0-9]{32}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
export type MetisCommandConfirmation = z.infer<typeof MetisCommandConfirmationSchema>

/** A hotkey main failed to bind (combo already held by another app, or OS-reserved) — IPC.shortcutFailures. */
export interface ShortcutFailure {
  action: string
  accel: string
}
