/**
 * QA fixture overlay for the Connectors page (agent brief: "add fixtureFor<Page>() ... never
 * hand-typed KPI numbers"). operator/src/render/fixture.ts (a file this page does not own) seeds 5
 * connectors -- 3 connected, 2 failing, exactly the "5 connectors, 2 failing" the plan's section
 * review cadence asks every P1 page fixture to carry -- as real `IntegrationRow` objects carrying
 * the same `last_test_json`/`last_test_at`/`transport`/`auth_kind` extra columns a live D1 row
 * would (see that file's `FixtureIntegrationRow`).
 *
 * `dashboard.ts`'s `connectors` field (plan 6.10c) now derives this page's exact wire shape from
 * those seeded rows through the real `integrationSummary()`/`deriveHealth()` (task B2) the same way
 * production does, so this module no longer reimplements that derivation by hand: it is a thin
 * pass-through onto `fixtureDashboard()`'s own `connectors` field, kept only so this page's tests
 * and any preview/screenshot harness get the catalog alongside it without re-deriving one query
 * twice for the fixture.
 */
import type { DashboardPayload } from '../../dashboard'
import { publicConnectorCatalog, type PublicConnectorCatalogEntry } from '../../connectors/catalog'
import { fixtureDashboard, FIXTURE_NOW } from '../fixture'
import type { ConnectorSummary } from './connectors'

export interface ConnectorsFixture {
  dashboard: DashboardPayload
  catalog: PublicConnectorCatalogEntry[]
  connectors: ConnectorSummary[]
}

/** Richer payload than fixtureDashboard() alone: the same seeded store's connector rows, already
 *  reshaped by the real `buildDashboard()` into the wire shape GET /v1/admin/integrations returns,
 *  plus the code catalog. Used by this page's own test and offered to QA for a preview/screenshot
 *  harness that wants to seed the Connected table without a live Worker in front of it. */
export async function fixtureForConnectors(now: number = FIXTURE_NOW): Promise<ConnectorsFixture> {
  const dashboard = await fixtureDashboard(now)
  const catalog = publicConnectorCatalog()
  return { dashboard, catalog, connectors: dashboard.connectors }
}
