/**
 * Métis 2.0 Cap 2 — register command-session IPC + singleton runtime.
 * Keeps index.ts thin. Pack HOLD. OAuth LAST.
 */

import { resolveOperatorBaseUrl, resolveOperatorCredential } from '@shared/operator'
import { createMetisCommandRuntime, type MetisCommandRuntime } from './metis-command-runtime'
import type { PublicSettings } from '@shared/ipc'

let runtime: MetisCommandRuntime | null = null

export function getMetisCommandRuntime(): MetisCommandRuntime | null {
  return runtime
}

export function ensureMetisCommandRuntime(opts: {
  getSettings: () => PublicSettings | { operatorUrl?: string; operatorLicenseToken?: string; operatorIngestSecret?: string }
  /** Optional: decisionProviders.jev from last heartbeat (Cap1). Default false = deterministic only. */
  jevEnabled?: () => boolean
}): MetisCommandRuntime {
  if (runtime) return runtime
  runtime = createMetisCommandRuntime({
    // There is intentionally no renderer event in v1.9.5. A future capability must supply a
    // main-owned capture and an explicit UI confirmation boundary before this runtime is registered.
    onState: () => {},
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

/** Reserved for a future main-owned capture capability; no renderer path calls this in v1.9.5. */
export function ingestMetisCommandFromAsr(text: string): void {
  if (!runtime || !text.trim()) return
  runtime.ingestTranscript(text, 'command')
}
