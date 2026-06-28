import { app, shell, safeStorage } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthStatus, SignInResult } from '@shared/ipc'
import { getSettings } from './store'
import { auditLog } from './logger'

/**
 * Azure AD (Microsoft Entra) sign-in gate.
 *
 * Goal (per Tony): AskToto can only be used by someone signed in with a Mantu Microsoft account, so
 * usage is attributable and tied to the user's Dust identity. Sign-in is locked to the org tenant AND
 * the allowed email domain.
 *
 * Activation needs an Entra app registration ("Mobile and desktop applications" platform, redirect
 * `http://localhost`). Provide via env / managed-config:
 *   AZURE_CLIENT_ID        — Entra application (client) ID
 *   AZURE_TENANT_ID        — Mantu tenant ID (locks sign-in to the org)
 *   ASKTOTO_ALLOWED_DOMAIN — e.g. "mantu.com" (rejects accounts outside the domain)
 *
 * Until those are set, signIn() reports configured:false and the app proceeds (dev/single-user).
 * The validated identity is persisted (encrypted) so sign-in survives restarts.
 */

interface AzureConfig {
  clientId: string
  tenantId: string
  allowedDomain: string
}
interface Session {
  email: string
  name?: string
  domain: string
  tid: string
  at: number
}

/** Machine-wide org-policy file IT can deploy (matches store.ts adminManagedPath). */
function adminManagedPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/AskToto/managed-config.json'
  if (process.platform === 'win32')
    return join(process.env.ProgramData || 'C:\\ProgramData', 'AskToto', 'managed-config.json')
  return '/etc/asktoto/managed-config.json'
}

/** Read an { azure: { clientId, tenantId, allowedDomain } } block from managed-config (admin or per-user). */
function readManagedAzure(): Partial<AzureConfig> {
  // Admin/machine policy FIRST so a user-writable per-user file can't override the org tenant lock.
  for (const p of [adminManagedPath(), join(app.getPath('userData'), 'managed-config.json')]) {
    try {
      const az = JSON.parse(readFileSync(p, 'utf8'))?.azure
      if (az?.clientId && az?.tenantId && az?.allowedDomain) {
        return { clientId: az.clientId, tenantId: az.tenantId, allowedDomain: az.allowedDomain }
      }
    } catch {
      /* not present / unreadable */
    }
  }
  return {}
}

/**
 * Azure SSO config set by an admin in the in-app Settings (About → Account). These are public
 * identifiers (no secret), so storing them in settings is safe. Lowest precedence — a machine-wide
 * managed-config overrides them, so IT can hard-lock the org tenant without the UI loosening it.
 */
function readSettingsAzure(): Partial<AzureConfig> {
  try {
    const s = getSettings()
    const clientId = (s.azureClientId || '').trim()
    const tenantId = (s.azureTenantId || '').trim()
    const allowedDomain = (s.azureAllowedDomain || '').trim().replace(/^@/, '')
    if (clientId && tenantId && allowedDomain) return { clientId, tenantId, allowedDomain }
  } catch {
    /* settings unreadable — fall through to not-configured */
  }
  return {}
}

/**
 * Config resolved by precedence: env (dev) → machine-wide managed-config (IT policy) → per-user
 * managed-config → in-app Settings. Env/managed win so an org deployment can't be loosened from the UI;
 * the Settings fallback makes SSO self-serve (dummy-proof) when no policy file is deployed.
 */
function readConfig(): AzureConfig | null {
  const clientId = process.env.AZURE_CLIENT_ID
  const tenantId = process.env.AZURE_TENANT_ID
  const allowedDomain = process.env.ASKTOTO_ALLOWED_DOMAIN
  if (clientId && tenantId && allowedDomain) return { clientId, tenantId, allowedDomain }
  const m = readManagedAzure()
  if (m.clientId && m.tenantId && m.allowedDomain) {
    return { clientId: m.clientId, tenantId: m.tenantId, allowedDomain: m.allowedDomain }
  }
  const s = readSettingsAzure()
  if (s.clientId && s.tenantId && s.allowedDomain) {
    return { clientId: s.clientId, tenantId: s.tenantId, allowedDomain: s.allowedDomain }
  }
  return null
}

function sessionPath(): string {
  return join(app.getPath('userData'), 'auth-session.bin')
}

let session: Session | null = null
let loaded = false

/**
 * Max age a locally-cached session is trusted before fresh interactive sign-in is required. The
 * persisted auth-session.bin is a CACHE, not the authority — past this age it's dropped on read.
 */
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
/** Cadence of the background session re-validation sweep. */
const REVALIDATE_INTERVAL_MS = 30 * 60 * 1000 // 30 min

let revalidationTimer: ReturnType<typeof setInterval> | null = null

/** Drop the current session from memory AND disk (mirrors the stale-domain / sign-out clear path). */
function clearSession(): void {
  session = null
  try {
    if (existsSync(sessionPath())) rmSync(sessionPath())
  } catch {
    /* best-effort */
  }
}

/**
 * Why a cached session should no longer be trusted, or null if it's still valid. Validity = within the
 * max local age AND (when SSO is configured) still matching the allowed domain. Anything past these
 * bounds forces fresh interactive sign-in.
 */
function expiryReason(s: Session, cfg: AzureConfig | null): 'max_age' | 'domain' | null {
  if (typeof s.at !== 'number' || Date.now() - s.at > MAX_SESSION_AGE_MS) return 'max_age'
  if (cfg && s.domain !== cfg.allowedDomain) return 'domain'
  return null
}

/**
 * Post-startup + periodic re-validation. The sign-in flow uses an ephemeral PublicClientApplication
 * with no persisted MSAL token cache, so there's no cached account to acquireTokenSilent against;
 * re-validation is therefore a re-check of max local age + config-domain match, clearing (memory +
 * disk) and auditing on violation. If a persisted MSAL cache is wired later, add the silent-refresh
 * call here and emit auditLog('auth.refresh_failed', {}) on its failure.
 */
function revalidateSession(): void {
  loadSession()
  if (!session) return
  const reason = expiryReason(session, readConfig())
  if (reason) {
    clearSession()
    auditLog('auth.expired', { reason })
  }
}

/** Stop the background re-validation timer (teardown hook). */
function stopRevalidationTimer(): void {
  if (revalidationTimer) {
    clearInterval(revalidationTimer)
    revalidationTimer = null
  }
}

/** Start the re-validation timer exactly once: a kick shortly after startup, then every interval. */
function ensureRevalidationTimer(): void {
  if (revalidationTimer) return
  const sweep = (): void => {
    try {
      revalidateSession()
    } catch {
      /* re-validation is best-effort */
    }
  }
  const kick = setTimeout(sweep, 10_000)
  if (typeof kick.unref === 'function') kick.unref()
  revalidationTimer = setInterval(sweep, REVALIDATE_INTERVAL_MS)
  if (typeof revalidationTimer.unref === 'function') revalidationTimer.unref()
  // Clear the interval on app quit so it doesn't outlive the process.
  try {
    app.on('will-quit', stopRevalidationTimer)
  } catch {
    /* app may be unavailable (e.g. tests) */
  }
}

function loadSession(): void {
  if (loaded) return
  loaded = true
  // Only ever trust an ENCRYPTED session file. If safeStorage is unavailable we never wrote one (saveSession
  // keeps the identity in memory), and a plaintext auth-session.bin would be forgeable — refuse to read it.
  if (!safeStorage.isEncryptionAvailable()) {
    session = null
    return
  }
  try {
    const buf = readFileSync(sessionPath())
    session = JSON.parse(safeStorage.decryptString(buf)) as Session
  } catch {
    session = null
  }
  // Treat the file as a CACHE: a session past the max local age is evicted on read (memory + disk),
  // forcing fresh interactive sign-in. (Config-domain re-validation needs cfg and runs in authStatus.)
  if (session && (typeof session.at !== 'number' || Date.now() - session.at > MAX_SESSION_AGE_MS)) {
    clearSession()
    auditLog('auth.expired', { reason: 'max_age' })
  }
}

function saveSession(s: Session): void {
  session = s
  // Persist the identity ONLY when we can encrypt it; otherwise keep it in memory for this run rather than
  // writing a forgeable plaintext session to disk. (Sign-in then re-prompts on next launch — the safe trade.)
  if (!safeStorage.isEncryptionAvailable()) return
  try {
    writeFileSync(sessionPath(), safeStorage.encryptString(JSON.stringify(s)), { mode: 0o600 })
  } catch {
    /* in-memory only if write fails */
  }
}

export function authStatus(): AuthStatus {
  loadSession()
  const cfg = readConfig()
  // The persisted session is a CACHE, not the authority. Drop it — from memory AND disk — once it
  // exceeds the max local age OR (config changed) no longer matches the allowed domain, so a stale
  // session can't linger in auth-session.bin past the `loaded` latch. This also catches a session
  // that crosses the max-age boundary mid-run (loadSession only runs once).
  if (session) {
    const reason = expiryReason(session, cfg)
    if (reason) {
      clearSession()
      auditLog('auth.expired', { reason })
    }
  }
  // Bootstrap the background re-validation sweep on first status check (idempotent).
  ensureRevalidationTimer()
  return {
    configured: !!cfg,
    signedIn: !!session,
    email: session?.email,
    name: session?.name,
    domain: cfg?.allowedDomain
  }
}

/** Org override: when set, privileged IPC is blocked until the user signs in, even if SSO is unconfigured. */
function authEnforced(): boolean {
  if (/^(1|true|yes)$/i.test(process.env.ASKTOTO_REQUIRE_AUTH || '')) return true
  // Machine-wide managed-config can also force it: { "requireAuth": true }.
  for (const p of [adminManagedPath(), join(app.getPath('userData'), 'managed-config.json')]) {
    try {
      if (JSON.parse(readFileSync(p, 'utf8'))?.requireAuth === true) return true
    } catch {
      /* not present */
    }
  }
  return false
}

/**
 * The trust boundary is the MAIN process, not the renderer. Every privileged IPC handler must call
 * this — a renderer-only gate (the SignInWall) is bypassable via DevTools or a renderer compromise.
 * Default: returns true when sign-in isn't enforced (SSO unconfigured) OR the user is signed in.
 * Fail-closed: with ASKTOTO_REQUIRE_AUTH (env or managed-config), require a signed-in session always.
 */
export function requireAuth(): boolean {
  const s = authStatus()
  if (authEnforced()) return s.signedIn
  return !s.configured || s.signedIn
}

export async function signIn(): Promise<SignInResult> {
  const cfg = readConfig()
  if (!cfg) return { ok: true, configured: false } // not configured — let the user proceed

  try {
    // Lazy-load MSAL so it's only pulled when Azure SSO is actually configured.
    const { PublicClientApplication, CryptoProvider } = await import('@azure/msal-node')
    const pca = new PublicClientApplication({
      auth: {
        clientId: cfg.clientId,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`
      }
    })
    const crypto = new CryptoProvider()
    const { verifier, challenge } = await crypto.generatePkceCodes()

    const SCOPES = ['User.Read', 'openid', 'profile', 'email']
    const captured = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = ''
      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const c = url.searchParams.get('code')
        const err = url.searchParams.get('error_description') || url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body style="font-family:system-ui;background:#1a0033;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>AskToto</h2><p>${c ? 'Signed in — you can close this window.' : 'Sign-in failed.'}</p></div></body></html>`
        )
        clearTimeout(timer)
        server.close()
        if (c) resolve({ code: c, redirectUri })
        else reject(new Error(err || 'No authorization code returned.'))
      })
      server.on('error', reject)
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('Sign-in timed out.'))
      }, 300000)
      server.listen(0, '127.0.0.1', async () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        redirectUri = `http://localhost:${port}`
        try {
          const authUrl = await pca.getAuthCodeUrl({
            scopes: SCOPES,
            redirectUri,
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
            prompt: 'select_account'
          })
          await shell.openExternal(authUrl)
        } catch (e) {
          clearTimeout(timer)
          server.close()
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    })

    const result = await pca.acquireTokenByCode({
      code: captured.code,
      scopes: SCOPES,
      redirectUri: captured.redirectUri,
      codeVerifier: verifier
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claims = (result.idTokenClaims || {}) as any
    const email = (result.account?.username || claims.preferred_username || claims.email || '').toLowerCase()
    const tid = claims.tid || ''

    if (tid !== cfg.tenantId) {
      auditLog('auth.denied', { domain: cfg.allowedDomain })
      return { ok: false, configured: true, error: 'That account is outside your organization.' }
    }
    if (!email.endsWith(`@${cfg.allowedDomain.toLowerCase()}`)) {
      auditLog('auth.denied', { domain: cfg.allowedDomain })
      return { ok: false, configured: true, error: `Use your @${cfg.allowedDomain} account.` }
    }

    saveSession({
      email,
      name: result.account?.name,
      domain: cfg.allowedDomain,
      tid,
      at: Date.now()
    })
    auditLog('auth.signin', { domain: cfg.allowedDomain })
    return { ok: true, configured: true, email }
  } catch (e) {
    return { ok: false, configured: true, error: e instanceof Error ? e.message : String(e) }
  }
}

export function signOut(): void {
  clearSession()
  auditLog('auth.signout')
}
