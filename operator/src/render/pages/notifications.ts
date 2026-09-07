/**
 * Notifications page (plan 6.8). Moved out of operator/src/ui.ts (plan P0.4) unchanged in
 * behaviour. The CRM funnel and skill diff editor stay here for P0.4 (plan 6.8 moves them to
 * Events › CRM and Settings › Skills once those tabs exist, P1 scope).
 */
import { statusBadge } from '../../components/ui/status-badge'
import { CRM_FILTER_ORDER } from '../../crm'
import type { DashboardPayload } from '../../dashboard'
import { esc, pageHeader, type RenderCtx } from '../index'
import { field, kpiCard, MISSING, when } from './_shared'

export function renderNotifications(data: DashboardPayload, _ctx: RenderCtx): string {
  const canRetry = (status: string): boolean => status === 'failed' || status === 'expired'
  const crmRows = data.crm.rows
    .map((r) => {
      const remote = r.remoteUrl
        ? `<a href="${esc(r.remoteUrl)}" rel="noreferrer">${esc(r.remoteId || 'open')}</a>`
        : r.remoteId
          ? esc(r.remoteId)
          : ''
      const retry =
        canRetry(r.status)
          ? `<button data-retry="${esc(r.id)}">Retry</button>`
          : r.retryRequested
            ? '<span class="muted">retry asked</span>'
            : ''
      return `<tr data-status="${esc(r.status)}">
        <td>${statusBadge(r.status)}</td>
        <td>${esc(r.title)}${r.error ? `<div class="muted">${esc(r.error)}</div>` : ''}</td>
        <td class="muted">${esc(r.connector)}${r.action ? ` · ${esc(r.action)}` : ''}</td>
        <td class="muted remote">${remote}</td>
        <td class="muted">${r.attempt || ''}</td>
        <td class="muted">${esc(r.meetingHash || '')}</td>
        <td class="muted">${esc(when(r.ts))}</td>
        <td>${retry}</td>
      </tr>`
    })
    .join('')
  const landing = data.crm.landing
  const failRate = landing.failRatePct == null ? 'hidden' : `${landing.failRatePct}%`
  const funnelRows = data.crm.funnel
    .map((f) => {
      const att = Math.max(f.attempted, 1)
      const okW = Math.round((f.success / att) * 100)
      const failW = Math.round((f.failed / att) * 100)
      return `<div class="crm-funnel-row">
        <span class="muted">${esc(f.connector)}</span>
        <div class="crm-funnel-track" title="attempted ${f.attempted}">
          <svg class="crm-funnel-ok" width="${okW}%" height="100%" aria-hidden="true"></svg>
          <svg class="crm-funnel-fail" width="${failW}%" height="100%" aria-hidden="true"></svg>
        </div>
        <span class="muted">${f.attempted} att · ${f.submitted} sub · ${f.success} ok · ${f.failed} fail</span>
      </div>`
    })
    .join('')
  const noticeRows = data.notices
    .map(
      (n) => `<tr data-q="${esc(`${n.kind} ${n.title} ${n.detail} ${n.profile || ''} ${n.city || ''}`.toLowerCase())}">
        <td>${esc(n.kind)}</td>
        <td>${esc(n.title)}</td>
        <td>${field(n.profile)}</td>
        <td>${field(n.city)}</td>
        <td class="muted">${esc(n.os || MISSING)}</td>
        <td class="muted">${esc(when(n.ts))}</td>
      </tr>`
    )
    .join('')
  const props = data.proposals
    .map(
      (p) => `<div class="card" data-proposal="${esc(p.id)}">
        <div class="row"><strong>${esc(p.skill_id)}</strong> <span class="pill">${esc(p.status)}</span> <span class="muted">from ${esc(p.from_version)}</span></div>
        <div class="muted">${esc(p.rationale)}</div>
        <div class="muted">${esc(p.created_by)} · ${esc(when(p.created_at))}</div>
        <textarea data-diff="${esc(p.id)}">${esc(p.diff)}</textarea>
        <div class="row">
          ${p.status === 'pending' ? `<button class="primary" data-approve="${esc(p.id)}">Approve</button><button class="danger" data-reject="${esc(p.id)}">Reject</button>` : ''}
          ${p.status === 'approved' ? `<button class="primary" data-push="${esc(p.id)}">Push</button>` : ''}
        </div>
      </div>`
    )
    .join('')
  const funnelTabs = CRM_FILTER_ORDER.map(
    (s) =>
      `<button class="tab" data-crm-filter="${s}" type="button">${statusBadge(s)} ${data.crm.counts[s]}</button>`
  ).join('')
  return `${pageHeader({ title: 'Notifications', subtitle: 'What needs attention.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Notifications</p>
      <div class="sub muted pad-b8">Pending seat approvals, failed CRM pushes, and skill diffs. Real D1. Not a stub.</div>
      ${
        noticeRows
          ? `<table data-notice-table><thead><tr><th>Kind</th><th>Title</th><th>Profile</th><th>City</th><th>OS</th><th>When</th></tr></thead><tbody>${noticeRows}</tbody></table>`
          : '<div class="empty">Nothing needs Tony right now.</div>'
      }
    </article>
    <article class="card pad-b10" data-crm-notices>
      <p class="eyebrow">Data-push telemetry</p>
      <div class="sub muted pad-b8">Outbound Métis → CRM / DB. Seat HMAC ingest <code>event=crm</code> → Operator D1 <code>crm_sends</code> → named connector. Retry marks retry_requested; the seat processes it. Never auto-send.</div>
      <div class="crm-kpis">
        ${kpiCard({ title: 'Landed today', value: String(landing.landedToday), sub: 'success with a remote id', spark: '' })}
        ${kpiCard({ title: 'Fail rate', value: failRate, sub: 'failed + expired over attempted', spark: '' })}
        ${kpiCard({ title: 'Retries', value: String(landing.retries), sub: 'Tony Retry or attempt over 1', spark: '' })}
        ${kpiCard({ title: 'Dead letters', value: String(landing.deadLetters), sub: 'max attempts, Expired', spark: '' })}
      </div>
      ${funnelRows ? `<p class="eyebrow">Funnel by connector</p><div class="crm-funnel">${funnelRows}</div>` : ''}
      <div class="funnel tabs" id="crm-filters">
        <button class="tab on" data-crm-filter="all">All ${data.crm.rows.length}</button>
        ${funnelTabs}
      </div>
      ${
        crmRows
          ? `<table id="crm-table"><thead><tr><th>Status</th><th>Title</th><th>Connector</th><th>Remote</th><th>Try</th><th>Meeting</th><th>When</th><th></th></tr></thead><tbody>${crmRows}</tbody></table>`
          : '<div class="empty">No outbound pushes ingested yet.</div>'
      }
    </article>
    <article class="card pad-b10" data-skill-notices>
      <div class="row mg-b8">
        <p class="eyebrow mg-0">Skill upgrades</p>
        <button data-draft="interview">Draft interview</button>
        <button data-draft="recruiting">Draft recruiting</button>
        <button data-draft="support">Draft support</button>
      </div>
      ${props || '<div class="empty">No skill upgrades waiting. Use Ask in a mode, then Draft.</div>'}
    </article>`
}
