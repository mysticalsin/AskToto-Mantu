/**
 * Sessions page fixture overlay (see the file header note in operator/src/render/fixture.ts and
 * the task brief "If your page needs fixture data the shared fixture lacks"). `fixtureDashboard()`
 * has no per-session rows: `DashboardPayload.profiles` is one row per seat, not one row per
 * session, and Sessions needs the real session grain (started/ended, pulses, asks, recaps, tier,
 * live) the store already computes -- the exact shape `GET /v1/admin/sessions.json`
 * (operator/src/routes/sessions.ts) returns to a real browser.
 *
 * Rather than re-deriving that shape by hand (which would drift from the real route the moment
 * either one changes), this seeds the same fixture rows into a fresh store and calls the real
 * route handler through `handleRequest` -- the same production code path a browser hits, so the
 * fixture can never disagree with what Tony's Sessions page actually renders from live data.
 */
import { buildDashboard, type DashboardPayload } from '../../dashboard'
import { handleRequest, type Env } from '../../index'
import { memoryStore } from '../../store'
import type { SessionListRow } from '../../routes/sessions'
import { fixtureRows, seedStore, FIXTURE_EMAIL, FIXTURE_NOW } from '../fixture'

const FIXTURE_ENV: Env = {
  OPERATOR_INGEST_SECRET: 'fixture-ingest-secret-not-a-real-secret',
  OPERATOR_PROMPT_KEY: 'fixture-prompt-key-not-a-real-secret',
  OPERATOR_SKILL_PRIVATE_KEY: ''
}

const FIXTURE_ACCESS = { access: { getIdentity: async () => ({ email: FIXTURE_EMAIL }) } }

export interface SessionsFixture {
  /** The full dashboard payload (KPIs, profiles, geo...), from the same seeded store. */
  data: DashboardPayload
  /** Every session row the real `/v1/admin/sessions.json` route returns for this fixture, newest
   *  first, unfiltered (range=30d, limit=200 -- generous enough that the 12-seat / 6-country
   *  fixture never truncates). */
  sessions: SessionListRow[]
}

export async function fixtureForSessions(now: number = FIXTURE_NOW): Promise<SessionsFixture> {
  const rows = fixtureRows(now)
  const store = memoryStore()
  await seedStore(store, rows)

  const [data, sessionsRes] = await Promise.all([
    buildDashboard(store, FIXTURE_EMAIL, now),
    handleRequest(
      new Request('https://operator.fixture/v1/admin/sessions.json?range=30d&limit=200'),
      FIXTURE_ENV,
      FIXTURE_ACCESS,
      { store, now }
    )
  ])
  const sessionsBody = (await sessionsRes.json()) as { ok: boolean; rows: SessionListRow[] }
  if (!sessionsBody.ok) throw new Error('fixtureForSessions: /v1/admin/sessions.json returned ok:false')

  return { data, sessions: sessionsBody.rows }
}
