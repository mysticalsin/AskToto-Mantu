/**
 * The credential cleanup executor (Métis 2.12 G20, CAP-35 / R092).
 *
 * `runCredentialCleanup(trigger, clearers)` walks the credential inventory (shared/credential-inventory.ts) and
 * runs the clearer of every entry whose action for that trigger is `clear`. Entries marked `keep` are never
 * touched and `archive` is the recovery step's job (store.archiveEncryptedProfile), so the inventory alone decides
 * what a sign-out, an account switch or a reset does. The production clearers live in credential-clearers.ts;
 * this file has no Electron or store imports so the walk is tested in isolation.
 *
 * Rules the executor holds for every clearer:
 *  - one failing clearer never stops the rest, and a missing clearer for a `clear` entry is reported as failed
 *    (a credential added to the inventory without a clearer fails loudly, per credential, in the receipt);
 *  - a clearer shared by several entries runs once;
 *  - the receipt, the audit record and the log carry credential ids and outcomes only, never a value, a path or the
 *    text of an error (an error from a keystore or filesystem can quote what it failed on).
 */
import { credentialsFor, type CredentialId, type CredentialTrigger } from '@shared/credential-inventory'
import { auditLog } from './logger'

/**
 * `refused` means a stored value could not be read to decide what to remove (a denied read). `superseded` means a newer
 * sign-in replaced the session whose end triggered the cleanup, so its files now belong to the new session and were
 * left alone. Neither is a failure of the cleanup itself.
 */
export type CredentialClearOutcome = 'cleared' | 'nothing' | 'failed' | 'refused' | 'superseded'
export type CredentialClearer = () => CredentialClearOutcome | Promise<CredentialClearOutcome>
export type CredentialClearers = Readonly<Partial<Record<CredentialId, CredentialClearer>>>

export interface CredentialCleanupResult {
  readonly credential: CredentialId
  readonly outcome: CredentialClearOutcome
}

export interface CredentialCleanupReceipt {
  readonly trigger: CredentialTrigger
  readonly results: readonly CredentialCleanupResult[]
  /** Count of `failed` results; `refused` is not a failure of the cleanup itself. */
  readonly failed: number
}

/** Credentials the inventory says to clear for this trigger that have no clearer. */
export function missingClearers(clearers: CredentialClearers, trigger: CredentialTrigger): CredentialId[] {
  return credentialsFor(trigger, 'clear')
    .map((entry) => entry.id)
    .filter((id) => !clearers[id])
}

export async function runCredentialCleanup(
  trigger: CredentialTrigger,
  clearers: CredentialClearers
): Promise<CredentialCleanupReceipt> {
  const settled = new Map<CredentialClearer, Promise<CredentialClearOutcome>>()
  const results: CredentialCleanupResult[] = []
  for (const entry of credentialsFor(trigger, 'clear')) {
    const clearer = clearers[entry.id]
    let outcome: CredentialClearOutcome = 'failed'
    if (clearer) {
      let run = settled.get(clearer)
      if (!run) {
        run = Promise.resolve()
          .then(clearer)
          .catch((): CredentialClearOutcome => 'failed')
        settled.set(clearer, run)
      }
      outcome = await run
    }
    results.push({ credential: entry.id, outcome })
  }
  const failed = results.filter((r) => r.outcome === 'failed').length
  auditLog('credential.cleanup', {
    trigger,
    cleared: results.filter((r) => r.outcome === 'cleared').length,
    failed,
    credentials: results.map((r) => `${r.credential}:${r.outcome}`)
  })
  return { trigger, results, failed }
}
