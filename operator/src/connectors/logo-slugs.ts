/**
 * Connector kind -> Simple Icons slug (plan D9 catalog, plan 3.6 iconography).
 *
 * operator/scripts/build-assets.mjs looks each slug up in the installed `simple-icons` package
 * at build time and writes the brand SVG to operator/public/logos/<kind>.svg with the brand hex
 * as `fill`. A `null` slug, or a slug this version of simple-icons does not carry, makes the
 * build script generate a monogram SVG instead (first letter of the label from
 * `src/shared/operator-connectors.ts`'s `CONNECTOR_CATALOG_CORE`, rounded square,
 * --accent-soft / --accent-fill ink) -- never a hand-drawn brand mark. The build script fails
 * loudly if a kind in that shared list has no entry here.
 *
 * `ConnectorKind` and `CONNECTOR_KINDS` come from the shared catalog core (plan D9: "the desktop
 * kind list is generated from the same source ... so the two lists cannot drift") rather than a
 * duplicate local union -- this file used to define its own copy before that shared module
 * existed; now it does not, so there is exactly one list of kinds in the repo.
 */
export { type ConnectorKind, CONNECTOR_KINDS } from '../../../src/shared/operator-connectors'
import type { ConnectorKind } from '../../../src/shared/operator-connectors'

/**
 * Best-known Simple Icons slug per kind. Verified against simple-icons@16.30.0 (2026-09-06):
 * salesforce, pipedrive, dynamics365, attio, close, monday, freshdesk, sharepoint, slack and
 * microsoftteams have no entry in that version (Slack and every Microsoft-branded mark were
 * removed from the package after trademark takedown requests) -- build-assets.mjs generates a
 * monogram for those and for the two `custom-*` kinds, which never had a brand slug to begin
 * with.
 */
export const LOGO_SLUGS: Record<ConnectorKind, string | null> = {
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  pipedrive: 'pipedrive',
  zoho: 'zoho',
  dynamics365: 'dynamics365',
  attio: 'attio',
  close: 'close',
  clickup: 'clickup',
  jira: 'jira',
  linear: 'linear',
  asana: 'asana',
  monday: 'mondaydotcom',
  trello: 'trello',
  plane: 'plane',
  notion: 'notion',
  airtable: 'airtable',
  zendesk: 'zendesk',
  intercom: 'intercom',
  freshdesk: 'freshdesk',
  confluence: 'confluence',
  sharepoint: 'sharepoint',
  googledrive: 'googledrive',
  github: 'github',
  gitlab: 'gitlab',
  slack: 'slack',
  microsoftteams: 'microsoftteams',
  'custom-mcp': null,
  'custom-rest': null
}
