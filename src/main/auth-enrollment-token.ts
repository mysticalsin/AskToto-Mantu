/**
 * Entra v2 ID token for zero-config Operator enrolment (O07). The Worker verifies this token against its own
 * tenant, client id and domain allowlist, so the device never names its own tenant. A Graph access token cannot
 * be verified by a third party and is never used here.
 *
 * Bound to the validated, signed-in session account exactly as getGraphToken binds, so a stray cached account
 * can never enrol the device under another identity. Returns null when SSO is unconfigured, nobody is signed
 * in, or the silent refresh fails: the caller keeps queueing and tries again after the next sign-in. The token
 * is never logged and never stored outside the MSAL cache.
 */
import { authStatus, makePca, readConfig } from './auth'

export interface EnrollmentIdToken {
  idToken: string
}

export const ENROLLMENT_ID_TOKEN_SCOPES = ['openid', 'profile', 'email']

export async function getEnrollmentIdToken(): Promise<EnrollmentIdToken | null> {
  const cfg = readConfig()
  if (!cfg) return null
  try {
    const status = authStatus()
    if (!status.signedIn || !status.email) return null
    const pca = await makePca(cfg)
    const accounts = await pca.getTokenCache().getAllAccounts()
    const want = status.email.toLowerCase()
    const account = accounts.find((a) => (a.username || '').toLowerCase() === want)
    if (!account) return null
    // forceRefresh: the Worker accepts only an ID token issued in the last 10 minutes.
    const result = await pca.acquireTokenSilent({ account, scopes: ENROLLMENT_ID_TOKEN_SCOPES, forceRefresh: true })
    return result?.idToken ? { idToken: result.idToken } : null
  } catch {
    return null
  }
}
