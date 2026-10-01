/**
 * Models page (M2-0412): the owner picks a provider + model per capability, every Métis app fetches
 * and enforces this document. Every admin sees the current policy and its audit history read-only;
 * only the configured owner (`OWNER_EMAILS`) sees the edit form — `PUT /v1/admin/model-policy.json`
 * itself is the enforcement boundary (a non-owner PUT is refused with 403), this just hides a form
 * the request would be rejected anyway.
 *
 * The edit form posts through a page-local inline `<script nonce>` rather than the operator/client/
 * SPA bundle: a plain full-page reload on save keeps this page independent of the bundle's
 * PAGE_RENDERERS/PAGE_INIT maps (main.ts), so shipping it does not require also regenerating
 * operator/src/spa/client.generated.ts for a feature nothing else in the bundle depends on.
 */
import type { DashboardPayload } from '../../dashboard'
import { emptyState, esc, pageHeader, type RenderCtx } from '../index'
import { when } from './_shared'
import {
  MODEL_POLICY_CAPABILITIES,
  MODEL_POLICY_CAPABILITY_LABELS,
  type ModelPolicyCapability,
  type ModelPolicyDocument
} from '../../../../src/shared/model-policy'

function fallbacksText(fallbacks: { provider: string; model: string }[]): string {
  return fallbacks.map((f) => `${f.provider}:${f.model}`).join(', ')
}

function capabilityReadRow(cap: ModelPolicyCapability, policy: ModelPolicyDocument | null): string {
  const entry = policy?.capabilities[cap]
  const value = entry ? `${esc(entry.provider)} / ${esc(entry.model)}` : '<span class="muted">Not managed — this app\'s local defaults apply</span>'
  const fallbacks = entry && entry.fallbacks.length ? `<div class="muted">Fallbacks: ${esc(fallbacksText(entry.fallbacks))}</div>` : ''
  return `<div class="rule"><h3>${esc(MODEL_POLICY_CAPABILITY_LABELS[cap])}</h3><p>${value}</p>${fallbacks}</div>`
}

function capabilityEditRow(cap: ModelPolicyCapability, policy: ModelPolicyDocument | null): string {
  const entry = policy?.capabilities[cap]
  return `<div class="rule model-policy-row" data-cap="${cap}">
    <h3>${esc(MODEL_POLICY_CAPABILITY_LABELS[cap])}</h3>
    <label>Provider <input type="text" name="${cap}.provider" value="${esc(entry?.provider ?? '')}" required maxlength="64"></label>
    <label>Model <input type="text" name="${cap}.model" value="${esc(entry?.model ?? '')}" required maxlength="200"></label>
    <label>Fallbacks <input type="text" name="${cap}.fallbacks" value="${esc(entry ? fallbacksText(entry.fallbacks) : '')}" placeholder="provider:model, provider:model"></label>
  </div>`
}

function historyTable(history: { ts: number; actor: string; action: string; detail: string }[]): string {
  if (!history.length) {
    return emptyState({ title: 'No model policy changes yet.', description: 'Every save here will appear in this list.' })
  }
  return `<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${history
    .map(
      (h) => `<tr>
        <td class="muted">${esc(when(h.ts))}</td>
        <td>${esc(h.actor)}</td>
        <td>${esc(h.action)}</td>
        <td class="muted">${esc(h.detail)}</td>
      </tr>`
    )
    .join('')}</tbody></table>`
}

/** Vanilla, no build step: this string is emitted as-is inside the page's own `<script nonce>`, never
 *  passed through esbuild/tsc, so it stays deliberately plain (var/function, no arrow chains) and
 *  self-contained — see this module's doc comment for why it does not go through operator/client/. */
function editFormScript(nonce: string): string {
  return `<script nonce="${esc(nonce)}">(function () {
  var form = document.getElementById('model-policy-form');
  if (!form) return;
  var msg = document.getElementById('model-policy-msg');
  var caps = ${JSON.stringify(MODEL_POLICY_CAPABILITIES)};
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(form);
    var capabilities = {};
    for (var i = 0; i < caps.length; i++) {
      var cap = caps[i];
      var fallbacksRaw = String(fd.get(cap + '.fallbacks') || '').trim();
      var fallbacks = fallbacksRaw
        ? fallbacksRaw.split(',').map(function (part) { return part.trim(); }).filter(Boolean).map(function (part) {
            var idx = part.indexOf(':');
            return idx === -1 ? { provider: part, model: '' } : { provider: part.slice(0, idx).trim(), model: part.slice(idx + 1).trim() };
          })
        : [];
      capabilities[cap] = {
        provider: String(fd.get(cap + '.provider') || '').trim(),
        model: String(fd.get(cap + '.model') || '').trim(),
        fallbacks: fallbacks
      };
    }
    if (msg) msg.textContent = 'Saving…';
    fetch('/v1/admin/model-policy.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: capabilities })
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok || !result.body || result.body.ok === false) {
        if (msg) msg.textContent = (result.body && result.body.error) || 'Could not save the model policy.';
        return;
      }
      if (msg) msg.textContent = 'Saved. Reloading…';
      location.reload();
    }).catch(function () {
      if (msg) msg.textContent = 'Could not reach the Operator. Check your connection and try again.';
    });
  });
})();</script>`
}

export function renderModels(data: DashboardPayload, ctx: RenderCtx): string {
  const { policy, isOwner, history } = data.modelPolicy
  const readCard = `<article class="card pad-b10">
    <p class="eyebrow">Fleet model policy</p>
    ${policy ? '' : '<p class="muted">Not managed: no owner policy has been set yet. Every app uses its own local defaults.</p>'}
    ${MODEL_POLICY_CAPABILITIES.map((cap) => capabilityReadRow(cap, policy)).join('')}
  </article>`
  const editCard =
    isOwner && ctx.nonce
      ? `<article class="card pad-b10">
    <p class="eyebrow">Change the policy</p>
    <form id="model-policy-form">
      ${MODEL_POLICY_CAPABILITIES.map((cap) => capabilityEditRow(cap, policy)).join('')}
      <button type="submit" class="primary">Save policy</button>
      <p id="model-policy-msg" class="muted"></p>
    </form>
  </article>${editFormScript(ctx.nonce)}`
      : isOwner
        ? ''
        : `<article class="card pad-b10"><p class="muted">Only the fleet owner can change this policy.</p></article>`
  const historyCard = `<article class="card pad-b10">
    <p class="eyebrow">History</p>
    ${historyTable(history)}
  </article>`
  return `${pageHeader({ title: 'Models', subtitle: 'Pick the provider and model every Métis app must use, per capability.' })}
    ${readCard}
    ${editCard}
    ${historyCard}`
}
