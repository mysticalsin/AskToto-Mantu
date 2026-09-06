/**
 * Events page fixture overlay (plan 6.4, task rule: "if your page needs fixture data the shared
 * fixture lacks, add it in operator/src/render/pages/<page>.fixture.ts ... derived from rows,
 * never hand-typed KPI numbers").
 *
 * operator/src/render/fixture.ts's fixtureDashboard() alone only ever shows three of the eleven
 * ingest kinds in `data.events` -- verified: 40 ask, 12 crm, 24 recap, 0 of every other kind, out
 * of 76 merged rows -- because its seed data never writes a heartbeat-kind `EventRow` (a
 * heartbeat only ever becomes a `PulseRow`, see fixture.ts's `buildAsksAndPulses`). That starves
 * the kind chips row and the "Events" tab of any variety worth a screenshot or a real filter
 * test. This overlay seeds one extra heartbeat `EventRow` per seat -- each seat's own most recent
 * real heartbeat pulse from `fixtureRows().pulses` -- before calling the exact same
 * `buildDashboard()` `fixtureDashboard()` uses, so every number this page shows still traces back
 * to a real fixture row, never an invented one. Everything else (asks, CRM sends, licenses, ...)
 * is exactly what `fixtureDashboard()` already computes.
 */
import { buildDashboard, type DashboardPayload } from '../../dashboard'
import { memoryStore, type EventRow } from '../../store'
import { fixtureRows, seedStore, FIXTURE_EMAIL, FIXTURE_NOW, type FixtureRows } from '../fixture'

/** The seat's own most recent heartbeat pulse, one per seat -- real fixture data, not invented. */
function heartbeatEventsFromPulses(rows: FixtureRows): EventRow[] {
  const latestBySeat = new Map<string, FixtureRows['pulses'][number]>()
  for (const pulse of rows.pulses) {
    if (pulse.kind !== 'heartbeat') continue
    const current = latestBySeat.get(pulse.device_id)
    if (!current || pulse.ts > current.ts) latestBySeat.set(pulse.device_id, pulse)
  }
  const seatsById = new Map(rows.seats.map((s) => [s.device_id, s]))
  return [...latestBySeat.values()].map((pulse) => ({
    id: `fx-events-fixture-heartbeat-${pulse.device_id}`,
    ts: pulse.ts,
    kind: 'heartbeat',
    actor: seatsById.get(pulse.device_id)?.sso_email ?? null,
    device_id: pulse.device_id,
    country: pulse.country,
    detail: null
  }))
}

export async function fixtureForEvents(now: number = FIXTURE_NOW): Promise<DashboardPayload> {
  const rows = fixtureRows(now)
  const store = memoryStore()
  await seedStore(store, rows)
  for (const event of heartbeatEventsFromPulses(rows)) await store.insertEvent(event)
  return buildDashboard(store, FIXTURE_EMAIL, now)
}
