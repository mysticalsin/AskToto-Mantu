/**
 * Account-switch detection (Métis 2.12 G20, CAP-35 / R092).
 *
 * Signing out and signing back in as the same person (an expired session, a reboot) must cost them nothing. A
 * different person signing in must not inherit the previous person's pasted keys, seat or tokens. The difference
 * is the owner key: the HMAC the owner-session authority derives from the signed-in identity with a per-install
 * salt, which never contains the identity. The last signed-in owner key is remembered in
 * `<userData>/identity/last-owner-key.v1`; on the next sign-in a different key runs the `accountSwitch` cleanup
 * (credential-cleanup.ts) before anything else uses the profile.
 *
 * The new owner is recorded only after the cleanup finished with no failure, so a clearer that failed (a locked
 * file, a denied keystore) is retried at the next sign-in instead of being forgotten.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { auditLog } from './logger'

export interface AccountSwitchDeps {
  /** The signed-in owner's key, or null while signed out or before the owner-key salt has loaded. */
  currentOwnerKey(): string | null
  readRememberedOwner(): Promise<string | null>
  rememberOwner(ownerKey: string): Promise<void>
  /** Runs the `accountSwitch` cleanup and reports how many clearers failed. */
  cleanup(): Promise<{ failed: number }>
}

export type OwnerReconcileOutcome = 'first-owner' | 'same-owner' | 'switched' | 'switch-incomplete' | 'owner-unknown'

const OWNER_KEY = /^[0-9a-f]{64}$/

/** Never rejects. Audits only a real switch, as an outcome token. */
export async function reconcileSignedInOwner(deps: AccountSwitchDeps): Promise<OwnerReconcileOutcome> {
  try {
    const current = deps.currentOwnerKey()
    if (!current) return 'owner-unknown'
    const previous = await deps.readRememberedOwner()
    if (!previous) {
      await deps.rememberOwner(current)
      return 'first-owner'
    }
    if (previous === current) return 'same-owner'
    let failed = 1
    try {
      failed = (await deps.cleanup()).failed
    } catch {
      failed = 1
    }
    const outcome: OwnerReconcileOutcome = failed === 0 ? 'switched' : 'switch-incomplete'
    if (outcome === 'switched') await deps.rememberOwner(current)
    auditLog('credential.account_switch', { outcome })
    return outcome
  } catch {
    return 'owner-unknown'
  }
}

/** The remembered-owner file. It holds the 64-hex owner key and nothing else: no email, no name. */
export function ownerRecordStore(userDataDir: string): {
  read(): Promise<string | null>
  write(ownerKey: string): Promise<void>
} {
  const dir = join(userDataDir, 'identity')
  const path = join(dir, 'last-owner-key.v1')
  return {
    async read() {
      try {
        const text = (await readFile(path, 'utf8')).trim()
        return OWNER_KEY.test(text) ? text : null
      } catch {
        return null
      }
    },
    async write(ownerKey) {
      if (!OWNER_KEY.test(ownerKey)) throw new Error('not an owner key')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      await writeFile(tmp, ownerKey, { mode: 0o600 })
      await rename(tmp, path)
    }
  }
}
