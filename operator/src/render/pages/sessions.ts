/**
 * Sessions page (plan 6.5). Moved out of operator/src/ui.ts (plan P0.4) unchanged in behaviour.
 * detailDrawer() (design-lead's primitive) already backs the seat overlay; kept as-is.
 */
import type { DashboardPayload, ProfileRow } from '../../dashboard'
import { detailDrawer, esc, pageHeader, type RenderCtx } from '../index'
import { approvalPill, field, MISSING, when } from './_shared'

function renderProfiles(rows: ProfileRow[], osFilter?: string): string {
  const filtered = osFilter
    ? rows.filter((r) => (osFilter === 'darwin' ? r.os === 'darwin' : r.os === 'win' || r.os === 'win32' || r.os === 'windows'))
    : rows
  if (!filtered.length) return '<div class="empty">No seats on the fleet yet.</div>'
  const body = filtered
    .map((r) => {
      const q = `${r.hostname || ''} ${r.email || ''} ${r.city || ''} ${r.country || ''} ${r.deviceId} ${r.os}`.toLowerCase()
      return `<tr data-seat-row data-country="${esc(r.country || '')}" data-os="${esc(r.os)}" data-q="${esc(q)}" data-seat-computer="${esc(r.hostname || r.device)}" data-seat-location="${esc([r.city, r.region, r.country].filter(Boolean).join(' · '))}" data-seat-license="${esc(r.license || '')}" data-seat-identity="${esc(r.email || '')}" data-seat-last="${esc(when(r.lastSeen))}" data-seat-version="${esc(r.appVersion)}" data-seat-status="${r.live ? 'Live' : 'Idle'}" data-seat-status-id="${r.live ? 'live' : 'inactive'}">
        <td>${field(r.hostname)}</td>
        <td>${field(r.city)}</td>
        <td class="muted">${esc(r.country || MISSING)}</td>
        <td class="muted">${esc(r.device)}</td>
        <td>${field(r.email)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
        <td>${field(r.license)}</td>
        <td>${approvalPill(r.approval)}</td>
        <td class="muted">${esc(when(r.lastSeen))}</td>
        <td>${r.live ? '<span class="pill up">live</span>' : '<span class="muted">idle</span>'}</td>
      </tr>`
    })
    .join('')
  return `<table><thead><tr><th>Computer</th><th>City</th><th>Country</th><th>Device</th><th>SSO email</th><th>OS</th><th>Version</th><th>License</th><th>Approval</th><th>Seen</th><th></th></tr></thead><tbody>${body}</tbody></table>`
}

export function renderSessions(data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({ title: 'Sessions', subtitle: 'Seat sessions built from heartbeats, asks and recaps.' })}
    <article class="card pad-b10" data-sessions>
      <p class="eyebrow">Sessions</p>
      <input class="search-bar" id="sessions-search" type="search" placeholder="Search city, device, computer…" autocomplete="off">
      <div class="sub muted pad-b8">Real seats. City from request.cf. usage-import filtered. Idle is last seen, not missing.</div>
      ${renderProfiles(data.profiles)}
      <div id="sessions-empty" class="empty" hidden>No matching sessions.</div>
    </article>
    ${detailDrawer({ id: 'seat-overlay' })}`
}
