import { app, shell, safeStorage } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { PublicClientApplication } from '@azure/msal-node'
import type { AuthStatus, SignInResult } from '@shared/ipc'
import { getSettings } from './store'
import { auditLog, mainLog, setAuditActor } from './logger'
import { useFileBackend, encryptSecret, decryptSecret } from './secrets'
import { trustedAdminManagedPath } from './win-security'

// Scopes requested at sign-in: identity + read-only calendar (so the agenda can be pulled later with no
// extra consent prompt). Least privilege — Calendars.Read, never ReadWrite.
const SIGN_IN_SCOPES = ['User.Read', 'Calendars.Read', 'openid', 'profile', 'email']

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

// The machine-wide org-policy path + its win32 admin-trust gate live in win-security.ts. On Windows a
// forged %ProgramData%\AskToto\managed-config.json (user-writable by default) is NOT honored, so it
// cannot redirect SSO to an attacker tenant or force-lock the app.

/** Read an { azure: { clientId, tenantId, allowedDomain } } block from managed-config (admin or per-user). */
function readManagedAzure(): Partial<AzureConfig> {
  // Admin/machine policy FIRST so a user-writable per-user file can't override the org tenant lock.
  const paths = [trustedAdminManagedPath(), join(app.getPath('userData'), 'managed-config.json')].filter(
    (p): p is string => !!p
  )
  for (const p of paths) {
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
 *
 * No side effects here (deliberately): resolving a config value — especially from self-service Settings,
 * which has NO format validation — does not mean SSO is actually usable. The sticky-configured flag is
 * only written by signIn() on a genuine successful interactive sign-in (see writeStickyConfigured call
 * site below); merely typing values into Settings must never trip it, or "Reset SSO" right after would
 * permanently lock the app with no in-app recovery.
 *
 * Lowest-precedence recovery fallback: after a genuine sign-in, the config that actually worked is kept
 * as an LKG record. If Settings is later cleared while enforcement is sticky, LKG keeps sign-in POSSIBLE
 * (so the sticky gate is recoverable, not a brick) — env/managed/Settings all still win above it, and it
 * is only consulted when sticky is set. See the LKG comment block above.
 */
function readConfig(): AzureConfig | null {
  const clientId = process.env.AZURE_CLIENT_ID
  const tenantId = process.env.AZURE_TENANT_ID
  const allowedDomain = process.env.ASKTOTO_ALLOWED_DOMAIN
  if (clientId && tenantId && allowedDomain) {
    return { clientId, tenantId, allowedDomain }
  }
  const m = readManagedAzure()
  if (m.clientId && m.tenantId && m.allowedDomain) {
    return { clientId: m.clientId, tenantId: m.tenantId, allowedDomain: m.allowedDomain }
  }
  const s = readSettingsAzure()
  if (s.clientId && s.tenantId && s.allowedDomain) {
    return { clientId: s.clientId, tenantId: s.tenantId, allowedDomain: s.allowedDomain }
  }
  // Recovery fallback — only after a genuine prior sign-in (sticky set), and only if nothing above
  // resolved. Makes an enforced-but-Settings-cleared device recoverable instead of a permanent brick.
  if (isStickyConfigured()) {
    const l = readLkgConfig()
    if (l.clientId && l.tenantId && l.allowedDomain) {
      return { clientId: l.clientId, tenantId: l.tenantId, allowedDomain: l.allowedDomain }
    }
  }
  return null
}

function sessionPath(): string {
  return join(app.getPath('userData'), 'auth-session.bin')
}

// ─── Sticky-configured flag ───────────────────────────────────────────────────
//
// Written once — by signIn(), only in its SUCCESS branch — the first time an interactive sign-in
// actually completes (a real, validated session is established). This deliberately represents
// "SSO has genuinely been usable", not "some config values were resolved": readConfig() resolving
// self-service Settings fields (which have NO format validation) must NOT trip this flag, or
// enabling+then-resetting SSO without ever signing in would permanently lock the app with no
// in-app recovery.
// requireAuth() treats this flag as "enforced" even if a compromised renderer later clears the
// in-app Settings azure fields (which would otherwise flip configured→false, unlocking the gate).
// Cleared only by a genuine authenticated sign-out (signOut() with a live session).
//
function stickyConfiguredPath(): string {
  return join(app.getPath('userData'), 'auth-configured.flag')
}

function writeStickyConfigured(): void {
  const p = stickyConfiguredPath()
  if (!existsSync(p)) {
    try { writeFileSync(p, '1', { mode: 0o600 }) } catch { /* best-effort */ }
  }
}

function clearStickyConfigured(): void {
  try {
    const p = stickyConfiguredPath()
    if (existsSync(p)) rmSync(p)
  } catch { /* best-effort */ }
}

function isStickyConfigured(): boolean {
  try { return existsSync(stickyConfiguredPath()) } catch { return false }
}

// ─── Last-known-good (LKG) sign-in config ─────────────────────────────────────
//
// The exact Azure config that produced a GENUINE successful interactive sign-in, persisted by signIn()
// alongside the sticky flag. It is the recovery mechanism that stops the sticky gate from becoming a
// permanent, unrecoverable brick: if the in-app Settings azure fields are later cleared (self-service
// "Reset SSO") while enforcement is still sticky, readConfig() falls back to this record so the user can
// sign in AGAIN and recover — instead of being stranded behind a wall whose only button short-circuits.
//
// Security properties (why this is safe):
//  - Lowest precedence. env → admin-trusted managed → per-user managed → Settings ALL win above it, so an
//    org tenant lock is never loosened and a fresh Settings config always overrides a stale LKG.
//  - No new attack surface. readConfig() already trusts a user-writable userData file (per-user
//    managed-config.json) to define tenant/clientId/domain, at HIGHER precedence than LKG. An attacker
//    who could forge LKG could already forge that higher-precedence file — LKG grants nothing new.
//  - Only honored when sticky is set (a real sign-in happened), so a stray/forged LKG on a never-signed-in
//    install is ignored.
//  - Public identifiers only (clientId/tenantId/allowedDomain) — never a secret/token.
// Written on every successful sign-in (latest good config wins); cleared on a genuine authenticated
// sign-out, in lockstep with the sticky flag.
//
function lkgConfigPath(): string {
  return join(app.getPath('userData'), 'auth-lkg-config.json')
}

function writeLkgConfig(cfg: AzureConfig): void {
  try {
    writeFileSync(
      lkgConfigPath(),
      JSON.stringify({ clientId: cfg.clientId, tenantId: cfg.tenantId, allowedDomain: cfg.allowedDomain }),
      { mode: 0o600 }
    )
  } catch {
    /* best-effort: without it, recovery just falls back to Settings/managed config */
  }
}

function readLkgConfig(): Partial<AzureConfig> {
  try {
    const j = JSON.parse(readFileSync(lkgConfigPath(), 'utf8'))
    const clientId = String(j?.clientId || '').trim()
    const tenantId = String(j?.tenantId || '').trim()
    const allowedDomain = String(j?.allowedDomain || '').trim().replace(/^@/, '')
    if (clientId && tenantId && allowedDomain) return { clientId, tenantId, allowedDomain }
  } catch {
    /* absent / unreadable / malformed — no recovery config */
  }
  return {}
}

function clearLkgConfig(): void {
  try {
    const p = lkgConfigPath()
    if (existsSync(p)) rmSync(p)
  } catch { /* best-effort */ }
}

function msalCachePath(): string {
  return join(app.getPath('userData'), 'msal-cache.bin')
}

/**
 * An MSAL token cache persisted to disk, encrypted at rest (same discipline as saveSession + the
 * API-key vault). File backend is used in dev; safeStorage in prod. Migration: if the file was
 * written by safeStorage it is re-saved with the current backend on first read.
 * This is what lets a Graph access token survive past the interactive sign-in so getGraphToken()
 * can acquireTokenSilent later (e.g. to read the calendar). Never logged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCachePlugin(): any {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeCacheAccess: async (ctx: any): Promise<void> => {
      try {
        const buf = readFileSync(msalCachePath())
        let json: string | null = null

        if (useFileBackend()) {
          try { json = decryptSecret(buf) } catch { /* not AES-GCM format — try safeStorage below */ }
        }
        // Fallback / migration: try safeStorage (old installs or prod reads on prod path)
        if (json === null && safeStorage.isEncryptionAvailable()) {
          try { json = safeStorage.decryptString(buf) } catch { /* not a safeStorage blob either */ }
          // If we read it via safeStorage while in file-backend mode, migrate now (best-effort)
          if (json !== null && useFileBackend()) {
            try { writeFileSync(msalCachePath(), encryptSecret(json), { mode: 0o600 }) } catch { /* best-effort */ }
          }
        }
        if (json !== null) ctx.tokenCache.deserialize(json)
      } catch {
        /* no cache yet — start empty */
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterCacheAccess: async (ctx: any): Promise<void> => {
      if (!ctx.cacheHasChanged) return
      try {
        const json = ctx.tokenCache.serialize()
        const blob = useFileBackend()
          ? encryptSecret(json)
          : safeStorage.isEncryptionAvailable()
            ? safeStorage.encryptString(json)
            : null
        if (blob) writeFileSync(msalCachePath(), blob, { mode: 0o600 })
      } catch {
        /* best-effort: token simply won't persist this run */
      }
    }
  }
}

/** Lazy CJS accessor for @azure/msal-node. NOT `await import()`: the main process is bytecode-compiled,
 *  and dynamic import throws "A dynamic import callback was not specified" under bytecode — which crashed
 *  SSO sign-in + Graph token refresh in the built app. A plain `require()` IS bytecode-safe (updater.ts
 *  ships the same pattern), and unlike the previous static import it keeps msal's ~27ms require tree off
 *  every boot for installs that never configure Azure SSO. */
function msal(): typeof import('@azure/msal-node') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@azure/msal-node') as typeof import('@azure/msal-node')
}

/** Build a PublicClientApplication wired to the encrypted on-disk token cache. */
async function makePca(cfg: AzureConfig): Promise<PublicClientApplication> {
  return new (msal().PublicClientApplication)({
    auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${cfg.tenantId}` },
    cache: { cachePlugin: makeCachePlugin() }
  })
}

/**
 * Silently obtain a Microsoft Graph access token for the given scopes from the cached account, refreshing
 * via the persisted refresh token if needed. Returns null when SSO is unconfigured, no account is cached,
 * or consent/refresh fails — callers treat null as "needs (re)connect" and never surface raw errors.
 */
export async function getGraphToken(scopes: string[]): Promise<string | null> {
  const cfg = readConfig()
  if (!cfg) return null
  try {
    const pca = await makePca(cfg)
    const accounts = await pca.getTokenCache().getAllAccounts()
    if (!accounts.length) return null
    // Bind to the validated, signed-in session account — NOT just accounts[0] — so a stray/extra cached
    // account can never be used to read another user's calendar.
    loadSession()
    const want = (session?.email || '').toLowerCase()
    const account = accounts.find((a) => (a.username || '').toLowerCase() === want) ?? null
    if (!account) return null
    const result = await pca.acquireTokenSilent({ account, scopes, forceRefresh: false })
    return result?.accessToken ?? null
  } catch {
    return null
  }
}

let session: Session | null = null
let loaded = false

// Thread the signed-in user's identity into every audit record (auth.ts is the source of truth for who's
// signed in). Registered once at module load; the callback reads the live `session` binding lazily so it
// always reflects the current signed-in user (or none) at the time each audit line is written.
setAuditActor(() => session?.email)

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
  // Drop the Graph token cache alongside the identity, so sign-out/expiry also revokes calendar access.
  try {
    if (existsSync(msalCachePath())) rmSync(msalCachePath())
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
 * Probe the persisted refresh token against the server for the re-validation sweep. Distinguishes a
 * genuine server-side revocation from a benign/transient failure so we only sign the user out when the
 * token is ACTUALLY rejected:
 *  - 'valid'   — the refresh token still works (forceRefresh hits the server)
 *  - 'revoked' — the server explicitly rejected it (interaction required / invalid_grant) → sign out
 *  - 'unknown' — inconclusive (offline, transient, no cached account) → KEEP the session
 *
 * This is the fix for the silent-sign-out bug: getGraphToken() collapses every failure (offline,
 * empty cache, network blip) to null, so re-validating off it would log out users who just lost wifi.
 */
async function probeRefreshToken(): Promise<'valid' | 'revoked' | 'unknown'> {
  const cfg = readConfig()
  if (!cfg) return 'unknown'
  try {
    const pca = await makePca(cfg)
    const accounts = await pca.getTokenCache().getAllAccounts()
    if (!accounts.length) return 'unknown' // nothing cached to probe — not a revocation
    loadSession()
    const want = (session?.email || '').toLowerCase()
    const account = accounts.find((a) => (a.username || '').toLowerCase() === want) ?? null
    if (!account) return 'unknown'
    // forceRefresh: actually exercise the refresh token against the server (vs returning a cached AT).
    const result = await pca.acquireTokenSilent({ account, scopes: ['User.Read'], forceRefresh: true })
    return result?.accessToken ? 'valid' : 'unknown'
  } catch (e) {
    // Only an explicit server rejection means the token is revoked. Network/transient/client errors
    // are inconclusive and must NOT sign the user out.
    const name = (e as { name?: string } | null)?.name ?? ''
    const code = (e as { errorCode?: string } | null)?.errorCode ?? ''
    if (name === 'InteractionRequiredAuthError' || /invalid_grant|interaction_required/i.test(`${name} ${code}`)) {
      return 'revoked'
    }
    return 'unknown'
  }
}

/**
 * Post-startup + periodic re-validation. Checks local max-age + config-domain match first, then probes
 * the persisted MSAL refresh token. Only an EXPLICIT server-side revocation clears the session — an
 * offline or transient failure leaves the user signed in (see probeRefreshToken).
 */
async function revalidateSession(): Promise<void> {
  loadSession()
  if (!session) return
  const reason = expiryReason(session, readConfig())
  if (reason) {
    clearSession()
    auditLog('auth.expired', { reason })
    return
  }
  if ((await probeRefreshToken()) === 'revoked') {
    clearSession()
    auditLog('auth.refresh_failed', {})
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
    revalidateSession().catch(() => {
      /* re-validation is best-effort */
    })
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
  try {
    const buf = readFileSync(sessionPath())
    let json: string | null = null

    // Try the file backend (covers dev + new prod installs).
    if (useFileBackend()) {
      try { json = decryptSecret(buf) } catch { /* not AES-GCM format — try safeStorage below */ }
    }
    // Fallback / migration: try safeStorage (old prod installs or prod reads on the safeStorage path).
    if (json === null && safeStorage.isEncryptionAvailable()) {
      try { json = safeStorage.decryptString(buf) } catch { /* not a safeStorage blob */ }
      // Migrate to file backend if we're now in file-backend mode (best-effort).
      if (json !== null && useFileBackend()) {
        try { writeFileSync(sessionPath(), encryptSecret(json), { mode: 0o600 }) } catch { /* best-effort */ }
      }
    }
    session = json !== null ? (JSON.parse(json) as Session) : null
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
  // Always persist — the file backend (dev) or safeStorage (prod) guarantees encryption at rest.
  // Without encryption neither was written before; we continue to prefer safeStorage in prod for
  // defence-in-depth, but the file backend removes the "must have keychain" blocker for dev/CI.
  try {
    const json = JSON.stringify(s)
    const blob = useFileBackend()
      ? encryptSecret(json)
      : safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(json)
        : null
    if (blob) writeFileSync(sessionPath(), blob, { mode: 0o600 })
  } catch (e) {
    // Session persisted to memory only — sign-in still works for this run, but will silently sign
    // the user out on next launch with no trace unless we log it. Never log session contents
    // (email/name/tokens) — reason/class only.
    mainLog.warn('[auth] failed to persist session to disk (in-memory only this run):', e instanceof Error ? e.message : String(e))
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
    domain: cfg?.allowedDomain,
    // Lets the renderer gate the SignInWall even when `configured` is false (e.g. sticky-configured
    // survives a cleared Settings azure block) — mirrors requireAuth()'s own enforcement check exactly,
    // so the wall and the IPC gate can never disagree about whether sign-in is required.
    enforced: authEnforced() || isStickyConfigured()
  }
}

/** Org override: when set, privileged IPC is blocked until the user signs in, even if SSO is unconfigured. */
function authEnforced(): boolean {
  if (/^(1|true|yes)$/i.test(process.env.ASKTOTO_REQUIRE_AUTH || '')) return true
  // Machine-wide managed-config can also force it: { "requireAuth": true }.
  const paths = [trustedAdminManagedPath(), join(app.getPath('userData'), 'managed-config.json')].filter(
    (p): p is string => !!p
  )
  for (const p of paths) {
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
 *
 * Sticky-configured guard: once a genuine interactive sign-in has succeeded (see writeStickyConfigured
 * in signIn()), requireAuth() treats the device as enforced even if the renderer later clears the
 * in-app Settings azure fields (which would otherwise flip configured→false and open the privileged
 * surface). The sticky flag is cleared only by an authenticated signOut() — never by a renderer
 * settings update, and never by merely resolving (unvalidated) config without ever signing in.
 */
export function requireAuth(): boolean {
  const s = authStatus()
  if (authEnforced()) return s.signedIn
  if (isStickyConfigured()) return s.signedIn
  return !s.configured || s.signedIn
}

/** Bucket a signIn() failure into a small, fixed category for the audit log — never the raw error
 *  message, which can carry MSAL/account details (tenant hints, correlation IDs) that don't belong in
 *  an audit record. */
function coarseSignInFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/timed out/i.test(msg)) return 'timeout'
  if (/No authorization code|error_description|access_denied/i.test(msg)) return 'oauth_denied'
  if (/network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return 'network'
  return 'other'
}

export async function signIn(): Promise<SignInResult> {
  const cfg = readConfig()
  if (!cfg) return { ok: true, configured: false } // not configured — let the user proceed

  try {
    // PCA is wired to the encrypted on-disk token cache (makePca) so the Graph token survives for later
    // calendar reads. (CryptoProvider comes through the lazy msal() accessor — see makePca.)
    const pca = await makePca(cfg)
    const crypto = new (msal().CryptoProvider)()
    const { verifier, challenge } = await crypto.generatePkceCodes()
    // CSRF nonce echoed back on the loopback redirect; any request that doesn't carry it is ignored.
    const state = randomBytes(16).toString('hex')

    const captured = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = ''
      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const c = url.searchParams.get('code')
        const err = url.searchParams.get('error_description') || url.searchParams.get('error')
        // Ignore stray hits (favicon, port probes) — keep listening for the real OAuth redirect.
        if (!c && !err) {
          res.writeHead(204)
          res.end()
          return
        }
        // CSRF check: the redirect MUST echo our state nonce. Reject anything else, keep waiting.
        if (url.searchParams.get('state') !== state) {
          auditLog('auth.state_mismatch', {})
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Invalid state.')
          return
        }
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
        // Match the literal bind address (127.0.0.1), NOT `localhost`: on Windows `localhost` resolves to
        // ::1 first, and the browser's callback to an IPv6 address the server never listens on can stall
        // or drop the OAuth code. Entra's loopback handling accepts http://127.0.0.1 on any port for the
        // "Mobile and desktop applications" platform exactly like http://localhost.
        redirectUri = `http://127.0.0.1:${port}`
        try {
          const authUrl = await pca.getAuthCodeUrl({
            scopes: SIGN_IN_SCOPES,
            redirectUri,
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
            prompt: 'select_account',
            state
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
      scopes: SIGN_IN_SCOPES,
      redirectUri: captured.redirectUri,
      codeVerifier: verifier
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claims = (result.idTokenClaims || {}) as any
    const email = (result.account?.username || claims.preferred_username || claims.email || '').toLowerCase()
    const tid = claims.tid || ''

    // acquireTokenByCode already persisted this account's Graph tokens to the encrypted cache. If we then
    // REJECT the account (wrong tenant/domain), purge it so a disallowed account's tokens never linger.
    const purgeRejected = async (): Promise<void> => {
      try {
        if (result.account) await pca.getTokenCache().removeAccount(result.account)
      } catch {
        /* fall through to the file wipe */
      }
      try {
        if (existsSync(msalCachePath())) rmSync(msalCachePath())
      } catch {
        /* best-effort */
      }
    }

    if (tid !== cfg.tenantId) {
      await purgeRejected()
      auditLog('auth.denied', { domain: cfg.allowedDomain, attemptedEmail: email, attemptedTenant: tid })
      return { ok: false, configured: true, error: 'That account is outside your organization.' }
    }
    if (!email.endsWith(`@${cfg.allowedDomain.toLowerCase()}`)) {
      await purgeRejected()
      auditLog('auth.denied', { domain: cfg.allowedDomain, attemptedEmail: email, attemptedTenant: tid })
      return { ok: false, configured: true, error: `Use your @${cfg.allowedDomain} account.` }
    }

    saveSession({
      email,
      name: result.account?.name,
      domain: cfg.allowedDomain,
      tid,
      at: Date.now()
    })
    // Only NOW — a real interactive sign-in has actually validated and established a session — does
    // SSO count as "genuinely usable". See the sticky-configured comment block above readConfig().
    // Persist the exact config that worked (LKG) so a later "Reset SSO" leaves the enforced gate
    // recoverable (sign-in stays possible) rather than an unrecoverable brick.
    writeStickyConfigured()
    writeLkgConfig(cfg)
    auditLog('auth.signin', { domain: cfg.allowedDomain })
    return { ok: true, configured: true, email }
  } catch (e) {
    auditLog('auth.signin_failed', { reason: coarseSignInFailure(e) })
    return { ok: false, configured: true, error: e instanceof Error ? e.message : String(e) }
  }
}

export function signOut(): void {
  // Load session before clearing so we can detect a genuine (authenticated) sign-out.
  // The sticky-configured flag + LKG recovery config are cleared only when there was a real active
  // session — a bare signOut() call with no session must NOT clear them (prevents an attacker from
  // calling signOut() to drop the sticky flag/LKG and then clearing Settings to bypass or brick auth).
  // Cleared in lockstep: enforcement being intentionally lifted means its recovery record goes too;
  // both are re-established on the next successful sign-in.
  loadSession()
  const wasSignedIn = !!session
  clearSession()
  if (wasSignedIn) {
    clearStickyConfigured()
    clearLkgConfig()
  }
  auditLog('auth.signout')
}
