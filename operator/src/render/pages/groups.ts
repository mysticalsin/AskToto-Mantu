/**
 * Groups page (plan 6.6). Honest empty state (P0.2/P0.4 scope: the full page with members,
 * per-group licenses and activity lands in P1.8). No fake rows.
 */
import type { DashboardPayload } from '../../dashboard'
import { emptyState, pageHeader, type RenderCtx } from '../index'

export function renderGroups(_data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({ title: 'Groups', subtitle: 'Teams, tiers and the licenses they hold.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Groups</p>
      ${emptyState({
        title: 'No groups yet.',
        description: 'A group gives a team a tier and its own licenses.'
      })}
    </article>`
}
