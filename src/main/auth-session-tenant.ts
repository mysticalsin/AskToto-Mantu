import type { AccountInfo } from '@azure/msal-node'
import type { AzureConfig } from './auth-config'
import { tenantMatches, type AuthSession } from './auth-session-policy'

/**
 * The verified tenant of the signed-in session (Métis 2.12 G19).
 *
 * A session saved by an earlier build may carry no tenant id. The local memory is partitioned by tenant, so instead of
 * leaving that user without their knowledge until they sign in again, the tenant is read from the MSAL account Main
 * itself cached when it validated that sign-in (`homeAccountId` is `<oid>.<tid>`; the id-token claims carry `tid`).
 * Nothing here comes from the renderer, and a tenant that is not the configured one is refused, as at sign-in.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type CachedAccount = Pick<AccountInfo, 'homeAccountId'> &
  Partial<Pick<AccountInfo, 'tenantId' | 'username' | 'idTokenClaims'>>

export function tenantFromAccount(account: CachedAccount, configuredTenantId: string): string | null {
  const candidates = [account.idTokenClaims?.tid, account.tenantId, account.homeAccountId?.split('.')[1]]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && GUID.test(candidate.trim()) && tenantMatches(candidate, configuredTenantId))
      return candidate.trim().toLowerCase()
  }
  return null
}

export interface SessionTenantResolver {
  /** The session's tenant id, lowercased: its own, or the one derived for this very session; null when unknown. */
  tenantId(): string | null
  /** Derives the tenant of a session that has none from the cached account. Best effort; never rejects. */
  settle(): Promise<void>
}

export function createSessionTenantResolver(deps: {
  session(): AuthSession | null
  config(): AzureConfig | null
  accounts(config: AzureConfig): Promise<CachedAccount[]>
}): SessionTenantResolver {
  let derived: { session: AuthSession; tid: string } | null = null
  return {
    tenantId() {
      const session = deps.session()
      const own = session?.tid?.trim().toLowerCase()
      if (own) return own
      return session && derived?.session === session ? derived.tid : null
    },
    async settle() {
      const session = deps.session()
      if (!session || session.tid?.trim() || derived?.session === session) return
      const config = deps.config()
      if (!config) return
      try {
        const email = session.email.toLowerCase()
        const account = (await deps.accounts(config)).find((a) => (a.username || '').toLowerCase() === email)
        const tid = account ? tenantFromAccount(account, config.tenantId) : null
        if (tid && deps.session() === session) derived = { session, tid }
      } catch {
        // the cache cannot be read: the tenant stays unknown and the memory stays closed
      }
    }
  }
}
