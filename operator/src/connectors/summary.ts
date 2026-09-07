/**
 * The connector summary shape both `GET /v1/admin/integrations` (`routes/integrations.ts`) and
 * `dashboard.ts`'s `connectors` field return (plan 6.10c: "extending the pattern Licenses already
 * uses to Connectors" -- `buildDashboard()` reads real connector rows on first paint instead of
 * the page fetching its own JSON after load).
 *
 * Pulled out of `routes/integrations.ts` into its own leaf module, dependency-free beyond
 * `./data` and `../store`'s types, on purpose: `dashboard.ts` is reached by the CLIENT bundle at
 * runtime (`render/pages/licenses.ts` imports `ONLINE_MS` from it as a real, non-type-only import,
 * so whatever `dashboard.ts` imports at runtime bundles into the browser). `routes/integrations.ts`
 * itself pulls in `../crypto`, `../vault` and `../connectors/probe`'s SSRF-guarded fetch -- Worker-
 * only code with no business shipping to a browser. Had `dashboard.ts` imported
 * `integrationSummary()` straight from `routes/integrations.ts`, all of that would have bundled
 * into the client for nothing. This module lets both sides share one implementation (the brief's
 * "do not duplicate the query") without that cost.
 */
import { parseDisabledTools, readIntegrationExtra, type IntegrationExtraColumns, type IntegrationMode } from './data'
import type { ProbeResult, ProbeToolInfo } from './probe'
import type { IntegrationRow, OperatorStore } from '../store'

export type IntegrationHealth = 'connected' | 'failing' | 'untested'

export interface ConnectorScope {
  tiers?: string[]
  groups?: string[]
}

/** Wire shape both `GET /v1/admin/integrations` and `DashboardPayload.connectors` return. Mirrored
 *  field-for-field (not imported, to keep the client's render module dependency-free of this one)
 *  by `operator/src/render/pages/connectors.ts`'s own `ConnectorSummary` -- see that file's top
 *  comment for why the two are kept structurally identical instead of one importing the other. */
export interface IntegrationSummary {
  id: string
  kind: string
  label: string
  baseUrl: string | null
  last4: string | null
  status: string
  health: IntegrationHealth
  transport: string | null
  authKind: string | null
  headerName: string | null
  mode: IntegrationMode
  allowWrites: boolean
  scope: ConnectorScope
  notes: string | null
  tools: ProbeToolInfo[] | null
  /** Tool names an admin has switched off on the Tools tab's per-tool enable switch (plan 6.10c).
   *  Always an array, never absent. */
  disabledTools: string[]
  lastTest: ProbeResult | null
  lastTestAt: number | null
  uses: number
  lastUsedAt: number | null
  grantsCount: number
  createdAt: number
  createdBy: string | null
  rotatedAt: number | null
  revokedAt: number | null
}

const GRANTS_COUNT_LIMIT = 5000

/** Derived, never stored: a transient upstream failure must never flip `status` to something
 *  `integrations-seat.ts`'s `entitledInScopeRows()` does not treat as `active`, or one bad test
 *  would cut a working connector for the whole fleet. `health` is what the console shows instead:
 *  `untested` when no test has ever run, else `connected`/`failing` from the last stored
 *  `ProbeResult.ok`. A row with a corrupt `last_test_json` (should not happen; `readIntegrationExtra`
 *  already guards the column) reads as `failing` rather than throwing. */
export function deriveHealth(extra: Pick<IntegrationExtraColumns, 'last_test_json' | 'last_test_at'>): IntegrationHealth {
  if (!extra.last_test_json || extra.last_test_at == null) return 'untested'
  try {
    const parsed = JSON.parse(extra.last_test_json) as { ok?: unknown }
    return parsed?.ok === true ? 'connected' : 'failing'
  } catch {
    return 'failing'
  }
}

/** Only ever an array of strings under `tiers`/`groups`; anything else in the stored JSON (a
 *  corrupt row, a future field this module does not know about yet) is dropped rather than
 *  reaching the page as an unknown shape. */
function typedScope(scopeJson: string): ConnectorScope {
  try {
    const parsed = JSON.parse(scopeJson) as unknown
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

export async function integrationSummary(store: OperatorStore, row: IntegrationRow): Promise<IntegrationSummary> {
  const extra = readIntegrationExtra(row as unknown as Record<string, unknown>)
  const grants = await store.listIntegrationGrants(row.id, GRANTS_COUNT_LIMIT)
  let lastTest: ProbeResult | null = null
  if (extra.last_test_json) {
    try {
      lastTest = JSON.parse(extra.last_test_json) as ProbeResult
    } catch {
      lastTest = null
    }
  }
  let tools: ProbeToolInfo[] | null = null
  if (extra.tools_json) {
    try {
      tools = JSON.parse(extra.tools_json) as ProbeToolInfo[]
    } catch {
      tools = null
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.base_url,
    last4: row.last4,
    status: row.status,
    health: deriveHealth(extra),
    transport: extra.transport,
    authKind: extra.auth_kind,
    headerName: extra.header_name,
    mode: extra.mode,
    allowWrites: extra.allow_writes === 1,
    scope: typedScope(row.scope_json),
    notes: extra.notes,
    tools,
    disabledTools: parseDisabledTools(extra.disabled_tools_json),
    lastTest,
    lastTestAt: extra.last_test_at,
    uses: row.uses,
    lastUsedAt: row.last_used_at,
    grantsCount: grants.length,
    createdAt: row.created_at,
    createdBy: row.created_by,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at
  }
}
