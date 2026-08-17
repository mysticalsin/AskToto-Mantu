import { app, shell, safeStorage } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { PublicClientApplication } from '@azure/msal-node'
import type { AuthStatus, SignInResult } from '@shared/ipc'
import { getSettings, setSettings } from './store'
import { auditLog, mainLog, setAuditActor } from './logger'
import { useFileBackend, encryptSecret, decryptSecret } from './secrets'
import { readTrustedAdminManaged } from './win-security'

// Scopes requested at sign-in: identity + read-only calendar (so the agenda can be pulled later with no
// extra consent prompt). Least privilege — Calendars.Read, never ReadWrite.
const SIGN_IN_SCOPES = ['User.Read', 'Calendars.Read', 'openid', 'profile', 'email']

/**
 * Azure AD (Microsoft Entra) sign-in gate.
 *
 * Goal (per Tony): Métis can only be used by someone signed in with a Mantu Microsoft account, so
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
// forged %ProgramData%\Métis\managed-config.json (user-writable by default) is NOT honored, so it
// cannot redirect SSO to an attacker tenant or force-lock the app.

/** Read an { azure: { clientId, tenantId, allowedDomain } } block from managed-config (admin or per-user). */
function azureFromManagedContent(raw: string): Partial<AzureConfig> {
  try {
    const az = JSON.parse(raw)?.azure
    if (az?.clientId && az?.tenantId && az?.allowedDomain) {
      return { clientId: az.clientId, tenantId: az.tenantId, allowedDomain: az.allowedDomain }
    }
  } catch {
    /* not present / unreadable */
  }
  return {}
}

function readManagedAzure(): Partial<AzureConfig> {
  // Admin/machine policy FIRST so a user-writable per-user file can't override the org tenant lock.
  // readTrustedAdminManaged() reads through the SAME held fd that verified win32 admin-trust, so the
  // content read here can't be swapped in after the trust check (see win-security.ts).
  const admin = readTrustedAdminManaged()
  if (admin) {
    const az = azureFromManagedContent(admin)
    if (az.clientId) return az
  }
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'managed-config.json'), 'utf8')
    return azureFromManagedContent(raw)
  } catch {
    return {}
  }
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

// A resolved config value must be free of whitespace/control chars AND URL-structural metacharacters.
// tenantId flows into the MSAL authority URL `https://login.microsoftonline.com/${tenantId}`, and
// allowedDomain into the `email.endsWith('@'+allowedDomain)` gate — so a value carrying `/ \ ? # @ :`
// or whitespace could distort the authority path or the domain-suffix check. Legit values never do:
// clientId is a GUID, tenantId a GUID (see isPlausibleAzureConfig), allowedDomain a hostname. This is
// the format validation the self-service Settings path (and the managed/LKG paths) previously lacked.
function isSafeConfigValue(v: string): boolean {
  // Positive allowlist: letters, digits, dot, hyphen only. Covers every legit value — clientId
  // (GUID), tenantId (GUID), allowedDomain (hostname) — while rejecting all
  // whitespace, control chars, and URL-structural metacharacters (/ \ ? # @ : etc.).
  return v.length > 0 && v.length <= 253 && /^[A-Za-z0-9.-]+$/.test(v)
}

// The only tenantId shape this app can actually sign in with. The MSAL authority URL happily accepts
// the Entra primary domain (`mantu.onmicrosoft.com`) or a multi-tenant alias (`common`/`organizations`/
// `consumers`), but the runtime gate in signIn() compares against the id-token `tid` claim, which Entra
// always issues as the tenant GUID — and Métis is deliberately single-tenant (docs/MANTU-IT-REQUEST.md).
// Anything but the GUID therefore authenticates at Microsoft and is rejected as "outside your
// organization" on EVERY attempt, while readConfig() still reports the install as configured: the
// SignInWall replaces the whole app and the Settings ID fields lock behind it, so the typo (or an
// unedited `REPLACE-WITH-AZURE-TENANT-ID` from build/managed-config.enterprise.example.json) can never
// be corrected in-app. Subsumes isSafeConfigValue for this field — hex + hyphens only.
const TENANT_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Reject a resolved config whose fields aren't structurally plausible before they reach the MSAL
 *  authority / the domain gate. clientId and allowedDomain are only CHARACTER-checked (no whitespace /
 *  URL metachars), so injection-shaped garbage is rejected while GUIDs/hostnames pass; tenantId is held
 *  to the exact GUID shape, because a non-GUID there is not a degraded config but an unrecoverable
 *  lockout (see TENANT_GUID_RE). A tier that fails here is treated as "no config from this tier", which
 *  leaves the install unenforced and usable — the same outcome an unsafe clientId already produced. */
function isPlausibleAzureConfig(c: AzureConfig): boolean {
  return isSafeConfigValue(c.clientId) && TENANT_GUID_RE.test(c.tenantId) && isSafeConfigValue(c.allowedDomain)
}

/** Pure: does the id-token `tid` claim identify the configured tenant? Case-folded because Entra issues
 *  `tid` lowercase while the portal's "Directory (tenant) ID" is routinely pasted uppercase — see the
 *  gate in signIn(). Exported for unit tests (auth.test.ts): reaching that gate otherwise needs a full
 *  interactive MSAL round-trip, and a mismatch here is an unrecoverable lockout, not a retryable error. */
export function tenantMatches(tid: string, configuredTenantId: string): boolean {
  return tid.trim().toLowerCase() === configuredTenantId.trim().toLowerCase()
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
  // A tier "counts" only when it supplies all three fields AND they pass format validation — an
  // implausible/garbage value (whitespace, URL metachars) is treated as "no config from this tier"
  // and we fall through, rather than building a poisoned MSAL authority or a broken domain gate.
  const usable = (c: Partial<AzureConfig>): AzureConfig | null => {
    if (!c.clientId || !c.tenantId || !c.allowedDomain) return null
    const cfg = { clientId: c.clientId, tenantId: c.tenantId, allowedDomain: c.allowedDomain }
    return isPlausibleAzureConfig(cfg) ? cfg : null
  }
  const env = usable({
    clientId: process.env.AZURE_CLIENT_ID,
    tenantId: process.env.AZURE_TENANT_ID,
    allowedDomain: process.env.ASKTOTO_ALLOWED_DOMAIN
  })
  if (env) return env
  const m = usable(readManagedAzure())
  if (m) return m
  const s = usable(readSettingsAzure())
  if (s) return s
  // Recovery fallback — only after a genuine prior sign-in (sticky set), and only if nothing above
  // resolved. Makes an enforced-but-Settings-cleared device recoverable instead of a permanent brick.
  if (isStickyConfigured()) {
    const l = usable(readLkgConfig())
    if (l) {
      return l
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
        // Fallback / migration: try safeStorage (old installs or prod reads on prod path). Skipped when
        // the file backend is in force, so an old safeStorage-wrapped token can't re-open the Keychain
        // prompt we route around on an un-notarized build — the user just re-authenticates once instead.
        if (json === null && !useFileBackend() && safeStorage.isEncryptionAvailable()) {
          try { json = safeStorage.decryptString(buf) } catch { /* not a safeStorage blob either */ }
          // If we read it via safeStorage while in file-backend mode, migrate now (best-effort)
          if (json !== null && useFileBackend()) {
            try { writeFileSync(msalCachePath(), encryptSecret(json), { mode: 0o600 }) } catch { /* best-effort */ }
          }
        }
        // Reverse migration (mirrors loadSession): the cache may have been written by a build that
        // FORCED the file keystore on a platform that no longer does. Without this the Graph token
        // cache is dropped on upgrade and the user must re-authenticate interactively.
        if (json === null && !useFileBackend()) {
          try { json = decryptSecret(buf) } catch { /* not AES-GCM either, or the file key is unrecoverable */ }
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

// Single-flight guard for interactive sign-in. signIn() binds a loopback HTTP server, opens an external
// browser, and races to write the session — so concurrent/looping calls (double-clicks, or a misbehaving
// renderer spamming the IPC) would spawn multiple servers/browser windows and two writers racing on the
// session file. One interactive flow at a time; extra calls are rejected until it settles. This is the
// "rate limit auth endpoints" discipline applied at the main-process trust boundary, not the renderer.
let signInInFlight = false

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
    // Fallback / migration: try safeStorage only when this build did not explicitly opt out of
    // Keychain. The unsigned package sets ASKTOTO_LOCAL_KEYSTORE so an old auth-session.bin can never
    // place a hidden Keychain dialog in front of onboarding; it is treated as an expired local cache.
    if (json === null && !process.env.ASKTOTO_LOCAL_KEYSTORE && safeStorage.isEncryptionAvailable()) {
      try { json = safeStorage.decryptString(buf) } catch { /* not a safeStorage blob */ }
      // Migrate to file backend if we're now in file-backend mode (best-effort).
      if (json !== null && useFileBackend()) {
        try { writeFileSync(sessionPath(), encryptSecret(json), { mode: 0o600 }) } catch { /* best-effort */ }
      }
    }
    // Reverse migration: this file may have been written by a build that FORCED the file keystore on a
    // platform that no longer does (Windows, once the forced local keystore became darwin-only). Without
    // this the AES-GCM blob is never even tried and every upgrading user is silently signed out. Only
    // runs when the file backend is off, so a keystore-forced build still never probes the Keychain here.
    if (json === null && !useFileBackend()) {
      try { json = decryptSecret(buf) } catch { /* not AES-GCM either, or the file key is unrecoverable */ }
      if (json !== null && safeStorage.isEncryptionAvailable()) {
        try { writeFileSync(sessionPath(), safeStorage.encryptString(json), { mode: 0o600 }) } catch { /* best-effort */ }
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
  // Machine-wide managed-config can also force it: { "requireAuth": true }. Admin content comes from
  // readTrustedAdminManaged() (same held-fd read as the trust check — see win-security.ts); the
  // per-user file is read by path since it carries no win32 trust boundary.
  try {
    const admin = readTrustedAdminManaged()
    if (admin && JSON.parse(admin)?.requireAuth === true) return true
  } catch {
    /* malformed admin content */
  }
  try {
    if (JSON.parse(readFileSync(join(app.getPath('userData'), 'managed-config.json'), 'utf8'))?.requireAuth === true) {
      return true
    }
  } catch {
    /* not present */
  }
  return false
}

/**
 * MQA-107 — is SSO enforcement imposed by ADMIN-TRUSTED machine policy rather than self-serve Settings?
 * True when the admin-trusted managed-config (readTrustedAdminManaged — the same held-fd, win32
 * admin-trust-gated read used by readManagedAzure/authEnforced) either forces `{ requireAuth: true }`
 * OR supplies a full azure block. This is the ONE case the SignInWall's "Reset Microsoft sign-in setup"
 * escape hatch must refuse: a genuinely IT-locked fleet can never be talked out of enforcement from the
 * UI. The per-user managed-config file and the in-app Settings are deliberately NOT admin-trusted here
 * (both are user-writable), so they never make enforcement un-resettable. Exported for auth.test.ts.
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

  // Reject a second interactive flow while one is already running (see signInInFlight). Returning
  // ok:false surfaces a clear message on the wall/Settings rather than silently opening a 2nd browser.
  if (signInInFlight) return { ok: false, configured: true, error: 'A sign-in is already in progress.' }
  signInInFlight = true
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
          `<html><body style="font-family:system-ui;background:#1a0033;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Métis</h2><p>${c ? 'Signed in — you can close this window.' : 'Sign-in failed.'}</p></div></body></html>`
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

    // Case-folded compare: Entra issues `tid` as a lowercase GUID, but the portal's "Directory (tenant)
    // ID" is routinely pasted in uppercase. A raw !== turned that casing difference into a permanent
    // lockout — the config still counts as configured, so the wall stays up and Settings stays locked
    // while every retry denies again. expectedTenant is logged so the mismatch is diagnosable at all
    // (the user-facing string is unchanged: SignInWall keys its friendlier copy off it).
    if (!tenantMatches(tid, cfg.tenantId)) {
      await purgeRejected()
      auditLog('auth.denied', {
        domain: cfg.allowedDomain,
        attemptedEmail: email,
        attemptedTenant: tid,
        expectedTenant: cfg.tenantId
      })
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
    // ORDER MATTERS: write the LKG recovery config BEFORE the sticky flag, so the invariant
    // "sticky ⟹ a recovery config exists" holds even if the process dies between the two writes.
    // If the flag were written first and writeLkgConfig then failed/crashed, a later "Reset SSO" +
    // session-expiry would strand the user behind an enforced wall with no config to sign in against
    // (unrecoverable brick). LKG-first makes that ordering window safe.
    writeLkgConfig(cfg)
    writeStickyConfigured()
    auditLog('auth.signin', { domain: cfg.allowedDomain })
    return { ok: true, configured: true, email }
  } catch (e) {
    auditLog('auth.signin_failed', { reason: coarseSignInFailure(e) })
    return { ok: false, configured: true, error: e instanceof Error ? e.message : String(e) }
  } finally {
    // Always release the single-flight latch — success, denial, timeout, or throw — so a failed attempt
    // never wedges sign-in permanently.
    signInInFlight = false
  }
}

/**
 * MQA-107 escape hatch — the recovery the ledger's own item 2 calls for, reachable through the existing
 * (requireAuth-ungated) signOut IPC so it works even while requireAuth() is blocking settingsSet.
 *
 * A syntactically-valid but factually-WRONG self-serve tenant GUID (a digit-swap typo, or another
 * tenant's GUID copy-pasted by mistake) passes the shape check (TENANT_GUID_RE), so readConfig() reports
 * configured:true while signIn()'s `tid` compare fails on every attempt — the SignInWall replaces the
 * whole app and the Settings ID fields lock behind it, with no in-app way back (regression of MQA-027).
 * Clearing the three self-serve azure* Settings drops the install back to unenforced+usable so the IDs
 * can be re-entered. The LKG recovery path can't help here: it only exists after a genuine prior sign-in.
 *
 * Gated so it can ONLY rescue the genuine self-serve first-time brick, never loosen a real lock:
 *  - NO live session — the ledger's own gate; never reset out from under a signed-in user.
 *  - NOT env/managed-forced requireAuth (authEnforced) — an org that hard-requires auth stays locked.
 *  - NOT admin-trusted managed-config (isAdminManagedEnforced) — an IT-locked fleet can't be reset here.
 *  - NOT sticky-configured — a device that already had a genuine sign-in isn't bricked (it has the LKG
 *    recovery path, and sticky would keep enforcement up regardless), so clearing Settings there would
 *    only destroy a known-good config. This targets exactly the never-signed-in typo case.
 * Returns true only when it actually cleared a self-serve config. Exported for auth.test.ts.
 */
export function resetSelfServeSso(): boolean {
  loadSession()
  if (session) return false // must have NO live session
  if (authEnforced()) return false // env/managed requireAuth stays locked
  if (isAdminManagedEnforced()) return false // admin-trusted managed policy stays locked
  if (isStickyConfigured()) return false // prior genuine sign-in → LKG recovery exists, not a brick
  const s = readSettingsAzure()
  if (!s.clientId && !s.tenantId && !s.allowedDomain) return false // nothing self-serve to clear
  setSettings({ azureClientId: '', azureTenantId: '', azureAllowedDomain: '' })
  // This path writes settings directly (store.setSettings), bypassing the settingsSet IPC handler, so
  // mirror the 'settings.changed' audit that handler would emit — the cleared keys, for parity/traceability.
  auditLog('settings.changed', { keys: ['azureClientId', 'azureTenantId', 'azureAllowedDomain'], reason: 'sso_reset' })
  return true
}

/**
 * MQA-066 — may the renderer write the three self-serve azure fields while `requireAuth()` is false?
 *
 * The dead end this exists for: managed-config (or ASKTOTO_REQUIRE_AUTH) says `requireAuth: true` but
 * supplies no tenant. `authEnforced()` alone raises the SignInWall, `signIn()` short-circuits with
 * `{ok:true, configured:false}`, and the wall's own message — the one the code writes precisely so the
 * user is not "silently stranded … with no way forward" — sends them to Settings. That screen is behind
 * the wall, and even reached, `settingsSet` starts with `if (!requireAuth()) return`, so the IDs would be
 * typed and silently not persist. The machine is unusable with no in-app recovery.
 *
 * Deliberately NOT also gated on `readConfig() === null`. That was the first shape of this fix and it
 * only moved the brick one step later: the user types a tenant GUID, fat-fingers a digit, and now a
 * config resolves — so the bootstrap closes, every sign-in fails the tenant compare, and MQA-107's reset
 * hatch is unavailable because it (correctly) refuses to touch an `authEnforced()` fleet. Bricked again,
 * one step further along. Letting the fields stay writable until a sign-in actually succeeds is what
 * makes the remedy the wall names a real one.
 *
 * The two conditions that remain are the load-bearing ones:
 *  - NO live session, and enforcement actually on. Otherwise the normal authed path applies, or the wall
 *    is self-serve and already has the MQA-107 reset hatch.
 *  - NOT sticky-configured. A device where a genuine interactive sign-in has succeeded must never let an
 *    unauthenticated renderer point SSO at a different tenant — that is the attack `isStickyConfigured`
 *    exists to stop, and this must not reopen it.
 *
 * Why widening it is still safe. Writing these fields cannot lift enforcement: `authEnforced()` reads
 * env and managed-config only, and never these. It cannot override an org deployment either: `readConfig`
 * resolves env → managed → settings, so on a fleet whose admin supplied azure the write is simply inert.
 * The caller (index.ts's settingsSet) additionally narrows the patch to exactly these three keys, so no
 * other privileged setting rides along. The whole reachable effect is: a device that has NEVER signed in
 * successfully, and is walled, can set or correct its own self-serve tenant.
 */
export function ssoBootstrapAllowed(): boolean {
  loadSession()
  if (session) return false
  if (!authEnforced()) return false // a self-serve wall already has the MQA-107 reset escape hatch
  return !isStickyConfigured()
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
  } else {
    // No live session: the only caller reaching signOut() here is the SignInWall's "Reset Microsoft
    // sign-in setup" escape hatch (Settings is unreachable behind the wall). Clear a self-serve azure*
    // config that bricked the app with a well-formed-but-wrong tenant GUID (MQA-107) so it falls back to
    // usable. resetSelfServeSso() enforces every gate (self-serve only, never an IT/env lock) and no-ops
    // when they don't hold, so a routine already-signed-out signOut() stays a no-op.
    resetSelfServeSso()
  }
  auditLog('auth.signout')
}
