/**
 * Keys page (plan 6.9). Moved out of operator/src/ui.ts (plan P0.4) unchanged in behaviour.
 */
import { CF_OAUTH_MISSING } from '../../cloudflare-connect'
import { CF_TOKEN_MISSING, type CloudflareOverview } from '../../cloudflare'
import type { DashboardPayload } from '../../dashboard'
import { dialog, esc, pageHeader, type RenderCtx } from '../index'
import { kpiCard } from './_shared'

function renderCloudflare(cf: CloudflareOverview): string {
  if (cf.error === CF_TOKEN_MISSING) {
    return `<div class="sub muted" data-cf-idle>${esc(cf.error)} Connect Cloudflare (login) on Keys.</div>`
  }
  if (cf.error) {
    return `<div class="fail-loud" data-cf-error>${esc(cf.error)}</div>
      <div class="sub muted pad-b8">Worker ${esc(cf.worker)}. Connect Cloudflare (login) on Keys. No token on seats.</div>`
  }
  const workers = cf.workers.length ? cf.workers.map((w) => esc(w)).join(', ') : 'none listed'
  const req = cf.requests == null ? 'not reported' : String(cf.requests)
  const err = cf.errors == null ? 'not reported' : String(cf.errors)
  const cpu = cf.cpuMs == null ? 'not reported' : `${cf.cpuMs} ms`
  return `<div class="kpis">
      ${kpiCard({ title: 'Requests', value: req, sub: `${cf.worker} · ${cf.range}`, spark: '' })}
      ${kpiCard({ title: 'Errors', value: err, sub: cf.worker, spark: '' })}
      ${kpiCard({ title: 'CPU', value: cpu, sub: 'cpuTimeMs', spark: '' })}
    </div>
    <div class="sub muted pad-b8">Workers: ${workers}. D1 ${esc(cf.d1Name || 'metis-operator')} ${esc(cf.d1Id || '')}.</div>`
}

export function renderKeys(data: DashboardPayload, _ctx: RenderCtx): string {
  const vaultRows = data.keys.vault
    .map(
      (v) => `<tr data-key="${esc(v.id)}">
        <td>${esc(v.provider)}</td>
        <td>${esc(v.label)}</td>
        <td class="muted">··${esc(v.last4)}</td>
        <td>${esc(v.status)}</td>
        <td>${v.status === 'revoked' ? '' : `<button data-rotate="${esc(v.id)}">Rotate</button>`}</td>
        <td>${v.status === 'revoked' ? '' : `<button class="danger" data-revoke="${esc(v.id)}">Revoke</button>`}</td>
      </tr>`
    )
    .join('')
  return `${pageHeader({ title: 'Keys', subtitle: 'Seats never receive these keys. A licensed seat calls the Operator, and the Operator calls the provider.' })}
    <article class="card pad-b10">
      <p class="eyebrow">Keys</p>
      <div class="sub muted pad-b8">Tony adds LLM APIs and Cloudflare here. last4 only. Never a secret, cipher, token, or grant. After a seat is approved, these keys are the default Ask path. CLI tokens stay on the seat.</div>
      <table>
        <thead><tr><th>Binding</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>Ingest HMAC</td><td>${data.keys.ingestBound ? 'bound' : 'missing'}</td></tr>
          <tr><td>Prompt key</td><td>${data.keys.promptBound ? 'bound' : 'missing'}</td></tr>
          <tr><td>Skill signing</td><td>${data.keys.skillBound ? 'bound' : 'missing'}</td></tr>
          <tr><td>Vault key</td><td>${data.keys.vaultBound ? 'bound' : 'missing'}</td></tr>
        </tbody>
      </table>
      <p class="eyebrow mg-t14">Add an API</p>
      <form class="key-form" id="key-add" autocomplete="off">
        <div class="row">
          <select name="provider" required>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="nvidia">NVIDIA NIM</option>
            <option value="deepseek">DeepSeek</option>
            <option value="minimax">MiniMax</option>
            <option value="qwen">Qwen</option>
            <option value="kimi">Kimi</option>
            <option value="openrouter">OpenRouter</option>
            <option value="groq">Groq</option>
            <option value="mistral">Mistral</option>
            <option value="grok">Grok</option>
            <option value="cloudflare">Cloudflare</option>
            <option value="custom">Custom</option>
          </select>
          <input name="label" type="text" placeholder="Label" maxlength="80">
          <input name="secret" type="password" placeholder="API token" required autocomplete="off">
          <input name="accountId" type="text" placeholder="Account ID" maxlength="64" autocomplete="off" data-cf-account>
          <button class="primary" type="submit">Add</button>
        </div>
      </form>
      <p class="sub muted">Cloudflare: paste API token + accountId (Workers AI REST). last4 only after save. Log in below is optional and last.</p>
      <p class="eyebrow">Cloudflare · AI Gateway</p>
      <p class="sub muted">Optional last: Log in to Cloudflare. Paste above is enough for portal-cf Flash. Métis Settings tile stays on KineticGrid.</p>
      ${
        data.keys.oauthBound
          ? ''
          : `<div class="fail-loud" data-cf-oauth-missing>${esc(CF_OAUTH_MISSING)}</div>`
      }
      <div data-cf-overview>${renderCloudflare(data.cloudflare)}</div>
      <p class="eyebrow mg-t14">Portal LLM spend</p>
      <div class="sub" data-portal-cf>Portal CF (Workers AI DeepSeek): ${esc(data.roi.portalCf)}</div>
      <div class="sub" data-portal-direct>Portal direct (DeepSeek platform): ${esc(data.roi.portalDirect)}</div>
      <div class="sub muted pad-b8">Two lines. Estimate, list price when a $ is shown. Missing stays not reported. Never $0. Worker invocations above are a different KPI.</div>
      <p><a class="btn primary" id="cf-connect" data-cf-aig-connect href="/cloudflare/connect">Log in to Cloudflare</a></p>
      <p id="cf-connect-msg" class="muted pad-8-0"></p>
      <p class="eyebrow mg-t14">Vault</p>
      <table>
        <thead><tr><th>Provider</th><th>Label</th><th>Last4</th><th>Status</th><th>Rotate</th><th>Revoke</th></tr></thead>
        <tbody>${vaultRows || ''}</tbody>
      </table>
      ${vaultRows ? '' : '<div class="empty">No provider keys on Operator yet. Add an API or Cloudflare here so seats can be funded.</div>'}
      <div id="key-msg" class="muted pad-8-0"></div>
    </article>
    ${dialog({ id: 'rotate-key-dialog', title: 'Rotate key', label: 'New secret or token', confirmLabel: 'Rotate', masked: true })}`
}
