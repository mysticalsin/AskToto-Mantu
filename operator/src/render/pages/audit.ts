/**
 * Audit page (plan 6.11b). `data.change.timeline` is already built from the D1 `audit` table
 * (operator/src/dashboard.ts) -- never a fabricated row. P0.4 scope: the richer page with route,
 * request id and CSV/XLSX export (plan D11) lands in P1.11.
 */
import type { DashboardPayload } from '../../dashboard'
import { emptyState, esc, pageHeader, type RenderCtx } from '../index'
import { when } from './_shared'

export function renderAudit(data: DashboardPayload, _ctx: RenderCtx): string {
  const rows = data.change.timeline
  const body = rows.length
    ? `<table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows
        .map(
          (a) => `<tr>
        <td class="muted">${esc(when(a.ts))}</td>
        <td>${esc(a.actor)}</td>
        <td>${esc(a.action)}</td>
        <td class="muted">${esc(a.detail)}</td>
      </tr>`
        )
        .join('')}</tbody></table>`
    : emptyState({
        title: 'No audit rows yet.',
        description: 'Every action you take here will appear in this list.'
      })
  return `${pageHeader({ title: 'Audit', subtitle: 'Every admin action, in order.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Audit</p>
      ${body}
    </article>`
}
