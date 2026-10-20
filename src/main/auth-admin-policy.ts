import { azureFromManagedContent } from './auth-config'
import { readTrustedAdminManaged } from './win-security'

/**
 * MQA-107 — is SSO enforcement imposed by ADMIN-TRUSTED machine policy rather than self-serve Settings?
 * True when the admin-trusted managed-config (readTrustedAdminManaged — the same held-fd, win32
 * admin-trust-gated read used by readManagedAzure/authEnforced) either forces `{ requireAuth: true }`
 * OR supplies a full azure block. This is the ONE case the SignInWall's "Reset Microsoft sign-in setup"
 * escape hatch must refuse: a genuinely IT-locked fleet can never be talked out of enforcement from the
 * UI. The per-user managed-config file and the in-app Settings are deliberately NOT admin-trusted here
 * (both are user-writable), so they never make enforcement un-resettable. Re-exported from auth.ts for auth.test.ts.
 */
export function isAdminManagedEnforced(): boolean {
  const admin = readTrustedAdminManaged()
  if (!admin) return false
  try {
    if (JSON.parse(admin)?.requireAuth === true) return true
  } catch {
    /* malformed admin content — fall through to the azure-block check */
  }
  return !!azureFromManagedContent(admin).clientId
}
