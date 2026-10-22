/**
 * Métis 2.0 Cap 2 — register command-session IPC + singleton runtime.
 * Keeps index.ts thin. Pack HOLD. OAuth LAST.
 */

import { resolveOperatorBaseUrl } from '@shared/operator'
import { operatorManagedCredential } from './operator-seat'
import { createMetisCommandRuntime, type MetisCommandRuntime } from './metis-command-runtime'
import type { PublicSettings } from '@shared/ipc'
import type { CommandControl } from './command-control'

let runtime: MetisCommandRuntime | null = null

export function getMetisCommandRuntime(): MetisCommandRuntime | null {
  return runtime
}

export function ensureMetisCommandRuntime(opts: {
  getSettings: () =>
    | PublicSettings
    | { operatorUrl?: string; operatorLicenseToken?: string; operatorIngestSecret?: string }
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
        // The runtime can expire, stop, or retract a proposal before CommandControl's
        // own TTL. The old nonce must cease to authorize an action immediately.
        opts.commandControl?.revokeForLifecycleEvent('runtime_proposal_cleared')
        lastProposalId = null
        return
      }
      if (proposal.id === lastProposalId) return
      // Revoke before resolving a replacement owner. A window may disappear
      // between utterances; that must not leave the previous action confirmable.
      opts.commandControl?.revokeForLifecycleEvent('runtime_proposal_replaced')
      lastProposalId = null
      const owner = opts.getCommandOwner?.()
      if (!owner || !opts.commandControl) return
      // Marked before the checks run so a repeat of the same state cannot propose twice, and so a retraction
      // while they run (stillWanted) drops the card instead of showing a stale one.
      lastProposalId = proposal.id
      const proposalId = proposal.id
      opts.commandControl
        .proposeChecked(
          { webContentsId: owner.webContentsId, revision: proposal.utteranceRevision },
          proposal.request,
          { stillWanted: () => lastProposalId === proposalId }
        )
        .then((shown) => {
          // A refused preflight or an unpreviewable action shows no card: forget it so the same words can retry.
          if (shown === null && lastProposalId === proposalId) lastProposalId = null
        })
        .catch(() => {
          if (lastProposalId === proposalId) lastProposalId = null
        })
    },
    jevEnabled: () => opts.jevEnabled?.() === true,
    operatorDecideAuth: () => {
      const s = opts.getSettings()
      const base = resolveOperatorBaseUrl(s)
      const secret = operatorManagedCredential(s)
      if (!base || !secret) return null
      // Seat uses same license/HMAC material as ask/heartbeat — never a TypeSafe key.
      return { baseUrl: base, authorizationHeader: `Bearer ${secret}` }
    }
  })
  return runtime
}
