/**
 * Overlay fixture for the Notifications page (plan: "add it in <page>.fixture.ts ... starts from
 * fixtureDashboard() and returns a richer payload derived from rows, never hand-typed KPI
 * numbers"). Four of the six notice kinds need nothing extra: the shared fixture
 * (operator/src/render/fixture.ts) already seeds a seat pending approval, a failed and an
 * expired CRM push, a pending skill proposal, and an issued license expiring in 5 days, so
 * `renderNotifications(await fixtureDashboard(), ctx)` alone already exercises Seat, License,
 * CRM and Skill.
 *
 * Connector and Platform notices are not on DashboardPayload at all (plan 6.8: Connectors is its
 * own JSON route, `/v1/admin/integrations`; platform health is `/v1/admin/health.json`) --
 * operator/client/pages/notifications.ts fetches both after mount and calls renderNotifications()
 * again with the result. This overlay exercises that same `extra` parameter for tests and
 * previews:
 *  - Connector notices are derived from `fixtureRows().integrations` (real rows, not invented):
 *    two of the five seeded connectors carry `status: 'failing'`.
 *  - The platform notice is a representative example, not derived from a fixture row: unlike
 *    every other DashboardPayload field, `/health.json`'s binding flags read live Worker `env`
 *    bindings, which operator/src/render/fixture.ts has no concept of (it only ever seeds D1
 *    rows through a memory store). This is the one case in this page's fixture that is a
 *    hand-authored example rather than a derivation, exactly because there is no "row" for it to
 *    derive from -- flagged here rather than silently treated as fixture-derived data.
 */
import type { DashboardPayload } from '../../dashboard'
import { fixtureDashboard, fixtureRows, FIXTURE_NOW } from '../fixture'
import type { ConnectorNoticeInput, NotificationsExtra, PlatformNoticeInput } from './notifications'

export async function fixtureForNotifications(
  now: number = FIXTURE_NOW
): Promise<{ data: DashboardPayload; extra: NotificationsExtra }> {
  const data = await fixtureDashboard(now)
  const rows = fixtureRows(now)

  const connectors: ConnectorNoticeInput[] = rows.integrations
    .filter((row) => row.status === 'failing')
    .map((row) => ({
      id: row.id,
      label: row.label,
      detail: 'The last connection test failed: request timed out after 10s.',
      ts: row.last_used_at ?? now
    }))

  const platform: PlatformNoticeInput[] = [
    {
      id: 'platform-fixture-oauth',
      title: 'Cloudflare OAuth credentials is not configured',
      detail: 'Set this binding in the Worker environment so this capability works.',
      ts: now
    }
  ]

  return { data, extra: { connectors, platform } }
}
