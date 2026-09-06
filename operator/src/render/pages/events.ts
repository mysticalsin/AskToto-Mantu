/**
 * Events page (plan 6.4). Moved out of operator/src/ui.ts (plan P0.4) unchanged in behaviour.
 */
import { looksLikeSecret } from '../../redact'
import type { DashboardPayload } from '../../dashboard'
import { esc, pageHeader, type RenderCtx } from '../index'
import { field, MISSING, when } from './_shared'

function chipVal(chips: { key: string; value: string }[], key: string): string | null {
  const hit = chips.find((c) => c.key === key)
  return hit && !looksLikeSecret(hit.value) ? hit.value : null
}

export function renderEvents(data: DashboardPayload, _ctx: RenderCtx): string {
  const eventRows = data.events
    .map((e) => {
      const chips = e.chips.map((c) => `${c.key} ${c.value}`).join(' ')
      const q = `${e.name} ${e.hostname || ''} ${e.email || ''} ${chips}`.toLowerCase()
      return `<tr data-event="${esc(e.id)}" data-q="${esc(q)}">
        <td class="muted">${esc(when(e.ts))}</td>
        <td>${esc(looksLikeSecret(e.name) ? 'event' : e.name)}</td>
        <td>${field(e.hostname || e.email)}</td>
        <td>${field(chipVal(e.chips, 'city'))}</td>
        <td class="muted">${esc(chipVal(e.chips, 'device') || MISSING)}</td>
        <td class="muted">${esc(chipVal(e.chips, 'os') || MISSING)}</td>
      </tr>`
    })
    .join('')
  return `${pageHeader({ title: 'Events', subtitle: 'Everything the fleet reported, newest first.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Events</p>
      <input class="search-bar" id="events-search" type="search" placeholder="Search events, computers, SSO, country…" autocomplete="off">
      <table id="events-table"><thead><tr><th>Created at</th><th>Name</th><th>Profile</th><th>City</th><th>Device</th><th>OS</th></tr></thead><tbody>${eventRows}</tbody></table>
      ${
        eventRows
          ? '<div class="sub muted pad-b8">Real HMAC ingest only. Token-shaped values are dropped. Empty search shows every row.</div>'
          : '<div class="empty">No events yet.</div>'
      }
    </article>`
}
