import { shell } from 'electron'
import { DustAPI, type LoggerInterface } from '@dust-tt/client'
import { mainLog, auditLog } from './logger'
import { setApiKey, setDustRefreshToken, getDustRefreshToken, clearDustRefreshToken, setSettings } from './store'

// DustAPI's LoggerInterface is pino-shaped ((args, message) => void) — electron-log's mainLog takes
// (message, ...args) instead, so it can't be passed directly. 'trace' has no electron-log equivalent;
// mapped to 'silly', its closest verbosity level.
const dustApiLogger: LoggerInterface = {
  error: (args, message) => mainLog.warn(message, args),
  warn: (args, message) => mainLog.warn(message, args),
  info: (args, message) => mainLog.info(message, args),
  trace: (args, message) => mainLog.silly(message, args)
}

/**
 * Native Dust sign-in — no `@dust-tt/dust-cli`, no system Node.js, no terminal window.
 *
 * Runs the exact WorkOS OAuth device-authorization flow `dust login` itself runs — verified by reading
 * the published `@dust-tt/dust-cli@0.4.5` tarball directly (`npm pack`, then read `dist/index.js`):
 *   - `POST https://api.workos.com/user_management/authorize/device` with the CLI's own public client id
 *     and scope `openid profile email` (no client secret anywhere — a public-client device flow).
 *   - Poll `POST https://api.workos.com/user_management/authenticate`,
 *     `grant_type=urn:ietf:params:oauth:grant-type:device_code`, honoring `authorization_pending` /
 *     `slow_down` / `expired_token` per RFC 8628.
 *   - Refresh with the same endpoint, `grant_type=refresh_token`.
 *   - The workspace region is a claim (`https://dust.tt/region`) INSIDE the access token JWT, decoded
 *     client-side (dust-cli does this with `jwt-decode`; we do the equivalent 3-line base64url decode —
 *     no signature verification needed, the token just arrived directly from WorkOS over TLS).
 *   - Workspace listing is `new DustAPI({url}, {apiKey: accessToken, workspaceId: 'me'}).me()` →
 *     `{ workspaces: [{ sId, name, role }] }` — `'me'` is the CLI's own sentinel for "no workspace chosen
 *     yet", not a placeholder we invented.
 *
 * Tokens land in Métis's OWN encrypted store (`setApiKey('dust', ...)` + `setDustRefreshToken`), never in
 * the `dust-cli` keytar namespace — `dustcli.ts`'s `importDustCliSession`/`refreshDustCliSession` stay as
 * a separate, READ-ONLY migration path for users who already ran `dust login` themselves. Writing both
 * namespaces from two processes would recreate the exact single-use-rotating-refresh-token race that
 * `dustcli.ts`'s own `refreshInflight` guard exists to prevent.
 */

const WORKOS_DOMAIN = 'api.workos.com'
// The public client id @dust-tt/dust-cli itself ships — verified above, no secret involved. If Dust ever
// rotates it, every shipped dust-cli breaks too, not just Métis; not worth a config override until that
// actually happens (Build Law rule 2 — no config knob for a problem that has not occurred).
const DUST_WORKOS_CLIENT_ID = 'client_01JGCT55T7FVDG9XF74925R1KT'
const DUST_OAUTH_SCOPE = 'openid profile email'

interface DeviceAuthorizeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

interface TokenSuccess {
  access_token: string
  // OPTIONAL per RFC 6749 §5.1: an authorization server may omit refresh_token from a refresh response
  // when it is not rotating it. Typed honestly so callers must handle its absence — see
  // refreshDustOAuthSession, where assuming it was always present turned a SUCCESSFUL refresh into a
  // permanently dead session.
  refresh_token?: string
}

interface TokenError {
  error: string
  error_description?: string
}

function isTokenError(x: unknown): x is TokenError {
  return !!x && typeof x === 'object' && 'error' in x
}

/** Decode a JWT payload without verifying the signature — safe here because the token just arrived
 *  directly from WorkOS's token endpoint over TLS. Only reads the region claim; never used to authorize
 *  anything, so no signature check is needed (the same trust boundary dust-cli itself relies on). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split('.')[1]
    if (!part) return null
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function regionFromAccessToken(accessToken: string): string {
  const region = decodeJwtPayload(accessToken)?.['https://dust.tt/region']
  return typeof region === 'string' && region ? region : 'us-central1'
}

/** Exact switch dust-cli itself uses (verified in the bundle) — 'europe-west1' is the only non-default
 *  region today; everything else, including an unrecognized future region, resolves to the US domain. */
function regionToBaseUrl(region: string): string {
  return region === 'europe-west1' ? 'https://eu.dust.tt' : 'https://dust.tt'
}

export interface DustDeviceLoginStart {
  ok: boolean
  error?: string
  deviceCode?: string
  userCode?: string
  verificationUri?: string
  expiresInSec?: number
  intervalSec?: number
}

/**
 * Only an https URL may be handed to the OS shell (MQA-253).
 *
 * shell.openExternal is a shell execution primitive, not a browser call: the SCHEME decides which
 * application runs. `ms-msdt:`, `search-ms:` and `file:` all resolve to local handlers on Windows, so an
 * unvalidated URL off the wire lets the responder choose the handler while the user sees only "signing in
 * to Dust". Everywhere else in this codebase that opens a URL it did not construct already gates on https
 * (index.ts's setWindowOpenHandler, intelligence.ts); this call site never got the same rule.
 *
 * Refused rather than sanitised — there is no legitimate non-https verification link, and a "clean it up"
 * branch is where the next bypass lives.
 *
 * Scheme only, deliberately NOT host-locked. The first version of this pinned the host to WORKOS_DOMAIN,
 * on the reasoning that the verification page belongs to the domain the request went to. It does not: the
 * API is api.workos.com but the user-facing page is Dust's own (signin.dust.tt), so that guard rejected
 * every real sign-in — caught by an existing test in this file. Pinning a host across two vendors'
 * infrastructure is a latent outage the moment either changes it, and the scheme is where the actual
 * privilege escalation lives.
 */
function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

/** Step 1: ask WorkOS for a device code and open the consent page in the user's default browser. */
export async function beginDustDeviceLogin(): Promise<DustDeviceLoginStart> {
  try {
    const res = await fetch(`https://${WORKOS_DOMAIN}/user_management/authorize/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DUST_WORKOS_CLIENT_ID, scope: DUST_OAUTH_SCOPE })
    })
    if (!res.ok) return { ok: false, error: `Could not start Dust sign-in (HTTP ${res.status}).` }
    const data = (await res.json()) as Partial<DeviceAuthorizeResponse>
    if (!data.device_code || !data.verification_uri_complete) {
      return { ok: false, error: 'Dust sign-in did not return a device code.' }
    }
    // MQA-253: the ONE openExternal in this app whose URL arrives off the wire rather than being built
    // here. Presence was checked; the scheme was not.
    if (!isHttpsUrl(data.verification_uri_complete)) {
      return { ok: false, error: 'Dust sign-in returned an unexpected verification link, so it was not opened.' }
    }
    await shell.openExternal(data.verification_uri_complete)
    return {
      ok: true,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri_complete,
      expiresInSec: data.expires_in,
      intervalSec: data.interval
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type DustDevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'error'; error: string }
  | { status: 'ok'; accessToken: string; refreshToken: string; region: string }

/**
 * One poll attempt. The renderer drives the cadence (call this every `intervalSec`, or +5s after a
 * `slow_down`) — mirrors how dust-cli's own polling loop is structured client-side, and keeps a single
 * IPC round trip fast rather than parking a long-lived setTimeout chain inside a main-process handler.
 */
export async function pollDustDeviceLoginOnce(deviceCode: string): Promise<DustDevicePollResult> {
  try {
    const res = await fetch(`https://${WORKOS_DOMAIN}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: DUST_WORKOS_CLIENT_ID
      })
    })
    const data = (await res.json()) as TokenSuccess | TokenError
    if (isTokenError(data)) {
      if (data.error === 'authorization_pending') return { status: 'pending' }
      if (data.error === 'slow_down') return { status: 'slow_down' }
      if (data.error === 'expired_token') return { status: 'expired' }
      return { status: 'error', error: data.error_description || data.error }
    }
    if (!data.access_token || !data.refresh_token) {
      return { status: 'error', error: 'Dust sign-in response was missing a token.' }
    }
    return {
      status: 'ok',
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      region: regionFromAccessToken(data.access_token)
    }
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

export interface DustWorkspaceOption {
  sId: string
  name: string
  role?: string
}

/** List the signed-in user's workspaces via the pre-workspace-selection `.me()` call ('me' is dust-cli's
 *  own sentinel workspaceId for this exact step, not a value we invented). */
export async function listDustWorkspacesForToken(
  accessToken: string,
  region: string
): Promise<{ ok: true; workspaces: DustWorkspaceOption[] } | { ok: false; error: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = new DustAPI(
      { url: regionToBaseUrl(region) },
      { apiKey: accessToken, workspaceId: 'me' },
      dustApiLogger
    )
    const me = await api.me()
    if (me?.isErr?.()) return { ok: false, error: me.error?.message || 'Could not fetch your Dust workspaces.' }
    const workspaces = (me?.value?.workspaces ?? []) as Array<{ sId: string; name: string; role?: string }>
    if (workspaces.length === 0) {
      return { ok: false, error: "You don't have any Dust workspaces. Visit https://dust.tt to create one." }
    }
    return { ok: true, workspaces: workspaces.map((w) => ({ sId: w.sId, name: w.name, role: w.role })) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Step 4: persist the finished login — the access token as Métis's own 'dust' provider key, the refresh
 *  token in the dedicated encrypted store, and the chosen workspace/region/origin in settings. */
export function completeDustOAuthLogin(opts: {
  accessToken: string
  refreshToken: string
  region: string
  workspaceId: string
}): void {
  setApiKey('dust', opts.accessToken)
  setDustRefreshToken(opts.refreshToken)
  setSettings({
    dustWorkspaceId: opts.workspaceId,
    dustBaseUrl: regionToBaseUrl(opts.region),
    dustTokenMintedAt: Date.now(),
    dustSessionOrigin: 'oauth'
  })
  auditLog('dust.oauth.login', { workspaceId: opts.workspaceId })
}

// Single-flight + short result cache — same discipline as dustcli.ts's refreshDustCliSession, and for the
// same reason: WorkOS refresh tokens are single-use and rotate on every call, so two concurrent refreshes
// (e.g. a startup check racing a 401-triggered one) would burn one token and invalidate the session.
export interface DustOAuthRefreshResult {
  ok: boolean
  token?: string
  error?: string
}

let refreshInflight: Promise<DustOAuthRefreshResult> | null = null
let lastRefresh: { at: number; result: DustOAuthRefreshResult } | null = null
const REFRESH_RESULT_TTL_MS = 30_000

/** Test-only: clears the single-flight/result cache so one test's refresh can't leak into the next
 *  (mirrors resetDustConversation in llm/dust.ts for the same class of module-level test isolation). */
export function resetDustOAuthRefreshCacheForTests(): void {
  refreshInflight = null
  lastRefresh = null
}

export async function refreshDustOAuthSession(): Promise<DustOAuthRefreshResult> {
  if (refreshInflight) return refreshInflight
  if (lastRefresh && lastRefresh.result.ok && Date.now() - lastRefresh.at < REFRESH_RESULT_TTL_MS) {
    return lastRefresh.result
  }
  refreshInflight = (async () => {
    const refreshToken = getDustRefreshToken()
    if (!refreshToken) {
      const r = { ok: false, error: 'No Dust session to refresh — sign in again.' }
      lastRefresh = { at: Date.now(), result: r }
      return r
    }
    try {
      const res = await fetch(`https://${WORKOS_DOMAIN}/user_management/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: DUST_WORKOS_CLIENT_ID,
          refresh_token: refreshToken
        })
      })
      const data = (await res.json()) as TokenSuccess | TokenError
      if (!res.ok || isTokenError(data)) {
        // A burned/expired refresh token can never recover — clear it so the UI offers a fresh sign-in
        // instead of retrying a token that will never work again.
        if (res.status === 400 || res.status === 401) clearDustRefreshToken()
        const r = { ok: false, error: isTokenError(data) ? data.error_description || data.error : `HTTP ${res.status}` }
        lastRefresh = { at: Date.now(), result: r }
        return r
      }
      // A 200 with no usable access_token is not a success — treat it as a normal failure rather than
      // storing an empty credential that fails confusingly on the next ask.
      if (typeof data.access_token !== 'string' || !data.access_token.trim()) {
        const r = { ok: false, error: 'Dust returned no access token.' }
        lastRefresh = { at: Date.now(), result: r }
        return r
      }
      // Store the NEW refresh token before reporting success — WorkOS refresh tokens are single-use, so a
      // crash between "got the new one" and "stored it" must not leave the OLD (now-burned) token behind.
      // Only when one was actually returned: refresh_token is OPTIONAL in a refresh response, and passing
      // undefined here threw inside setDustRefreshToken's token.trim(). The throw was swallowed by the
      // catch below, so a refresh that had genuinely SUCCEEDED was reported as a failure, the new access
      // token was never stored, and the old (already burned) refresh token stayed on disk — leaving the
      // Dust session permanently unrecoverable until a full re-login. Keeping the existing token is
      // correct when the server chose not to rotate it.
      const rotated = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : ''
      if (rotated) setDustRefreshToken(rotated)
      setApiKey('dust', data.access_token)
      setSettings({ dustTokenMintedAt: Date.now() })
      const r = { ok: true, token: data.access_token }
      lastRefresh = { at: Date.now(), result: r }
      return r
    } catch (e) {
      const r = { ok: false, error: e instanceof Error ? e.message : String(e) }
      lastRefresh = { at: Date.now(), result: r }
      return r
    }
  })()
  try {
    return await refreshInflight
  } finally {
    refreshInflight = null
  }
}
