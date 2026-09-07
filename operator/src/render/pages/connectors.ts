/**
 * Connectors page (plan 6.10). Honest empty state (P0.2/P0.4 scope: the full catalog + connection
 * drawer lands in P1.9). No fake rows.
 */
import type { DashboardPayload } from '../../dashboard'
import { emptyState, pageHeader, type RenderCtx } from '../index'

export function renderConnectors(_data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({ title: 'Connectors', subtitle: 'CRMs, work tools and MCP servers Métis can reach through the Operator.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Connectors</p>
      ${emptyState({
        title: 'No connectors yet.',
        description: 'Connect a CRM, a work tool or an MCP server and Métis can reach it through the Operator.'
      })}
    </article>`
}
