/**
 * Generic OAuth 2.0 authorization-code flow (Tony: "clicking a connector must actually connect by
 * opening the vendor's own authorisation page"; plan 6.10b). Owns three things `routes/connectors-oauth.ts`
 * composes into the two routes:
 *
 *  1. A signed, single-use `state` parameter (`mintOAuthState`/`verifyOAuthState`) - HMAC-SHA256 over
 *     `{ kind, actor, nonce, verifier, exp }`, keyed by an HKDF sub-key of `OPERATOR_INGEST_SECRET` with
 *     info `"metis-oauth-state-v1"` (RFC 5869; same two-call HKDF-Extract/Expand construction as
 *     `gateway-token.ts`'s `GATEWAY_TOKEN_INFO` key, and for the same reason: one compromised token
 *     format can never be replayed as, or forged from, another). The nonce is single-use only because
 *     the caller also runs it through `store.takeNonce` (the existing table every HMAC seat route already
 *     uses for replay protection) - `verifyOAuthState` takes that check as an injected callback, exactly
 *     like `hmac.ts#verifyIngestHmac`'s `seenNonce`, so this module needs no store import of its own and
 *     stays unit-testable without one.
 *  2. PKCE (RFC 7636) code_verifier/code_challenge generation, for the kinds `catalog.ts` marks
 *     `oauth.pkce`. The verifier travels inside the signed `state` itself rather than in a server-side
 *     session: the Worker is stateless across the redirect round trip, and the state is already
 *     HMAC-signed, single-use, and 10 minutes lived, so this is a deliberate simplicity trade-off, not an
 *     oversight (documented again in the report).
 *  3. The token endpoint calls themselves - the authorization-code exchange (`exchangeAuthorizationCode`)
 *     and refreshing an expiring access token (`refreshOAuthToken`) - both routed through
 *     `probe.ts`'s `boundedFetch`/`safeProbeUrl`, the exact same SSRF guard, 10 s deadline, and 64 KB body
 *     cap the connector probe uses, so a vendor's token endpoint gets no weaker a defence than a "Test
 *     connection" call does.
 *
 * Every token this module ever returns is meant for the caller to encrypt with `crypto.ts#encryptVault`
 * immediately - nothing here ever holds a live token longer than one request, and nothing here ever logs
 * one (an upstream token-endpoint error body is truncated the same way `probe.ts` truncates one, never
 * echoed with the client secret it was sent with).
 */
import { b64urlToBytes, bytesToB64url } from '../crypto'
import { boundedFetch, isUnsafeProbeHost, PROBE_TIMEOUT_MS, readCapped, type ProbeDeps } from './probe'
import { isOAuthConfigured, oauthEnvValue, type ConnectorCatalogEntry, type OAuthConfig } from './catalog'

const enc = new TextEncoder()

// ── HKDF-SHA256 + HMAC state token (same construction as gateway-token.ts, independent info string) ──

export const OAUTH_STATE_INFO = 'metis-oauth-state-v1'
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource))
}

/** RFC 5869 HKDF-SHA256, one 32-byte output block. Zero salt (32 zero bytes, `HashLen`, per the RFC when
 *  the caller supplies none) - `OPERATOR_INGEST_SECRET` is itself high-entropy, so no separate salt is
 *  needed to make this a secure derivation. */
async function hkdfSha256(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const salt = new Uint8Array(32)
  const prk = await hmacSha256(salt, ikm)
  const infoBytes = enc.encode(info)
  const t1Input = new Uint8Array(infoBytes.length + 1)
  t1Input.set(infoBytes, 0)
  t1Input[infoBytes.length] = 1
  const t1 = await hmacSha256(prk, t1Input)
  return t1.slice(0, length)
}

async function deriveStateKey(secret: string): Promise<CryptoKey> {
  const keyBytes = await hkdfSha256(enc.encode(secret), OAUTH_STATE_INFO, 32)
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** A kind id is always one of the fixed `ConnectorKind` strings from the shared catalog core - this is
 *  deliberately still a pattern check (not a catalog lookup) so a malformed claim is rejected before any
 *  lookup, the same defensive shape `gateway-token.ts`'s `DEVICE_ID_RE`/`CONNECTION_ID_RE` use. */
const KIND_RE = /^[a-z0-9-]{1,40}$/
/** An Access-verified email: bounded length, no control characters, matches what `resolveAdminIdentity`
 *  already validated before this module ever sees it - checked again here defensively. */
const ACTOR_RE = /^[^\s\x00-\x1f]{1,200}$/
const NONCE_RE = /^[A-Za-z0-9-]{8,128}$/

export interface OAuthStateClaims {
  kind: string
  actor: string
  nonce: string
  /** PKCE code_verifier, present only when `catalog.ts`'s `oauth.pkce` is true for this kind. */
  verifier?: string
  /** The tenant/data-centre field the drawer collected before `oauth/start` (e.g. Zoho's `dataCenter`),
   *  carried through the round trip since the vendor's callback never echoes it back. At most one small
   *  string entry in practice (`catalog.ts` allows one `tenantField` per kind); bounded generously below
   *  so a malformed or hostile state can never smuggle an oversized payload through. */
  config?: Record<string, string>
  iat: number
  exp: number
}

const CONFIG_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/
const CONFIG_VALUE_MAX_LENGTH = 200
const CONFIG_MAX_KEYS = 4

function validConfigShape(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > CONFIG_MAX_KEYS) return false
  return entries.every(([k, v]) => CONFIG_KEY_RE.test(k) && typeof v === 'string' && v.length <= CONFIG_VALUE_MAX_LENGTH)
}

function validClaimsShape(value: unknown): value is OAuthStateClaims {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    typeof c.kind === 'string' &&
    KIND_RE.test(c.kind) &&
    typeof c.actor === 'string' &&
    ACTOR_RE.test(c.actor) &&
    typeof c.nonce === 'string' &&
    NONCE_RE.test(c.nonce) &&
    (c.verifier === undefined || (typeof c.verifier === 'string' && c.verifier.length >= 43 && c.verifier.length <= 128)) &&
    validConfigShape(c.config) &&
    typeof c.iat === 'number' &&
    Number.isFinite(c.iat) &&
    typeof c.exp === 'number' &&
    Number.isFinite(c.exp) &&
    c.exp > c.iat
  )
}

export async function mintOAuthState(
  secret: string,
  kind: string,
  actor: string,
  nonce: string,
  now: number,
  opts: { verifier?: string; config?: Record<string, string> } = {}
): Promise<string> {
  const claims: OAuthStateClaims = { kind, actor, nonce, verifier: opts.verifier, config: opts.config, iat: now, exp: now + OAUTH_STATE_TTL_MS }
  const payloadB64 = bytesToB64url(enc.encode(JSON.stringify(claims)))
  const key = await deriveStateKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64) as BufferSource))
  return `${payloadB64}.${bytesToB64url(sig)}`
}

export type OAuthStateResult =
  | { ok: true; claims: OAuthStateClaims }
  | { ok: false; error: string; code: 'malformed' | 'bad-signature' | 'bad-claims' | 'expired' | 'not-yet-valid' | 'replay' }

const CLOCK_SKEW_MS = 5000

/** `seenNonce`, when given, is expected to be `(nonce) => store.takeNonce(nonce, now)` - `true` means
 *  the nonce was already consumed (a replay). Signature and claim shape are always checked before the
 *  nonce is even looked at, the same ordering `verifyIngestHmac` uses and for the same reason: an
 *  unauthenticated caller must never be able to burn a real nonce (or a real caller's) by probing with
 *  garbage state values. */
export async function verifyOAuthState(
  secret: string,
  token: string,
  now: number,
  seenNonce?: (nonce: string) => Promise<boolean>
): Promise<OAuthStateResult> {
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: 'malformed state', code: 'malformed' }
  }
  const [payloadB64, sigB64] = parts
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)))
  } catch {
    return { ok: false, error: 'malformed state', code: 'malformed' }
  }
  if (!validClaimsShape(claims)) {
    return { ok: false, error: 'malformed state claims', code: 'bad-claims' }
  }
  let expectedSig: Uint8Array
  let providedSig: Uint8Array
  try {
    const key = await deriveStateKey(secret)
    expectedSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64) as BufferSource))
    providedSig = b64urlToBytes(sigB64)
  } catch {
    return { ok: false, error: 'malformed state', code: 'malformed' }
  }
  if (!timingSafeEqualBytes(expectedSig, providedSig)) {
    return { ok: false, error: 'bad state signature', code: 'bad-signature' }
  }
  if (now > claims.exp) {
    return { ok: false, error: 'state expired', code: 'expired' }
  }
  if (now + CLOCK_SKEW_MS < claims.iat) {
    return { ok: false, error: 'state not yet valid', code: 'not-yet-valid' }
  }
  // Only a request that already proved it holds a validly-signed state may consume the nonce - checking
  // the signature first stops an unauthenticated caller from burning a real nonce with a forged one.
  if (seenNonce && (await seenNonce(claims.nonce))) {
    return { ok: false, error: 'state already used', code: 'replay' }
  }
  return { ok: true, claims }
}

// ── PKCE (RFC 7636) ────────────────────────────────────────────────────────────────────────────────

const PKCE_VERIFIER_BYTES = 32 // -> 43 base64url chars, within RFC 7636's 43-128 range

export interface PkcePair {
  verifier: string
  challenge: string
}

export async function generatePkce(): Promise<PkcePair> {
  const verifier = bytesToB64url(crypto.getRandomValues(new Uint8Array(PKCE_VERIFIER_BYTES)))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier)))
  return { verifier, challenge: bytesToB64url(digest) }
}

// ── template rendering (verbatim - see catalog.ts's OAuthConfig doc comment for why) ─────────────────

/** Unlike `RestProbeSpec.url`'s templating in `probe.ts` (which percent-encodes every placeholder except
 *  `{baseUrl}`, since it is filling in arbitrary credential/query values), every OAuth template
 *  placeholder here is a URL prefix or a domain-safe tenant id/data-centre host - substituted verbatim,
 *  never encoded, or `https://{instanceUrl}/services/oauth2/token` would become a broken
 *  `https%3A%2F%2F...` URL. */
export function renderOAuthTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
}

// ── env lookups (see catalog.ts's `oauthEnvValue` doc comment for why this is a string-keyed lookup) ──

export interface OAuthClientCredentials {
  clientId: string
  clientSecret: string
}

/** `null` when either half of the pair is unbound or blank - callers answer the same 503
 *  `oauth-unconfigured` shape `routes/connectors-oauth.ts` needs either way. */
export function oauthClientCredentials(entry: ConnectorCatalogEntry, env: unknown): OAuthClientCredentials | null {
  if (!isOAuthConfigured(entry, env)) return null
  const oauth = entry.oauth as OAuthConfig
  return {
    clientId: (oauthEnvValue(env, oauth.clientIdEnv) as string).trim(),
    clientSecret: (oauthEnvValue(env, oauth.clientSecretEnv) as string).trim()
  }
}

// ── token endpoint calls ───────────────────────────────────────────────────────────────────────────

export interface OAuthTokenPayload {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. Absent `expires_in` from the vendor is treated as "expires now" (`REFRESH_MARGIN_MS`
   *  below then always says "refresh me"), never as "never expires" - an OAuth access token that does
   *  not say how long it lives must be treated as already due for a refresh, not trusted indefinitely. */
  expiresAt: number
  tokenType?: string
}

export interface OAuthError {
  code: 'bad-config' | 'insecure-scheme' | 'host-blocked' | 'timeout' | 'network-error' | 'upstream-error' | 'bad-response' | 'redirect'
  message: string
}

export type OAuthTokenResult = { ok: true; payload: OAuthTokenPayload } | { ok: false; error: OAuthError }

const MAX_ERROR_SNIPPET = 200

/** Truncates and strips the literal client secret from an upstream error body before it is ever returned
 *  - the caller stores `error.message` in `last_test_json` (item 4), same "never in a JSON response
 *  beyond last4" rule the rest of the connectors module follows. Pattern-based redaction is not enough
 *  on its own (a vendor-issued secret rarely matches a generic "looks like a token" shape), so the known
 *  secret value is stripped by exact substring first - the same belt-and-suspenders `probe.ts`'s
 *  `scrubCredential` uses. */
function sanitizeTokenErrorText(raw: string, clientSecret: string): string {
  let text = raw.slice(0, MAX_ERROR_SNIPPET)
  if (clientSecret.length >= 4) text = text.split(clientSecret).join('[redacted]')
  return text
}

interface TokenRequestParams {
  url: string
  body: URLSearchParams
  clientSecret: string
  deps: ProbeDeps
}

async function postTokenRequest({ url, body, clientSecret, deps }: TokenRequestParams): Promise<OAuthTokenResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: { code: 'bad-config', message: 'The token endpoint is not a valid URL.' } }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: { code: 'insecure-scheme', message: 'Only https token endpoints are allowed.' } }
  }
  if (isUnsafeProbeHost(parsed.hostname)) {
    return { ok: false, error: { code: 'host-blocked', message: 'This token endpoint is not reachable.' } }
  }
  const deadlineAt = Date.now() + PROBE_TIMEOUT_MS
  const fetched = await boundedFetch(
    deps.fetch,
    url,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() },
    deadlineAt
  )
  if (fetched.timedOut) return { ok: false, error: { code: 'timeout', message: `No response within ${PROBE_TIMEOUT_MS / 1000} seconds.` } }
  if (fetched.networkError || !fetched.res) return { ok: false, error: { code: 'network-error', message: 'Could not reach the token endpoint.' } }
  // Parity with probeRest (probe.ts): a redirect is never followed and never treated as a generic
  // upstream error - a 3xx here most often means the tokenUrl template (or a tenant value it embeds,
  // e.g. Zoho's dataCenter) is wrong, and blindly letting fetch auto-follow it would resend the freshly
  // minted client_secret body to whatever Location the response names.
  if (fetched.res.status >= 300 && fetched.res.status < 400) {
    return { ok: false, error: { code: 'redirect', message: 'The token endpoint returned a redirect. Redirects are not followed.' } }
  }
  const bodyRead = await readCapped(fetched.res, deadlineAt)
  if (bodyRead.timedOut) return { ok: false, error: { code: 'timeout', message: `No response within ${PROBE_TIMEOUT_MS / 1000} seconds.` } }

  let json: unknown = null
  try {
    json = bodyRead.text ? JSON.parse(bodyRead.text) : null
  } catch {
    json = null
  }
  if (!fetched.res.ok || !json || typeof json !== 'object' || typeof (json as Record<string, unknown>).access_token !== 'string') {
    return { ok: false, error: { code: 'upstream-error', message: sanitizeTokenErrorText(bodyRead.text || `HTTP ${fetched.res.status}`, clientSecret) } }
  }
  const body2 = json as Record<string, unknown>
  const accessToken = body2.access_token as string
  const refreshToken = typeof body2.refresh_token === 'string' ? body2.refresh_token : undefined
  const expiresIn = typeof body2.expires_in === 'number' && Number.isFinite(body2.expires_in) ? body2.expires_in : 0
  const tokenType = typeof body2.token_type === 'string' ? body2.token_type : undefined
  return { ok: true, payload: { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000, tokenType } }
}

export interface ExchangeAuthorizationCodeInput {
  code: string
  redirectUri: string
  /** Only sent when `entry.oauth.pkce` is true - see `OAuthStateClaims.verifier`. */
  codeVerifier?: string
}

/** `config` is the tenant/data-centre value(s) the drawer collected before `oauth/start` (e.g.
 *  Zoho's `dataCenter`) - templated into `entry.oauth.tokenUrl` the same way `oauth/start` templates
 *  `authorizeUrl`. */
export async function exchangeAuthorizationCode(
  entry: ConnectorCatalogEntry,
  config: Record<string, string>,
  input: ExchangeAuthorizationCodeInput,
  credentials: OAuthClientCredentials,
  deps: ProbeDeps
): Promise<OAuthTokenResult> {
  const oauth = entry.oauth
  if (!oauth || oauth.flow !== 'auth-code') {
    return { ok: false, error: { code: 'bad-config', message: 'This connector kind does not use the authorization-code flow.' } }
  }
  const url = renderOAuthTemplate(oauth.tokenUrl, config)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret
  })
  if (oauth.pkce && input.codeVerifier) body.set('code_verifier', input.codeVerifier)
  return postTokenRequest({ url, body, clientSecret: credentials.clientSecret, deps })
}

// ── refresh ────────────────────────────────────────────────────────────────────────────────────────

export const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000

/** True once `payload.expiresAt` is within `OAUTH_REFRESH_MARGIN_MS` of `now` (or already past it) - the
 *  exact "within 5 minutes of expiry" test the gateway and the seat-delivery path (direct mode only;
 *  brokered mode never hands the token to a seat at all) run before using a stored access token. */
export function oauthTokenNeedsRefresh(payload: Pick<OAuthTokenPayload, 'expiresAt'>, now: number): boolean {
  return payload.expiresAt - now <= OAUTH_REFRESH_MARGIN_MS
}

export type OAuthRefreshResult =
  | { ok: true; payload: OAuthTokenPayload }
  | { ok: false; error: OAuthError | { code: 'not-oauth' | 'no-refresh-token' | 'oauth-unconfigured'; message: string } }

/**
 * Re-runs the refresh_token grant for an auth-code-flow connection (item 4). Pure with respect to
 * storage: this function only talks to the vendor's token endpoint and returns the new payload (or a
 * typed failure) for the caller to persist - it never touches `env.DB`/the store itself, so the same
 * "a refresh failure marks the row's last_test_json as failing and never deletes the row" rule is the
 * caller's to enforce (`routes/integrations-seat.ts`'s direct-mode delivery does; the gateway's own
 * wiring is B3/dev-broker's, documented in the report). Deliberately scoped to `flow: 'auth-code'` rows
 * only: a `client-credentials` kind's stored secret in this catalog's current design is the vendor's own
 * per-connection client secret, never exchanged for a token by this task's routes, so there is no issued
 * access token on that kind of row yet to refresh - see the report's open question.
 */
export async function refreshOAuthToken(
  kind: string,
  currentPayload: OAuthTokenPayload,
  config: Record<string, string>,
  env: unknown,
  deps: ProbeDeps,
  getEntry: (kind: string) => ConnectorCatalogEntry | null
): Promise<OAuthRefreshResult> {
  const entry = getEntry(kind)
  if (!entry?.oauth || entry.oauth.flow !== 'auth-code') {
    return { ok: false, error: { code: 'not-oauth', message: 'This connection does not use the authorization-code flow.' } }
  }
  if (!currentPayload.refreshToken) {
    return { ok: false, error: { code: 'no-refresh-token', message: 'No refresh token was ever issued for this connection.' } }
  }
  const credentials = oauthClientCredentials(entry, env)
  if (!credentials) {
    return { ok: false, error: { code: 'oauth-unconfigured', message: 'The OAuth client id or secret is no longer bound.' } }
  }
  const url = renderOAuthTemplate(entry.oauth.tokenUrl, config)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentPayload.refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret
  })
  const result = await postTokenRequest({ url, body, clientSecret: credentials.clientSecret, deps })
  if (!result.ok) return result
  // Most vendors omit refresh_token on a refresh response (the old one stays valid); keep it rather than
  // silently dropping the connection's ability to refresh again next time.
  const payload: OAuthTokenPayload = { ...result.payload, refreshToken: result.payload.refreshToken ?? currentPayload.refreshToken }
  return { ok: true, payload }
}
