/**
 * Métis 2.0 Cap 2 — register command-session IPC + singleton runtime.
 * Keeps index.ts thin. Pack HOLD. OAuth LAST.
 */

import { resolveOperatorBaseUrl, resolveOperatorCredential } from '@shared/operator'
import { createMetisCommandRuntime, type MetisCommandRuntime } from './metis-command-runtime'
import type { PublicSettings } from '@shared/ipc'
import type { CommandControl } from './command-control'

let runtime: MetisCommandRuntime | null = null

export function getMetisCommandRuntime(): MetisCommandRuntime | null {
  return runtime
}

export function ensureMetisCommandRuntime(opts: {
  getSettings: () => PublicSettings | { operatorUrl?: string; operatorLicenseToken?: string; operatorIngestSecret?: string }
  commandControl?: CommandControl
  getCommandOwner?: () => { webContentsId: number } | null
  /** Optional: decisionProviders.jev from last heartbeat (Cap1). Default false = deterministic only. */
  jevEnabled?: () => boolean
}): MetisCommandRuntime {
  if (runtime) return runtime
  let lastProposalId: string | null = null
  runtime = createMetisCommandRuntime({
    onState: (state) => {
      const proposal = state.proposal
      if (!proposal) {
        lastProposalId = null
        return
      }
      if (proposal.id === lastProposalId) return
      const owner = opts.getCommandOwner?.()
      if (!owner || !opts.commandControl) return
      lastProposalId = proposal.id
      opts.commandControl.propose(
        { webContentsId: owner.webContentsId, revision: proposal.utteranceRevision },
        proposal.request
      )
    },
    jevEnabled: () => opts.jevEnabled?.() === true,
    operatorDecideAuth: () => {
      const s = opts.getSettings()
      const base = resolveOperatorBaseUrl(s)
      const secret = resolveOperatorCredential(s)
      if (!base || !secret) return null
      // Seat uses same license/HMAC material as ask/heartbeat — never a TypeSafe key.
      return { baseUrl: base, authorizationHeader: `Bearer ${secret}` }
    }
  })
  return runtime
}
