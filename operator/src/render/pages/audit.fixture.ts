/**
 * Audit page fixture overlay (plan: "if your page needs fixture data the shared fixture lacks,
 * add it in operator/src/render/pages/<page>.fixture.ts ... derived from rows, never hand-typed
 * KPI numbers").
 *
 * `fixtureRows().audit` (operator/src/render/fixture.ts's own `buildAudit()`) seeds 9 rows across
 * only 4 of the 8 action groups this page classifies (licenses, seats, connectors, skills) --
 * verified by running `classifyAuditGroup` over them. Keys, reveals, exports and platform have no
 * representative row to derive from at all. Rather than inventing summary numbers, this overlay
 * adds one additional row per missing group, each through the real production path or with real
 * fixture identifiers, exactly the same way `fixtureRows().audit` itself already writes every row
 * (a direct, typed `store.audit()` call is this file's own established convention, not a shortcut
 * introduced here):
 *
 *  - reveals: a real ask id from `fixtureRows().asks`, the exact action/detail pair
 *    admin-core.ts's reveal route writes (`'reveal'`, `'ask text'`).
 *  - connectors (delivery): a real seat device id and a real connector id from
 *    `fixtureRows().seats` / `.integrations`, the exact action/detail shape
 *    integrations-seat.ts writes (`'integration-delivered'`, the connector's own id).
 *  - platform (last cron run): the real `pruneRetention()` (operator/src/retention.ts, task B6),
 *    run once against this same seeded store -- a genuine heartbeat row with a genuine (all-zero,
 *    nothing here is old enough to prune) summary, never a hand-typed one.
 *  - exports: the real `GET /v1/admin/export.csv?table=audit` route, driven to completion through
 *    `handleRequest` -- its own `auditLog(ctx, 'export', ...)` call fires for real.
 *  - keys: `fixtureRows()` seeds no `vault_keys` row at all, so there is nothing to derive a
 *    `vault-write` row from. This one row is a representative example, not derived data -- the
 *    same exception class operator/src/render/pages/notifications.fixture.ts's platform notice
 *    documents, flagged here rather than silently treated as derived.
 *
 * Everything else (licenses, seats, connectors, skills, every KPI number) is exactly what
 * `fixtureRows()` / `buildDashboard()` already compute.
 */
import { buildDashboard, type DashboardPayload } from '../../dashboard'
import { handleRequest, type Env } from '../../index'
import { memoryStore } from '../../store'
import { pruneRetention } from '../../retention'
import { fixtureRows, seedStore, FIXTURE_EMAIL, FIXTURE_NOW } from '../fixture'
import type { AuditJsonRow } from './audit'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const FIXTURE_ENV: Env = {
  OPERATOR_INGEST_SECRET: 'fixture-ingest-secret-not-a-real-secret',
  OPERATOR_PROMPT_KEY: 'fixture-prompt-key-not-a-real-secret',
  OPERATOR_SKILL_PRIVATE_KEY: ''
}

const FIXTURE_ACCESS = { access: { getIdentity: async () => ({ email: FIXTURE_EMAIL }) } }

export interface AuditFixture {
  /** The full dashboard payload, from the same seeded store -- feeds the SSR first-paint path
   *  (`data.change.timeline`) exactly the way a real request would. */
  data: DashboardPayload
  /** Every row the real `GET /v1/admin/audit.json` route returns for this fixture, newest first --
   *  the exact hydration shape `operator/client/pages/audit.ts` fetches. */
  rows: AuditJsonRow[]
}

export async function fixtureForAudit(now: number = FIXTURE_NOW): Promise<AuditFixture> {
  const rows = fixtureRows(now)
  const store = memoryStore()
  await seedStore(store, rows)

  // reveals: a real ask, admin-core.ts's exact action/detail pair.
  const revealedAsk = rows.asks[0]
  await store.audit(crypto.randomUUID(), now - 3 * HOUR, FIXTURE_EMAIL, 'reveal', revealedAsk.id, 'ask text', {
    requestId: 'req-fx-9',
    route: `/v1/admin/asks/${revealedAsk.id}/reveal`
  })

  // connectors (delivery): a real seat, a real connector id, integrations-seat.ts's exact shape.
  const deliveredSeat = rows.seats[0]
  const deliveredIntegration = rows.integrations[0]
  await store.audit(crypto.randomUUID(), now - 6 * HOUR, deliveredSeat.device_id, 'integration-delivered', null, deliveredIntegration.id)

  // keys: representative example -- fixtureRows() seeds no vault_keys row to derive one from.
  await store.audit(crypto.randomUUID(), now - 30 * DAY, FIXTURE_EMAIL, 'vault-write', null, 'anthropic ··7c31', {
    requestId: 'req-fx-10',
    route: '/v1/admin/keys'
  })

  // platform: the real retention cron heartbeat, run against this exact seeded store.
  await pruneRetention(store, now - HOUR)

  // exports: the real export route, driven to completion so its own audit() call fires for real.
  const exportRes = await handleRequest(
    new Request('https://operator.fixture/v1/admin/export.csv?table=audit'),
    FIXTURE_ENV,
    FIXTURE_ACCESS,
    { store, now: now - 2 * HOUR }
  )
  await exportRes.text()

  const data = await buildDashboard(store, FIXTURE_EMAIL, now)
  const auditRes = await handleRequest(
    new Request('https://operator.fixture/v1/admin/audit.json?limit=100'),
    FIXTURE_ENV,
    FIXTURE_ACCESS,
    { store, now }
  )
  const auditBody = (await auditRes.json()) as { ok: boolean; audit: AuditJsonRow[] }
  if (!auditBody.ok) throw new Error('fixtureForAudit: /v1/admin/audit.json returned ok:false')

  return { data, rows: auditBody.audit }
}
