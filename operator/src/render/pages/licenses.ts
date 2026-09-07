/**
 * Licenses page (plan 6.7). Moved out of operator/src/ui.ts (plan P0.4) unchanged in behaviour.
 * The `data-licenses-empty` branch keeps its own dynamic `data.licenses.error` text verbatim
 * (LICENSES_EMPTY from operator/src/fleet.ts) rather than folding into dataTable()'s emptyState,
 * since that text is server-computed, not a fixed title.
 */
import type { DashboardPayload } from '../../dashboard'
import { esc, pageHeader, type RenderCtx } from '../index'
import { approvalPill, field, when } from './_shared'

function renderLicenseGenerateForm(): string {
  return `<form class="key-form license-gen" data-license-generate method="post" action="/v1/admin/licenses/generate" autocomplete="off">
      <p class="sub muted">Pick how long it stays active. Paste the once-string into Métis → Settings → Operator → Operator license. Shown once. last4 after that.</p>
      <div class="row">
        <label>Active for
          <select name="days" required>
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30" selected>30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </select>
        </label>
        <button class="primary" type="submit">Generate license</button>
      </div>
    </form>
    <div class="license-once" hidden data-license-once>
      <p class="sub">Copy this once. It will not be shown again.</p>
      <input data-license-once-value readonly spellcheck="false" />
      <button type="button" class="primary" data-license-once-copy>Copy</button>
    </div>`
}

function renderLicenseGenerate(data: DashboardPayload): string {
  const issued = (data.licenses.issued || [])
    .map((r) => {
      const active = !r.revoked && r.exp * 1000 > Date.now()
      const status = r.revoked ? 'revoked' : active ? 'active' : 'expired'
      return `<tr data-license-status="${status}">
        <td class="muted" data-license-last4="${esc(r.last4)}">··${esc(r.last4)}</td>
        <td class="muted">${r.days}d</td>
        <td class="muted">${esc(when(r.exp * 1000))}</td>
        <td>${r.revoked ? '<span class="pill">revoked</span>' : active ? '<span class="pill up">active</span>' : '<span class="muted">expired</span>'}</td>
      </tr>`
    })
    .join('')
  return `${renderLicenseGenerateForm()}
    ${
      issued
        ? `<table data-issued-licenses><thead><tr><th>Last4</th><th>Duration</th><th>Expires</th><th></th></tr></thead><tbody>${issued}</tbody></table>`
        : '<div class="empty">No Operator licenses generated yet.</div>'
    }`
}

function renderLicensesTable(data: DashboardPayload): string {
  if (data.licenses.empty) {
    return `<div class="fail-loud" data-licenses-empty>${esc(data.licenses.error || 'No licenses in D1')}</div>
      <div class="sub muted">Real Métis heartbeats only. No demo or usage-import rows. Approve a seat or activate an Operator license before platform keys work.</div>`
  }
  const body = data.licenses.rows
    .map((r) => {
      const id = esc(r.device)
      const act =
        r.approval === 'approved'
          ? `<button class="danger" data-license-revoke="${id}">Revoke</button>`
          : `<button class="primary" data-license-approve="${id}">Approve</button>`
      return `<tr data-device="${id}" data-approval="${esc(r.approval)}">
        <td>${field(r.hostname)}</td>
        <td>${field(r.email)}</td>
        <td>${field(r.license)}</td>
        <td>${approvalPill(r.approval)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
        <td>${act}</td>
      </tr>`
    })
    .join('')
  return `<table><thead><tr><th>Computer</th><th>SSO email</th><th>License</th><th>Approval</th><th>OS</th><th>Version</th><th></th></tr></thead><tbody>${body}</tbody></table>
    <div class="sub muted pad-b8">Tony approves a seat or the seat activates an Operator license. Revoke still stops platform keys. last4 only. Never a raw key.</div>`
}

export function renderLicenses(data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({ title: 'Licenses', subtitle: 'A seat may use vault keys and connectors when it is approved or holds an active license. Revoke always wins.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Generate license</p>
      ${renderLicenseGenerate(data)}
    </article>
    <article class="card pad-b10">
      <p class="eyebrow">Licenses</p>
      ${renderLicensesTable(data)}
    </article>`
}
