/**
 * QA fixture overlay for the Connectors page (agent brief: "add fixtureFor<Page>() ... never
 * hand-typed KPI numbers"). operator/src/render/fixture.ts (a file this page does not own) already
 * seeds 5 connectors -- 3 connected, 2 failing, exactly the "5 connectors, 2 failing" the plan's
 * section review cadence asks every P1 page fixture to carry -- but only as raw `IntegrationRow`
 * objects; `DashboardPayload` itself carries none of that (see connectors.ts's top comment: the
 * only trace in the shared payload is the derived `failingConnectors` count for the rail badge).
 *
 * `fixtureForConnectors()` turns those same rows into the exact `ConnectorSummary[]` shape
 * `GET /v1/admin/integrations` returns, deriving every field from the seed row itself rather than
 * typing new numbers: `health` from the seed's own `status` literal (a pre-task-B2 fixture
 * convention, `'connected' | 'failing'`, not yet the real `'active' | 'revoked'` the Worker writes
 * today -- see the inline note below), `lastTestAt`/`uses` from the row's own `last_used_at`/
 * `uses`, `scope` by parsing the row's own `scope_json`. The one thing with no real-probe
 * equivalent to derive from is the probe's human summary sentence, built the same plausible-but-
 * clearly-synthetic way operator/src/render/fixture.ts's own CRM rows already do for a fake error
 * message ("Upstream responded 503"): a short sentence, not a number.
 */
import type { DashboardPayload } from '../../dashboard'
import { getConnectorCatalogEntry, publicConnectorCatalog, type PublicConnectorCatalogEntry } from '../../connectors/catalog'
import { fixtureDashboard, fixtureRows, FIXTURE_NOW } from '../fixture'
import type { IntegrationGrantRow, IntegrationRow } from '../../store'
import { catalogByKind, type ConnectorScope, type ConnectorSummary } from './connectors'

function parseScope(json: string): ConnectorScope {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const { tiers, groups } = parsed as { tiers?: unknown; groups?: unknown }
    const out: ConnectorScope = {}
    if (Array.isArray(tiers)) out.tiers = tiers.filter((t): t is string => typeof t === 'string')
    if (Array.isArray(groups)) out.groups = groups.filter((g): g is string => typeof g === 'string')
    return out
  } catch {
    return {}
  }
}

/** The fixture's own `IntegrationRow.status` predates task B2's health model (it was seeded as
 *  `'connected' | 'failing'`, a fixture-only convention -- see operator/src/render/fixture.ts's
 *  `ConnectorSeed` type). Real rows only ever carry `'active' | 'revoked'` (routes/integrations.ts's
 *  `deriveHealth()` doc comment); every fixture row here is a currently-active connection, so this
 *  reads the seed's own field as the health signal it was clearly meant to be, rather than
 *  mis-sorting every seeded row into "revoked" history.
 */
function summaryFor(row: IntegrationRow, grants: IntegrationGrantRow[], catalog: Record<string, PublicConnectorCatalogEntry>): ConnectorSummary {
  const entry = getConnectorCatalogEntry(row.kind)
  const ok = row.status !== 'failing'
  const label = catalog[row.kind]?.label || row.kind
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.base_url,
    last4: row.last4,
    status: 'active',
    health: ok ? 'connected' : 'failing',
    transport: entry?.transport ?? null,
    authKind: entry?.auth ?? null,
    headerName: entry?.headerName ?? null,
    mode: 'brokered',
    allowWrites: false,
    scope: parseScope(row.scope_json),
    notes: null,
    tools: null,
    lastTest: {
      ok,
      status: ok ? 200 : 503,
      latencyMs: ok ? 180 : 4200,
      summary: ok ? `Reached ${label}, status 200.` : 'The provider responded with status 503.',
      error: ok ? undefined : { code: 'bad-status', message: 'The provider responded with status 503.' }
    },
    lastTestAt: row.last_used_at,
    uses: row.uses,
    lastUsedAt: row.last_used_at,
    grantsCount: grants.filter((g) => g.integration_id === row.id).length,
    createdAt: row.created_at,
    createdBy: row.created_by,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at
  }
}

export interface ConnectorsFixture {
  dashboard: DashboardPayload
  catalog: PublicConnectorCatalogEntry[]
  connectors: ConnectorSummary[]
}

/** Richer payload than fixtureDashboard() alone: the same seeded store's connector rows, reshaped
 *  into the wire shape GET /v1/admin/integrations returns, plus the code catalog. Used by this
 *  page's own test and offered to QA for a preview/screenshot harness that wants to seed the
 *  Connected table without a live Worker in front of it. */
export async function fixtureForConnectors(now: number = FIXTURE_NOW): Promise<ConnectorsFixture> {
  const dashboard = await fixtureDashboard(now)
  const rows = fixtureRows(now)
  const catalog = publicConnectorCatalog()
  const byKind = catalogByKind(catalog)
  const connectors = rows.integrations.map((row) => summaryFor(row, rows.integrationGrants, byKind))
  return { dashboard, catalog, connectors }
}
