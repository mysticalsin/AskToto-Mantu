/**
 * Overview page fixture overlay (plan: "if your page needs fixture data the shared fixture
 * lacks, add an overlay function fixtureFor<Page>() that starts from fixtureDashboard() and
 * returns a richer payload derived from rows, never hand-typed KPI numbers").
 *
 * The shared `fixtureDashboard()` (operator/src/render/fixture.ts, not owned by this page) calls
 * `buildDashboard()` with no `DashboardValueSettings`, so `roi.hourlyRate` and `roi.valueMinor`
 * are always null there -- the Value tile's populated branch (plan 3.7b law 3) never renders
 * against it. This overlay rebuilds the exact same seeded store (`fixtureRows()` /
 * `seedStore()`, both exported by fixture.ts for exactly this purpose) and runs the real
 * `buildDashboard()` again with an hourly rate set, so `valueMinor` is computed the same way
 * production computes it -- from real recap-derived time saved times a real rate -- never a
 * hand-typed KPI.
 */
import { buildDashboard, type DashboardPayload, type DashboardValueSettings } from '../../dashboard'
import { getConnectorCatalogEntry } from '../../connectors/catalog'
import { relativeTime } from '../primitives'
import { memoryStore } from '../../store'
import { FIXTURE_EMAIL, FIXTURE_NOW, fixtureRows, seedStore } from '../fixture'
import type { OverviewConnectorSummary } from './overview'

/** $150.00/hour in CAD, the value law's minor-unit contract (plan roi.valueMinor: integer cents). */
export const OVERVIEW_FIXTURE_VALUE_SETTINGS: DashboardValueSettings = {
  hourlyRate: 15000,
  currency: 'CAD'
}

export async function fixtureForOverview(now: number = FIXTURE_NOW): Promise<DashboardPayload> {
  const store = memoryStore()
  await seedStore(store, fixtureRows(now))
  return buildDashboard(store, FIXTURE_EMAIL, now, undefined, undefined, OVERVIEW_FIXTURE_VALUE_SETTINGS)
}

/**
 * Connectors card fixture (QA gate: "Add fixture rows -- needs-attention and connected examples
 * -- to overview.fixture.ts"). Reshapes operator/src/render/fixture.ts's own 5-row, "2 failing"
 * connector seed (the same rows fixtureForOverview() above seeds into the store) into the
 * Connectors card's input shape -- every field traces to that real seed row, never a hand-typed
 * KPI: `kind`/`label`/`healthy` read the row itself, `transport` comes from the real code catalog
 * (`getConnectorCatalogEntry`), and the needs-attention `reason` is the real elapsed time since
 * that row's own `last_used_at` (plan 6.10b's own example, "Test failed 2 hours ago", built from
 * a real timestamp rather than typed as a string).
 */
export function fixtureOverviewConnectors(now: number = FIXTURE_NOW): OverviewConnectorSummary[] {
  const { integrations } = fixtureRows(now)
  return integrations.map((row) => {
    const entry = getConnectorCatalogEntry(row.kind)
    const healthy = row.status !== 'failing'
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      transport: entry?.transport === 'mcp' ? 'mcp' : 'rest',
      healthy,
      reason: healthy ? undefined : `Test failed ${relativeTime(row.last_used_at ?? now, now)} ago.`,
      toolsCount: healthy ? Math.max(1, Math.round(row.uses / 25)) : undefined
    }
  })
}
