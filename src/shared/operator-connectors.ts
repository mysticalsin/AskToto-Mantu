/**
 * Connector catalog core (plan section 4, D9 "Connector catalog is code"). Pure data and types only, no
 * Worker and no Node/Electron imports, so this one module compiles under both the operator Worker
 * tsconfig and the desktop app's tsconfig. `operator/src/connectors/catalog.ts` extends every entry here
 * with Worker-only detail (fields, probes); the desktop's entitlement layer (`operator-entitlements.ts`)
 * is meant to derive its own kind list from `CONNECTOR_KINDS` so the two lists cannot drift (DT1, later).
 *
 * Kind ids match `operator/src/connectors/logo-slugs.ts` exactly, one to one, since a kind id is also the
 * logo file name (`operator/public/logos/<kind>.svg`).
 */

export const CONNECTOR_CATEGORIES = ['crm', 'work', 'support', 'knowledge', 'dev', 'comms', 'custom'] as const
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number]

export const CONNECTOR_TRANSPORTS = ['mcp', 'rest'] as const
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number]

export const CONNECTOR_AUTH_KINDS = [
  'bearer',
  'api-key-header',
  'basic',
  'api-key-query',
  'none',
  'oauth2-client-credentials',
  'oauth2-auth-code'
] as const
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number]

export const CONNECTOR_AVAILABILITY = ['ready', 'needs-oauth'] as const
export type ConnectorAvailability = (typeof CONNECTOR_AVAILABILITY)[number]

export const CONNECTOR_KINDS = [
  'hubspot',
  'salesforce',
  'pipedrive',
  'zoho',
  'dynamics365',
  'attio',
  'close',
  'clickup',
  'jira',
  'linear',
  'asana',
  'monday',
  'trello',
  'plane',
  'notion',
  'airtable',
  'zendesk',
  'intercom',
  'freshdesk',
  'confluence',
  'sharepoint',
  'googledrive',
  'github',
  'gitlab',
  'slack',
  'microsoftteams',
  'custom-mcp',
  'custom-rest'
] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

const CONNECTOR_KIND_SET: ReadonlySet<string> = new Set(CONNECTOR_KINDS)

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return typeof value === 'string' && CONNECTOR_KIND_SET.has(value)
}

/** Core, catalog-wide facts about a connector kind. `operator/src/connectors/catalog.ts` extends each
 *  entry with `fields`, `probe` and other Worker-only detail; the shape here is everything the desktop
 *  (a shared, non-Worker consumer) is ever expected to need. */
export interface ConnectorCatalogCore {
  kind: ConnectorKind
  label: string
  category: ConnectorCategory
  transport: ConnectorTransport
  auth: ConnectorAuthKind
  availability: ConnectorAvailability
  docsUrl: string
  /** Always equal to `kind`: the logo file is `operator/public/logos/<kind>.svg`. Kept as its own field
   *  (rather than callers reusing `kind`) so a future catalog entry could point at a shared logo without
   *  a schema change. */
  logo: ConnectorKind
}

export const CONNECTOR_CATALOG_CORE: Record<ConnectorKind, ConnectorCatalogCore> = {
  hubspot: {
    kind: 'hubspot',
    label: 'HubSpot',
    category: 'crm',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    logo: 'hubspot'
  },
  salesforce: {
    kind: 'salesforce',
    label: 'Salesforce',
    category: 'crm',
    transport: 'rest',
    auth: 'oauth2-client-credentials',
    availability: 'needs-oauth',
    docsUrl: 'https://developer.salesforce.com/docs',
    logo: 'salesforce'
  },
  pipedrive: {
    kind: 'pipedrive',
    label: 'Pipedrive',
    category: 'crm',
    transport: 'rest',
    // Corrected from 'api-key-query': Pipedrive's current docs specify the token in an x-api-token
    // header against a company-specific domain, not a v1-style ?api_token= query param. See
    // operator/src/connectors/catalog.ts's pipedrive entry for the verification source and why its
    // probe is null (no documented lightweight v2 "who am I" endpoint).
    auth: 'api-key-header',
    availability: 'ready',
    docsUrl: 'https://pipedrive.readme.io/docs/how-to-find-the-api-token',
    logo: 'pipedrive'
  },
  zoho: {
    kind: 'zoho',
    label: 'Zoho CRM',
    category: 'crm',
    transport: 'rest',
    // Corrected from 'oauth2-client-credentials': Zoho CRM has no client_credentials grant. Its
    // "Server-based Applications" registration supports a standard browser authorization-code
    // redirect (GET https://accounts.zoho.<dc>/oauth/v2/auth, verified 2026-09-06 at
    // zoho.com/crm/developer/docs/api/v6/multi-dc.html), which is what the Operator's generic
    // auth-code flow (operator/src/connectors/oauth.ts) drives.
    auth: 'oauth2-auth-code',
    availability: 'needs-oauth',
    docsUrl: 'https://www.zoho.com/crm/developer/docs/api/v6/oauth-overview.html',
    logo: 'zoho'
  },
  dynamics365: {
    kind: 'dynamics365',
    label: 'Microsoft Dynamics 365',
    category: 'crm',
    transport: 'rest',
    auth: 'oauth2-client-credentials',
    availability: 'needs-oauth',
    docsUrl: 'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview',
    logo: 'dynamics365'
  },
  attio: {
    kind: 'attio',
    label: 'Attio',
    category: 'crm',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://docs.attio.com/rest-api/overview',
    logo: 'attio'
  },
  close: {
    kind: 'close',
    label: 'Close',
    category: 'crm',
    transport: 'rest',
    auth: 'basic',
    availability: 'ready',
    docsUrl: 'https://developer.close.com/api/overview/api-key-authentication',
    logo: 'close'
  },
  clickup: {
    kind: 'clickup',
    label: 'ClickUp',
    category: 'work',
    transport: 'rest',
    auth: 'api-key-header',
    availability: 'ready',
    docsUrl: 'https://developer.clickup.com/reference/getauthorizeduser',
    logo: 'clickup'
  },
  jira: {
    kind: 'jira',
    label: 'Jira',
    category: 'work',
    transport: 'rest',
    auth: 'basic',
    availability: 'ready',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/',
    logo: 'jira'
  },
  linear: {
    kind: 'linear',
    label: 'Linear',
    category: 'work',
    transport: 'rest',
    auth: 'api-key-header',
    availability: 'ready',
    docsUrl: 'https://linear.app/developers/graphql',
    logo: 'linear'
  },
  asana: {
    kind: 'asana',
    label: 'Asana',
    category: 'work',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://developers.asana.com/reference/getuser',
    logo: 'asana'
  },
  monday: {
    kind: 'monday',
    label: 'monday.com',
    category: 'work',
    transport: 'rest',
    auth: 'api-key-header',
    availability: 'ready',
    docsUrl: 'https://developer.monday.com/api-reference/docs/authentication',
    logo: 'monday'
  },
  trello: {
    kind: 'trello',
    label: 'Trello',
    category: 'work',
    transport: 'rest',
    auth: 'api-key-query',
    availability: 'ready',
    docsUrl: 'https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/',
    logo: 'trello'
  },
  plane: {
    kind: 'plane',
    label: 'Plane',
    category: 'work',
    transport: 'rest',
    auth: 'api-key-header',
    availability: 'ready',
    docsUrl: 'https://developers.plane.so/api-reference/introduction',
    logo: 'plane'
  },
  notion: {
    kind: 'notion',
    label: 'Notion',
    category: 'knowledge',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://developers.notion.com/reference/get-self',
    logo: 'notion'
  },
  airtable: {
    kind: 'airtable',
    label: 'Airtable',
    category: 'work',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://airtable.com/developers/web/api/get-user-id-and-scopes',
    logo: 'airtable'
  },
  zendesk: {
    kind: 'zendesk',
    label: 'Zendesk',
    category: 'support',
    transport: 'rest',
    auth: 'basic',
    availability: 'ready',
    docsUrl: 'https://developer.zendesk.com/api-reference/ticketing/users/users/',
    logo: 'zendesk'
  },
  intercom: {
    kind: 'intercom',
    label: 'Intercom',
    category: 'support',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://developers.intercom.com/docs/references/rest-api/api.intercom.io/me/getcurrentadmin',
    logo: 'intercom'
  },
  freshdesk: {
    kind: 'freshdesk',
    label: 'Freshdesk',
    category: 'support',
    transport: 'rest',
    auth: 'basic',
    availability: 'ready',
    docsUrl: 'https://developers.freshdesk.com/api/',
    logo: 'freshdesk'
  },
  confluence: {
    kind: 'confluence',
    label: 'Confluence',
    category: 'knowledge',
    transport: 'rest',
    auth: 'basic',
    availability: 'ready',
    docsUrl: 'https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-users/',
    logo: 'confluence'
  },
  sharepoint: {
    kind: 'sharepoint',
    label: 'SharePoint',
    category: 'knowledge',
    transport: 'rest',
    auth: 'oauth2-client-credentials',
    availability: 'needs-oauth',
    docsUrl: 'https://learn.microsoft.com/en-us/sharepoint/dev/',
    logo: 'sharepoint'
  },
  googledrive: {
    kind: 'googledrive',
    label: 'Google Drive',
    category: 'knowledge',
    transport: 'rest',
    auth: 'oauth2-auth-code',
    availability: 'needs-oauth',
    docsUrl: 'https://developers.google.com/drive/api/guides/about-sdk',
    logo: 'googledrive'
  },
  github: {
    kind: 'github',
    label: 'GitHub',
    category: 'dev',
    transport: 'mcp',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://github.com/github/github-mcp-server',
    logo: 'github'
  },
  gitlab: {
    kind: 'gitlab',
    label: 'GitLab',
    category: 'dev',
    transport: 'rest',
    auth: 'api-key-header',
    availability: 'ready',
    docsUrl: 'https://docs.gitlab.com/api/rest/authentication/',
    logo: 'gitlab'
  },
  slack: {
    kind: 'slack',
    label: 'Slack',
    category: 'comms',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://docs.slack.dev/reference/methods/auth.test/',
    logo: 'slack'
  },
  microsoftteams: {
    kind: 'microsoftteams',
    label: 'Microsoft Teams',
    category: 'comms',
    transport: 'rest',
    auth: 'oauth2-client-credentials',
    availability: 'needs-oauth',
    docsUrl: 'https://learn.microsoft.com/en-us/microsoftteams/platform/',
    logo: 'microsoftteams'
  },
  'custom-mcp': {
    kind: 'custom-mcp',
    label: 'Custom MCP server',
    category: 'custom',
    transport: 'mcp',
    auth: 'bearer',
    availability: 'ready',
    docsUrl: 'https://modelcontextprotocol.io/',
    logo: 'custom-mcp'
  },
  'custom-rest': {
    kind: 'custom-rest',
    label: 'Custom REST server',
    category: 'custom',
    transport: 'rest',
    auth: 'bearer',
    availability: 'ready',
    // No vendor docs exist for a user-defined server; the drawer hides the "Docs" link for an empty URL.
    docsUrl: '',
    logo: 'custom-rest'
  }
}
