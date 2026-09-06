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

export interface ConnectorCatalogEntry extends ConnectorCatalogCore {
  fields: ConnectorField[]
  /** Static header name for `api-key-header` kinds with one fixed header (e.g. GitLab's `PRIVATE-TOKEN`).
   *  `custom-mcp` / `custom-rest` instead read a `headerName` the admin supplies as a `config` field. */
  headerName?: string
  /** Fixed MCP endpoint for a hosted server (GitHub). `custom-mcp` has no fixed endpoint; it reads
   *  `config.baseUrl`. */
  endpoint?: string
  probe: ProbeSpec | null
}

function entry(core: ConnectorKind, fields: ConnectorField[], rest: Partial<Pick<ConnectorCatalogEntry, 'headerName' | 'endpoint' | 'probe'>>): ConnectorCatalogEntry {
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
  salesforce: entry('salesforce', [
    { key: 'clientId', label: 'Connected app client id', type: 'text', required: false },
    { key: 'clientSecret', label: 'Connected app client secret', type: 'password', required: false },
    { key: 'instanceUrl', label: 'Instance URL', type: 'url', placeholder: 'https://yourorg.my.salesforce.com', required: false }
  ], {}),
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
  zoho: entry('zoho', [
    { key: 'clientId', label: 'Client id', type: 'text', required: false },
    { key: 'clientSecret', label: 'Client secret', type: 'password', required: false },
    { key: 'accountId', label: 'Data center domain', type: 'text', placeholder: 'zoho.com, zoho.eu, zoho.in, ...', required: false }
  ], {}),
  dynamics365: entry('dynamics365', [
    { key: 'clientId', label: 'Azure AD app client id', type: 'text', required: false },
    { key: 'clientSecret', label: 'Client secret', type: 'password', required: false },
    { key: 'instanceUrl', label: 'Organization URL', type: 'url', placeholder: 'https://yourorg.crm.dynamics.com', required: false }
  ], {}),
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
      CREDENTIAL_FIELD('Token')
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
  sharepoint: entry('sharepoint', [
    { key: 'clientId', label: 'Azure AD app client id', type: 'text', required: false },
    { key: 'clientSecret', label: 'Client secret', type: 'password', required: false },
    { key: 'accountId', label: 'Tenant id', type: 'text', required: false }
  ], {}),
  googledrive: entry('googledrive', [
    { key: 'clientId', label: 'OAuth client id', type: 'text', required: false },
    { key: 'clientSecret', label: 'OAuth client secret', type: 'password', required: false }
  ], {}),
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
  microsoftteams: entry('microsoftteams', [
    { key: 'clientId', label: 'Azure AD app client id', type: 'text', required: false },
    { key: 'clientSecret', label: 'Client secret', type: 'password', required: false },
    { key: 'accountId', label: 'Tenant id', type: 'text', required: false }
  ], {}),
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
 *  URLs, body templates) an unauthenticated-until-Access-checked route response has no business leaking. */
export interface PublicConnectorCatalogEntry {
  kind: ConnectorKind
  label: string
  category: ConnectorCatalogCore['category']
  transport: ConnectorCatalogCore['transport']
  auth: ConnectorCatalogCore['auth']
  availability: ConnectorCatalogCore['availability']
  docsUrl: string
  logo: ConnectorKind
  fields: ConnectorField[]
  headerName?: string
  endpoint?: string
  hasProbe: boolean
}

export function publicConnectorCatalog(): PublicConnectorCatalogEntry[] {
  return CONNECTOR_KINDS.map((kind) => {
    const e = CONNECTOR_CATALOG[kind]
    return {
      kind: e.kind,
      label: e.label,
      category: e.category,
      transport: e.transport,
      auth: e.auth,
      availability: e.availability,
      docsUrl: e.docsUrl,
      logo: e.logo,
      fields: e.fields,
      headerName: e.headerName,
      endpoint: e.transport === 'mcp' ? e.endpoint : undefined,
      hasProbe: e.probe !== null
    }
  })
}
