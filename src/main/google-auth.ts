/**
 * Google OAuth 2.0 (PKCE, loopback server) sign-in for Google Calendar read access.
 *
 * Mirrors the discipline from auth.ts: encrypted session via safeStorage, loopback server on
 * a random port, 300 s timeout, stray-hit 204 / CSRF-state check. Config comes from env or
 * a managed-config.json (same admin path as auth.ts). No client secret required for the
 * public-client PKCE flow, but one may optionally be provided (managed/installed apps).
 *
 * Activation: set GOOGLE_CLIENT_ID (+ optionally GOOGLE_CLIENT_SECRET) or deploy
 *   { "google": { "clientId": "...", "clientSecret": "..." } } in managed-config.json.
 * Without a clientId, googleAuthStatus() returns configured:false and no sign-in is offered.
 */
import { app, shell, safeStorage } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { join } from 'node:path'
import type { GoogleAuthStatus } from '@shared/ipc'
import { auditLog } from './logger'
import { useFileBackend, encryptSecret, decryptSecret } from './secrets'
import { getSettings } from './store'

interface GoogleConfig {
  clientId: string
  clientSecret?: string
}

interface GoogleSession {
  refreshToken: string
  email: string
  accessToken: string
  expiresAt: number // ms since epoch
}

/** Machine-wide org-policy file IT can deploy (same path as auth.ts). */
function adminManagedPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/AskToto/managed-config.json'
  if (process.platform === 'win32')
    return join(process.env.ProgramData || 'C:\\ProgramData', 'AskToto', 'managed-config.json')
  return '/etc/asktoto/managed-config.json'
}

/** Read Google config from managed-config.json (admin policy then per-user). */
function readManagedGoogle(): Partial<GoogleConfig> {
  for (const p of [adminManagedPath(), join(app.getPath('userData'), 'managed-config.json')]) {
    try {
      const g = JSON.parse(readFileSync(p, 'utf8'))?.google
      if (g?.clientId) return { clientId: g.clientId, clientSecret: g.clientSecret }
    } catch {
      /* not present / unreadable */
    }
  }
  return {}
}

/**
 * Read an optional org-domain restriction from managed-config (admin path first, then user path)
 * or from the Settings store. Returns null when no restriction is configured, meaning any Google
 * account is accepted.
 */
function readAllowedDomain(): string | null {
  for (const p of [adminManagedPath(), join(app.getPath('userData'), 'managed-config.json')]) {
    try {
      const g = JSON.parse(readFileSync(p, 'utf8'))?.google
      if (g?.allowedDomain && typeof g.allowedDomain === 'string') return (g.allowedDomain as string).toLowerCase().trim()
    } catch {
      /* not present / unreadable */
    }
  }
  try {
    const d = (getSettings().googleAllowedDomain || '').trim().toLowerCase()
    if (d) return d
  } catch {
    /* settings unreadable */
  }
  return null
}

/**
 * Resolve Google OAuth config.
 * Precedence (highest → lowest): env → managed-config admin → managed-config user → Settings UI.
 * The Settings fallback mirrors auth.ts readSettingsAzure() — the user can paste a Google client
 * ID in Settings → Calendar to enable "Connect Google Calendar" without deploying a managed-config.
 * Returns null when no clientId is available — sign-in is not offered.
 */
export function readGoogleConfig(): GoogleConfig | null {
  const fromEnv = process.env.GOOGLE_CLIENT_ID
  if (fromEnv) {
    return { clientId: fromEnv, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
  }
  const m = readManagedGoogle()
  if (m.clientId) return { clientId: m.clientId, clientSecret: m.clientSecret }
  // Settings fallback — lowest precedence; managed-config always wins.
  try {
    const clientId = (getSettings().googleClientId || '').trim()
    if (clientId) return { clientId }
  } catch {
    /* settings unreadable — not configured */
  }
  return null
}

// ─── Session persistence ──────────────────────────────────────────────────────

function sessionPath(): string {
  return join(app.getPath('userData'), 'google-session.bin')
}

let gSession: GoogleSession | null = null
let gLoaded = false

function loadGoogleSession(): void {
  if (gLoaded) return
  gLoaded = true
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
    gSession = json !== null ? (JSON.parse(json) as GoogleSession) : null
  } catch {
    gSession = null
  }
}

function saveGoogleSession(s: GoogleSession): void {
  gSession = s
  try {
    const json = JSON.stringify(s)
    const blob = useFileBackend()
      ? encryptSecret(json)
      : safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(json)
        : null
    if (blob) writeFileSync(sessionPath(), blob, { mode: 0o600 })
  } catch {
    /* in-memory only if write fails */
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** True when there is a persisted refresh token (may be expired; getGoogleAccessToken will refresh). */
export function googleAuthStatus(): GoogleAuthStatus {
  loadGoogleSession()
  return {
    configured: !!readGoogleConfig(),
    signedIn: !!gSession?.refreshToken,
    email: gSession?.email
  }
}

/** base64url-encode a Buffer (no padding). */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Start the Google PKCE loopback flow. Opens a browser tab; the user grants consent; the code
 * is exchanged for tokens; the session is persisted encrypted. Returns { ok, email } on success.
 */
export async function googleSignIn(): Promise<{ ok: boolean; email?: string; error?: string }> {
  const cfg = readGoogleConfig()
  if (!cfg) return { ok: false, error: 'Google client ID not configured.' }

  // PKCE: verifier = 96 random bytes → 128 base64url chars (in the 43-128 allowed range)
  const verifier = b64url(randomBytes(96))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = randomBytes(16).toString('hex')

  try {
    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
      (resolve, reject) => {
        let redirectUri = ''
        const server = createServer((req, res) => {
          const url = new URL(req.url || '/', 'http://localhost')
          const code = url.searchParams.get('code')
          const err = url.searchParams.get('error_description') || url.searchParams.get('error')

          // Ignore stray hits (favicon, port probes) — keep listening for the real redirect.
          if (!code && !err) {
            res.writeHead(204)
            res.end()
            return
          }
          // CSRF guard: reject any redirect that doesn't carry our state nonce.
          if (url.searchParams.get('state') !== state) {
            res.writeHead(400, { 'Content-Type': 'text/plain' })
            res.end('Invalid state.')
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            `<html><body style="font-family:system-ui;background:#1a0033;color:#fff;display:grid;` +
              `place-items:center;height:100vh;margin:0"><div style="text-align:center">` +
              `<h2>AskToto</h2><p>${code ? 'Google Calendar connected — you can close this window.' : 'Sign-in failed.'}</p>` +
              `</div></body></html>`
          )
          clearTimeout(timer)
          server.close()
          if (code) resolve({ code, redirectUri })
          else reject(new Error(err || 'No authorization code returned.'))
        })
        server.on('error', reject)
        const timer = setTimeout(() => {
          server.close()
          reject(new Error('Google sign-in timed out.'))
        }, 300_000)
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          redirectUri = `http://localhost:${port}`
          const params = new URLSearchParams({
            client_id: cfg.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state,
            access_type: 'offline',
            prompt: 'consent'
          })
          const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
          shell.openExternal(authUrl).catch((e) => {
            clearTimeout(timer)
            server.close()
            reject(e instanceof Error ? e : new Error(String(e)))
          })
        })
      }
    )

    // Exchange the authorization code for tokens.
    const body = new URLSearchParams({
      code,
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {})
    })
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '(no body)')
      return { ok: false, error: `Token exchange failed (${tokenRes.status}): ${errText}` }
    }
    const tokens = (await tokenRes.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      id_token?: string
    }
    if (!tokens.access_token) return { ok: false, error: 'No access token in response.' }

    // Decode the id_token payload (middle base64url segment) for the email + verification claims.
    let email = ''
    let emailVerified = false
    let hd = '' // Google Workspace "hosted domain" claim — present only on managed-org accounts
    if (tokens.id_token) {
      try {
        const parts = tokens.id_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as {
            email?: string
            email_verified?: boolean | string
            hd?: string
          }
          email = payload.email || ''
          emailVerified = payload.email_verified === true || payload.email_verified === 'true'
          hd = payload.hd || ''
        }
      } catch {
        /* best-effort — claims stay empty (treated as unverified below) */
      }
    }

    // Domain allow-list check (optional — enforced only when google.allowedDomain is configured).
    // Runs before any session persistence so a rejected account is never stored. When a domain is
    // required we also demand email_verified (a consumer account could otherwise set an unverified
    // org-looking email) and, when present, an exact hd (hosted-domain) match — the robust Workspace
    // signal. Unverifiable claims fail closed.
    const allowedDomain = (readAllowedDomain() || '').toLowerCase()
    if (allowedDomain) {
      const suffixOk = !!email && email.toLowerCase().endsWith(`@${allowedDomain}`)
      const hdOk = !hd || hd.toLowerCase() === allowedDomain
      if (!suffixOk || !emailVerified || !hdOk) {
        auditLog('google.signin.domain_rejected', {})
        return { ok: false, error: 'Use your organization Google account.' }
      }
    }

    // No refresh token → the session can never silently re-auth (googleAuthStatus would report signedIn:false
    // while a stale file lingers). Reject so the user re-consents (access_type=offline + prompt=consent should
    // yield one; if Google still withholds it, revoking prior app access and retrying does).
    if (!tokens.refresh_token) {
      return { ok: false, error: 'Google did not return a refresh token — remove AskToto from your Google account permissions and sign in again.' }
    }
    const session: GoogleSession = {
      refreshToken: tokens.refresh_token,
      email,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : 3600_000)
    }
    saveGoogleSession(session)
    auditLog('google.signin', { email: email ? '[redacted]' : 'unknown' })
    return { ok: true, email }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Return a valid (non-expired) Google access token, refreshing silently via the refresh token
 * when needed. Returns null if there is no session or the refresh fails.
 */
export async function getGoogleAccessToken(): Promise<string | null> {
  loadGoogleSession()
  if (!gSession?.refreshToken) return null

  // Return the cached token if it's still valid (with a 60 s buffer).
  if (gSession.accessToken && gSession.expiresAt > Date.now() + 60_000) {
    return gSession.accessToken
  }

  const cfg = readGoogleConfig()
  // Attempt a silent refresh.
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: gSession.refreshToken,
      client_id: cfg?.clientId || '',
      ...(cfg?.clientSecret ? { client_secret: cfg.clientSecret } : {})
    })
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!res.ok) return null
    const data = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!data.access_token) return null

    // Update the cached token (keep the existing refreshToken — Google only re-issues it with prompt=consent).
    const updated: GoogleSession = {
      ...gSession,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600_000)
    }
    saveGoogleSession(updated)
    return updated.accessToken
  } catch {
    return null
  }
}

/** Sign out: delete the persisted session file and clear the in-memory cache. */
export function googleSignOut(): void {
  gSession = null
  gLoaded = false // allow re-load after sign-out (e.g. if the user signs back in this run)
  try {
    const p = sessionPath()
    if (existsSync(p)) rmSync(p)
  } catch {
    /* best-effort */
  }
  auditLog('google.signout', {})
}
