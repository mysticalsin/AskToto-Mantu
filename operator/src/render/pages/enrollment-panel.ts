/**
 * Settings > Enrolment (O05). Server-rendered like every other page card; the interactive parts are wired by
 * `operator/client/pages/settings.ts` through `data-enroll-*` hooks and call the owner-only routes in
 * `operator/src/routes/enroll-admin.ts`, which stay the enforcement boundary. The panel never shows a token
 * secret or hash (only a once-shown box filled in the browser right after creation) and never shows a
 * configured SSO value (the tenant is its last 4 characters; client ids and domains are counts).
 */
import type { DashboardEnrollment, DashboardPayload } from '../../dashboard'
import { emptyState, esc } from '../index'
import { when } from './_shared'

const ENROLL_CHANNELS = ['release', 'qa', 'staging'] as const

function tokenStatusPill(status: 'active' | 'revoked' | 'expired'): string {
  return `<span class="pill${status === 'active' ? ' up' : ''}" data-enroll-token-status="${status}">${status}</span>`
}

function tokenRows(enrollment: DashboardEnrollment): string {
  return enrollment.tokens
    .map((t) => {
      const action =
        t.status !== 'active'
          ? `<span class="muted">${t.revokedAt ? esc(`revoked ${when(t.revokedAt)}`) : 'expired'}</span>`
          : enrollment.isOwner
            ? `<label class="muted"><input type="checkbox" data-enroll-cascade="${esc(t.kid)}"> also revoke the ${t.enrolledCount} ${t.enrolledCount === 1 ? 'device' : 'devices'} enrolled with this token</label>
               <button class="danger" type="button" data-enroll-revoke="${esc(t.kid)}">Revoke</button>`
            : ''
      return `<tr data-enroll-token="${esc(t.kid)}" data-status="${t.status}">
        <td>${esc(t.label)}</td>
        <td class="muted">${esc(t.channel)}</td>
        <td class="muted">··${esc(t.kid.slice(-6))}</td>
        <td class="muted">${esc(when(t.createdAt))}</td>
        <td class="muted">${esc(when(t.expiresAt))}</td>
        <td class="muted">${t.enrolledCount} / ${t.maxDevices}</td>
        <td class="muted">${t.enrolledToday} / ${t.dailyCap}</td>
        <td>${tokenStatusPill(t.status)}</td>
        <td>${action}</td>
      </tr>`
    })
    .join('')
}

function ssoStatusLine(enrollment: DashboardEnrollment): string {
  const { sso } = enrollment
  if (!sso.configured) {
    return `<p data-enroll-sso="off">SSO enrolment is not configured. Set the Worker secrets ENROLL_SSO_TENANT_ID, ENROLL_SSO_CLIENT_IDS and ENROLL_SSO_ALLOWED_DOMAINS to turn it on. Signed-in users then enrol with the token path until you do.</p>`
  }
  return `<p data-enroll-sso="on">SSO enrolment is configured: tenant ··${esc(sso.tenantLast4 ?? '')}, ${sso.clientIdCount} client ${sso.clientIdCount === 1 ? 'id' : 'ids'}, ${sso.domainCount} allowed ${sso.domainCount === 1 ? 'domain' : 'domains'}. Values are never shown here.</p>`
}

function ownerControls(enrollment: DashboardEnrollment): string {
  const { settings } = enrollment
  const tiers = Array.from(new Set(['reporting', ...enrollment.tierIds]))
  return `<form class="key-form" data-enroll-settings method="post" action="/v1/admin/settings/enroll" autocomplete="off">
      <div class="row">
        <label>SSO seats get tier
          <select name="ssoTier">${tiers.map((id) => `<option value="${esc(id)}"${id === settings.ssoTier ? ' selected' : ''}>${esc(id)}</option>`).join('')}</select>
        </label>
        <label>Devices per user
          <input type="number" name="ssoMaxDevicesPerUser" min="1" max="100" step="1" value="${settings.ssoMaxDevicesPerUser}" required>
        </label>
        <button class="primary" type="submit">Save</button>
      </div>
      <p class="sub muted">A seat enrolled through SSO gets this tier. Reporting means usage and health only, with no entitlements.</p>
    </form>
    <form class="key-form" data-enroll-create method="post" action="/v1/admin/enroll-tokens" autocomplete="off">
      <div class="row">
        <label>Label <input type="text" name="label" maxlength="64" required placeholder="Release 2.12"></label>
        <label>Channel
          <select name="channel">${ENROLL_CHANNELS.map((c) => `<option value="${c}"${c === enrollment.channel ? ' selected' : ''}>${c}</option>`).join('')}</select>
        </label>
        <label>Expires in (days) <input type="number" name="expiresInDays" min="1" max="365" step="1" value="180"></label>
        <label>Max devices <input type="number" name="maxDevices" min="1" max="100000" step="1" value="5000"></label>
        <label>Per day <input type="number" name="dailyCap" min="1" max="100000" step="1" value="500"></label>
        <button class="primary" type="submit">Generate token</button>
      </div>
      <p class="sub muted">A token can only enrol devices, only with the Reporting tier, for 30 days at a time. It is embedded in release builds, so treat it as public: its seats are labelled Unverified.</p>
    </form>
    <div class="license-once" hidden data-enroll-once>
      <p class="sub">Store this as the CI secret, it will not be shown again.</p>
      <input data-enroll-once-value readonly spellcheck="false">
      <button type="button" class="primary" data-enroll-once-copy>Copy</button>
    </div>`
}

export function renderEnrollmentPanel(data: DashboardPayload): string {
  const e = data.enrollment
  const pausedLine = e.settings.paused
    ? `<p data-enroll-state="paused"><strong>Enrolment is paused.</strong> No new seat can enrol and no licence is renewed. Seats that are already enrolled keep working.</p>`
    : `<p data-enroll-state="active"><strong>Enrolment is active.</strong> Métis installs report to this Operator without anyone entering anything.</p>`
  const pauseButton = e.isOwner
    ? `<button type="button" class="${e.settings.paused ? 'primary' : 'danger'}" data-enroll-pause="${e.settings.paused ? 'false' : 'true'}">${e.settings.paused ? 'Resume enrolment' : 'Pause enrolment'}</button>`
    : ''
  const tokens = e.tokens.length
    ? `<table data-enroll-tokens><thead><tr><th>Label</th><th>Channel</th><th>Token</th><th>Created</th><th>Expires</th><th>Devices</th><th>Today</th><th>Status</th><th></th></tr></thead><tbody>${tokenRows(e)}</tbody></table>`
    : emptyState({
        title: 'No enrolment tokens yet.',
        description: 'Generate one to let signed-out installs enrol. Signed-in users do not need it.'
      })
  return `<article class="card pad-b10" data-enroll-panel data-enroll-channel="${esc(e.channel)}">
      <p class="eyebrow">Enrolment</p>
      <p class="sub muted">Seats enrol themselves. A signed-in user is verified through your organisation sign-in. A signed-out install uses an embedded token, which proves the build and not the person.</p>
      ${pausedLine}
      ${pauseButton}
      ${ssoStatusLine(e)}
      ${e.isOwner ? ownerControls(e) : '<p class="muted" data-enroll-readonly>Only the fleet owner can change enrolment.</p>'}
      ${tokens}
      <p id="enroll-msg" class="muted" data-enroll-msg></p>
    </article>`
}
