/**
 * Admin OAuth 2.0 authorization-code routes (Tony: "clicking a connector must actually connect by
 * opening the vendor's own authorisation page"; plan 6.10b). Two routes, both `auth: 'admin'` so CSRF and
 * Access identity are already enforced by `index.ts` before either handler runs, exactly like every other
 * admin route:
 *
 *  - `GET /v1/admin/connectors/:kind/oauth/start` - 302s to the vendor's consent page.
 *  - `GET /v1/admin/connectors/oauth/callback` - exchanges the code, stores the tokens, and answers with
 *    a tiny self-closing HTML page (never JSON: the tab this opens in has no console UI to render one).
 *
 * All the actual crypto (the signed `state`, PKCE, the token endpoint calls) lives in `../connectors/
 * oauth.ts`; this module is the HTTP glue - reading query params, minting the audit rows, and building the
 * `IntegrationRow` the callback stores through `./integrations.ts`'s `saveIntegration`.
 */
import { encryptVault } from '../crypto'
import { html, json, newCspNonce, noStoreHeaders } from '../http'
import { last4OfSecret } from '../vault'
import { getConnectorCatalogEntry, missingOAuthEnvNames, type ConnectorCatalogEntry } from '../connectors/catalog'
import { INTEGRATION_EXTRA_DEFAULTS, type IntegrationExtraColumns } from '../connectors/data'
import {
  exchangeAuthorizationCode,
  generatePkce,
  mintOAuthState,
  oauthClientCredentials,
  renderOAuthTemplate,
  verifyOAuthState,
  type OAuthTokenPayload
} from '../connectors/oauth'
import type { ProbeDeps } from '../connectors/probe'
import type { IntegrationRow } from '../store'
import { defineRoute, type RouteMatch } from './registry'
import { auditLog, param, safeAuditText, type AdminCtx } from './admin-ctx'
import { saveIntegration } from './integrations'

const CALLBACK_PATH = '/v1/admin/connectors/oauth/callback'

/** Fixed to this Worker's own origin, never taken from the request beyond the origin the platform itself
 *  terminated TLS for (Cloudflare routes `metis-operator*.workers.dev` to this Worker and no other; there
 *  is no query parameter or header this reads to build it) - a vendor's redirect_uri validation is the
 *  second half of this guarantee, refusing anything that does not exactly match what was registered. */
function oauthRedirectUri(request: Request): string {
  return `${new URL(request.url).origin}${CALLBACK_PATH}`
}

function probeDepsFrom(ctx: AdminCtx): ProbeDeps {
  return { fetch: ctx.opts.providerFetch ?? ctx.opts.cfFetch ?? fetch }
}

/** Self-closing result page opened in the new tab `oauth/start` navigated to. Posts one message to
 *  `window.opener` (same-origin only - the Worker's own origin, never `*`) and closes; falls back to a
 *  plain "you can close this tab" sentence when there is no opener (a popup blocker, or the admin opened
 *  the callback URL directly), since a page that can neither message nor close itself must still tell the
 *  admin what happened. The inline `<script>` carries the CSP nonce `http.ts#html` already supports - no
 *  inline handler ships without one, matching the console shell's own script tag. */
function oauthResultPage(result: { ok: boolean; kind: string; label?: string; error?: string }): Response {
  const nonce = newCspNonce()
  const payload = JSON.stringify({ type: 'metis-oauth-result', ok: result.ok, kind: result.kind, label: result.label, error: result.error })
  const heading = result.ok ? `Connected ${escapeHtml(result.label || result.kind)}` : 'Connection failed'
  const detail = result.ok ? 'You can close this tab.' : escapeHtml(result.error || 'Something went wrong.')
  const body = `<!doctype html>
<title>${heading}</title>
<body style="font:14px -apple-system,system-ui,sans-serif;padding:32px;color:#170826;background:#f8f6fd">
<p>${heading}</p>
<p>${detail}</p>
<script nonce="${nonce}">
(function () {
  try {
    if (window.opener) {
      window.opener.postMessage(${JSON.stringify(payload)}, window.location.origin);
      window.close();
    }
  } catch (e) { /* no opener, or it navigated away - the visible sentence above is the fallback */ }
})();
</script>
</body>`
  return html(body, { nonce })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function oauthUnconfigured(entry: ConnectorCatalogEntry, env: unknown): Response {
  return json({ ok: false, error: 'OAuth client not configured', code: 'oauth-unconfigured', missing: missingOAuthEnvNames(entry, env) }, 503)
}

export function registerConnectorsOAuthRoutes(): void {
  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: /^\/v1\/admin\/connectors\/(?<kind>[^/]+)\/oauth\/start$/,
    auth: 'admin',
    handler: async (request, ctx, match: RouteMatch) => {
      const kind = param(match, 'kind')
      const entry = getConnectorCatalogEntry(kind)
      if (!entry?.oauth || entry.oauth.flow !== 'auth-code') {
        return json({ ok: false, error: 'not an authorization-code OAuth connector', code: 'not-oauth' }, 400)
      }
      const credentials = oauthClientCredentials(entry, ctx.env)
      if (!credentials) return oauthUnconfigured(entry, ctx.env)

      const config: Record<string, string> = {}
      if (entry.oauth.tenantField) {
        const value = (ctx.url.searchParams.get(entry.oauth.tenantField.key) || '').trim()
        if (!value) return json({ ok: false, error: `${entry.oauth.tenantField.label} required`, code: 'missing-field', field: entry.oauth.tenantField.key }, 400)
        config[entry.oauth.tenantField.key] = value.slice(0, 200)
      }

      const pkce = entry.oauth.pkce ? await generatePkce() : null
      const nonce = crypto.randomUUID()
      const state = await mintOAuthState(ctx.env.OPERATOR_INGEST_SECRET, kind, ctx.email, nonce, ctx.now, {
        verifier: pkce?.verifier,
        config: Object.keys(config).length ? config : undefined
      })

      const authorizeUrl = new URL(renderOAuthTemplate(entry.oauth.authorizeUrl as string, config))
      authorizeUrl.searchParams.set('client_id', credentials.clientId)
      authorizeUrl.searchParams.set('redirect_uri', oauthRedirectUri(request))
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('scope', entry.oauth.scopes.map((s) => renderOAuthTemplate(s, config)).join(' '))
      authorizeUrl.searchParams.set('state', state)
      if (pkce) {
        authorizeUrl.searchParams.set('code_challenge', pkce.challenge)
        authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      }

      await auditLog(ctx, 'integration-oauth-start', null, kind)
      return new Response(null, { status: 302, headers: { location: authorizeUrl.toString(), ...noStoreHeaders() } })
    }
  })

  defineRoute<AdminCtx>({
    method: 'GET',
    pattern: CALLBACK_PATH,
    auth: 'admin',
    handler: async (request, ctx) => {
      const vendorError = ctx.url.searchParams.get('error')
      if (vendorError) {
        await auditLog(ctx, 'integration-oauth-failed', null, safeAuditText(`vendor denied: ${vendorError}`))
        return oauthResultPage({ ok: false, kind: 'connector', error: 'The vendor declined the request.' })
      }

      const state = ctx.url.searchParams.get('state') || ''
      const verified = await verifyOAuthState(ctx.env.OPERATOR_INGEST_SECRET, state, ctx.now, (nonce) => ctx.store.takeNonce(nonce, ctx.now))
      if (!verified.ok) {
        await auditLog(ctx, 'integration-oauth-failed', null, `state ${verified.code}`)
        return oauthResultPage({ ok: false, kind: 'connector', error: 'This connection link is invalid or has expired. Start again from the connector.' })
      }
      const { kind, actor, config: stateConfig } = verified.claims
      if (actor !== ctx.email) {
        await auditLog(ctx, 'integration-oauth-failed', null, `${kind} actor-mismatch`)
        return oauthResultPage({ ok: false, kind, error: 'Started by a different signed-in admin. Start again.' })
      }
      const entry = getConnectorCatalogEntry(kind)
      if (!entry?.oauth || entry.oauth.flow !== 'auth-code') {
        await auditLog(ctx, 'integration-oauth-failed', null, `${kind} unknown-kind`)
        return oauthResultPage({ ok: false, kind, error: 'Unknown connector kind.' })
      }
      const code = ctx.url.searchParams.get('code') || ''
      if (!code) {
        await auditLog(ctx, 'integration-oauth-failed', null, `${kind} missing-code`)
        return oauthResultPage({ ok: false, kind, error: 'The vendor did not return an authorization code.' })
      }
      const credentials = oauthClientCredentials(entry, ctx.env)
      if (!credentials) {
        await auditLog(ctx, 'integration-oauth-failed', null, `${kind} oauth-unconfigured`)
        return oauthResultPage({ ok: false, kind, error: 'The OAuth client is no longer configured.' })
      }
      if (!ctx.env.OPERATOR_VAULT_KEY) {
        await auditLog(ctx, 'integration-oauth-failed', null, `${kind} vault-unbound`)
        return oauthResultPage({ ok: false, kind, error: 'The vault key is not configured.' })
      }

      const config = stateConfig ?? {}
      const exchanged = await exchangeAuthorizationCode(
        entry,
        config,
        { code, redirectUri: oauthRedirectUri(request), codeVerifier: verified.claims.verifier },
        credentials,
        probeDepsFrom(ctx)
      )
      if (!exchanged.ok) {
        await auditLog(ctx, 'integration-oauth-failed', null, safeAuditText(`${kind} ${exchanged.error.code}: ${exchanged.error.message}`))
        return oauthResultPage({ ok: false, kind, error: 'Could not exchange the authorization code. Check the audit log for detail.' })
      }

      const id = crypto.randomUUID()
      const enc = await encryptVault(encodeOAuthTokenPayload(exchanged.payload), ctx.env.OPERATOR_VAULT_KEY)
      const row: IntegrationRow = {
        id,
        kind: entry.kind,
        label: entry.label,
        base_url: null,
        cipher: enc.cipher,
        iv: enc.iv,
        last4: last4OfSecret(exchanged.payload.accessToken),
        scope_json: '{}',
        status: 'active',
        created_at: ctx.now,
        created_by: ctx.email,
        rotated_at: null,
        revoked_at: null,
        last_used_at: null,
        uses: 0
      }
      const extra: IntegrationExtraColumns = {
        ...INTEGRATION_EXTRA_DEFAULTS,
        auth_kind: entry.auth,
        transport: entry.transport,
        mode: 'brokered',
        config_json: JSON.stringify(config)
      }
      await saveIntegration(ctx, row, extra)
      await auditLog(ctx, 'integration-oauth-connected', null, `${entry.kind} ${entry.label} ·${row.last4}`)
      return oauthResultPage({ ok: true, kind, label: entry.label })
    }
  })
}

/** The exact shape `oauth.ts#OAuthTokenPayload` encrypts into `cipher`/`iv` - kept here (not exported
 *  from `oauth.ts`) since encoding/decoding the vault plaintext is this route module's concern, the same
 *  split `vault.ts`'s `encodeVaultPlaintext`/`decodeVaultPlaintext` draws for provider keys. */
export function encodeOAuthTokenPayload(payload: OAuthTokenPayload): string {
  return JSON.stringify(payload)
}

export function decodeOAuthTokenPayload(plaintext: string): OAuthTokenPayload | null {
  try {
    const parsed = JSON.parse(plaintext) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    if (typeof p.accessToken !== 'string' || typeof p.expiresAt !== 'number') return null
    return {
      accessToken: p.accessToken,
      refreshToken: typeof p.refreshToken === 'string' ? p.refreshToken : undefined,
      expiresAt: p.expiresAt,
      tokenType: typeof p.tokenType === 'string' ? p.tokenType : undefined
    }
  } catch {
    return null
  }
}
