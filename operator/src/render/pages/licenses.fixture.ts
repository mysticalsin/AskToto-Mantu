/**
 * Licenses page fixture overlay (plan 6.7, task rule: "if your page needs fixture data the
 * shared fixture lacks, add it in operator/src/render/pages/<page>.fixture.ts as an overlay
 * function ... derived from rows, never hand-typed KPI numbers").
 *
 * operator/src/dashboard.ts's `licenses.issued` trims `IssuedLicenseRow` down to
 * `{jti, last4, days, exp, revoked, createdAt}` (dashboard.ts is a locked shared file, see this
 * page's build report for the exact additive patch that would remove the need for this overlay).
 * The full rows -- tier, group, member, issued by, activation -- already exist in
 * `operator/src/store.ts`'s `IssuedLicenseRow` and in `fixtureRows()`'s `issuedLicenses` /
 * `groups` arrays; this overlay reads those same rows (never a hand typed value) and reshapes
 * them into the `LicensesExtra` the render module already accepts as its optional third
 * argument, exactly the enrichment operator/client/pages/licenses.ts fetches at runtime from
 * `GET /v1/admin/groups` + the per-license fields already present on issued rows once a seat's
 * own group detail view is loaded. Using it here means the test and the preview both exercise
 * the full column set instead of only the "not tracked yet" fallback path.
 */
import { fixtureDashboard, fixtureRows, FIXTURE_NOW } from '../fixture'
import type { DashboardPayload } from '../../dashboard'
import type { LicensesExtra } from './licenses'

export interface LicensesFixture {
  data: DashboardPayload
  extra: LicensesExtra
}

/** `fixtureDashboard()` + a `LicensesExtra` derived from the same `fixtureRows()` the dashboard
 *  was built from -- never a second, hand typed set of numbers. */
export async function fixtureForLicenses(now: number = FIXTURE_NOW): Promise<LicensesFixture> {
  const data = await fixtureDashboard(now)
  const rows = fixtureRows(now)

  const groupNameById = new Map(rows.groups.map((g) => [g.id, g.name]))
  const groups = rows.groups.map((g) => ({ id: g.id, name: g.name, tier: g.tier }))
  const tiers = rows.tiers.map((t) => ({ id: t.id, label: t.label }))

  const issued: LicensesExtra['issued'] = {}
  for (const lic of rows.issuedLicenses) {
    issued[lic.jti] = {
      tier: lic.tier ?? null,
      groupId: lic.group_id ?? null,
      groupName: lic.group_id ? (groupNameById.get(lic.group_id) ?? null) : null,
      member: lic.member ?? null,
      issuedBy: lic.created_by ?? null,
      activatedDevice: lic.activated_device ?? null,
      activatedAt: lic.activated_at ?? null
    }
  }

  return { data, extra: { groups, tiers, issued } }
}
