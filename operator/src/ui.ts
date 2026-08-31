const CSS = `
:root {
  --glass: rgba(16,16,18,0.72);
  --hair: rgba(255,255,255,0.12);
  --ink: rgba(255,255,255,0.95);
  --ink2: rgba(255,255,255,0.55);
  --ink3: rgba(255,255,255,0.38);
  --accent: #7C8CF8;
  --ok: #83C092;
  --danger: #F0717A;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: #0c0c0e; color: var(--ink); font: 12px/1.4 Geist, Inter, system-ui, sans-serif; }
a { color: var(--accent); }
header {
  display: flex; align-items: baseline; gap: 16px;
  padding: 14px 18px; border-bottom: 1px solid var(--hair);
  background: var(--glass);
}
header h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.02em; }
header .who { color: var(--ink2); font-size: 11px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 12px 18px; }
.kpi {
  border: 1px solid var(--hair); border-radius: 8px; padding: 10px 12px; background: rgba(20,20,22,0.55);
}
.kpi .n { font-size: 22px; font-weight: 600; letter-spacing: -0.03em; }
.kpi .l { color: var(--ink3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 4px; }
.kpi .hint { color: var(--ink2); font-size: 10.5px; margin-top: 4px; }
main { padding: 0 18px 24px; display: grid; gap: 18px; }
section h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink3); margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 12px; }
th { color: var(--ink3); font-weight: 500; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--hair); font-size: 10px; color: var(--ink2); }
.badge.hit { color: var(--ok); border-color: rgba(131,192,146,0.35); }
.badge.write { color: var(--accent); }
.empty { color: var(--ink2); padding: 12px 0; }
button, .btn {
  background: transparent; color: var(--ink); border: 1px solid var(--hair); border-radius: 8px;
  padding: 5px 10px; font-size: 11px; cursor: pointer;
}
button.primary { background: var(--accent); border-color: transparent; color: #0c0c0e; font-weight: 600; }
button.danger { color: var(--danger); }
pre { background: rgba(0,0,0,0.35); border: 1px solid var(--hair); border-radius: 8px; padding: 8px; overflow: auto; font: 11px Geist Mono, ui-monospace, monospace; }
textarea { width: 100%; min-height: 140px; background: rgba(0,0,0,0.35); color: var(--ink); border: 1px solid var(--hair); border-radius: 8px; padding: 8px; font: 11px Geist Mono, ui-monospace, monospace; }
.card { border: 1px solid var(--hair); border-radius: 12px; padding: 12px; background: rgba(20,20,22,0.4); display: grid; gap: 8px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.muted { color: var(--ink2); }
`

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

export function renderConsole(data: {
  email: string
  live: number
  dau: number
  costToday: string | null
  hitRate: string | null
  pending: number
  seats: { device_id: string; os: string; app_version: string; last_seen: number; online: boolean }[]
  asks: { id: string; ts: number; mode: string; preview: string; cache_status: string; provider: string }[]
  proposals: { id: string; skill_id: string; from_version: string; status: string; rationale: string; diff: string; evidence: string[] }[]
}): string {
  const kpiCost = data.costToday ?? 'hidden'
  const kpiHit = data.hitRate ?? 'not reported'
  const seatRows = data.seats
    .map(
      (s) =>
        `<tr><td>${s.online ? '<span class="badge hit">online</span>' : '<span class="badge">idle</span>'}</td><td>${esc(s.os)}</td><td>${esc(s.app_version)}</td><td class="muted">${esc(s.device_id.slice(0, 8))}</td></tr>`
    )
    .join('')
  const askRows = data.asks
    .map(
      (a) =>
        `<tr><td>${esc(a.mode)}</td><td>${esc(a.preview)}</td><td><span class="badge ${esc(a.cache_status)}">${esc(a.cache_status)}</span></td><td class="muted">${esc(a.provider)}</td><td><button data-reveal="${esc(a.id)}">Reveal</button></td></tr>`
    )
    .join('')
  const props = data.proposals
    .map(
      (p) => `
      <div class="card" data-proposal="${esc(p.id)}">
        <div class="row"><strong>${esc(p.skill_id)}</strong> <span class="badge">${esc(p.status)}</span> <span class="muted">from ${esc(p.from_version)}</span></div>
        <div class="muted">${esc(p.rationale)}</div>
        <div class="muted">Evidence: ${esc(p.evidence.join(' · ') || 'none')}</div>
        <textarea data-diff="${esc(p.id)}">${esc(p.diff)}</textarea>
        <div class="row">
          ${p.status === 'pending' ? `<button class="primary" data-approve="${esc(p.id)}">Approve</button><button class="danger" data-reject="${esc(p.id)}">Reject</button>` : ''}
          ${p.status === 'approved' ? `<button class="primary" data-push="${esc(p.id)}">Push</button>` : ''}
        </div>
      </div>`
    )
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Métis Operator</title><style>${CSS}</style></head>
<body>
<header>
  <h1>Métis Operator</h1>
  <div class="who">${esc(data.email)}</div>
</header>
<div class="kpis">
  <div class="kpi"><div class="n">${data.live}</div><div class="l">Live now</div><div class="hint">last-seen under 2 minutes</div></div>
  <div class="kpi"><div class="n">${kpiCost}</div><div class="l">Cost today</div><div class="hint">estimate, list price</div></div>
  <div class="kpi"><div class="n">${esc(kpiHit)}</div><div class="l">Cache hit</div><div class="hint">real provider fields only</div></div>
  <div class="kpi"><div class="n">${data.pending}</div><div class="l">Pending diffs</div><div class="hint">${data.dau} seats today</div></div>
</div>
<main>
  <section>
    <h2>Seats</h2>
    ${data.seats.length ? `<table><thead><tr><th>State</th><th>OS</th><th>Version</th><th>Seat</th></tr></thead><tbody>${seatRows}</tbody></table>` : '<div class="empty">No seats yet. Point a Mac at this Operator URL.</div>'}
  </section>
  <section>
    <h2>Asks</h2>
    ${data.asks.length ? `<table><thead><tr><th>Mode</th><th>Preview</th><th>Cache</th><th>Provider</th><th></th></tr></thead><tbody>${askRows}</tbody></table>` : '<div class="empty">No Asks on the fleet yet.</div>'}
    <div id="reveal" class="muted"></div>
  </section>
  <section>
    <div class="row"><h2 style="margin:0">Skill upgrades</h2>
      <button data-draft="interview">Draft interview</button>
      <button data-draft="recruiting">Draft recruiting</button>
      <button data-draft="support">Draft support</button>
    </div>
    ${props || '<div class="empty">No skill upgrades waiting. Use Ask in a mode, then Draft.</div>'}
  </section>
</main>
<script>
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
document.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-reveal')
  const j = await api('/v1/admin/asks/' + id)
  document.getElementById('reveal').textContent = j.ok ? (j.question || '(empty)') : (j.error || 'reveal failed')
}))
document.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-approve')
  const diff = document.querySelector('[data-diff="' + id + '"]').value
  await api('/v1/admin/skills/' + id + '/approve', { diff })
  location.reload()
}))
document.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-reject')
  await api('/v1/admin/skills/' + id + '/reject', { reason: 'rejected in console' })
  location.reload()
}))
document.querySelectorAll('[data-push]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-push')
  await api('/v1/admin/skills/' + id + '/push', {})
  location.reload()
}))
document.querySelectorAll('[data-draft]').forEach((b) => b.addEventListener('click', async () => {
  await api('/v1/admin/skills/draft', { skillId: b.getAttribute('data-draft') })
  location.reload()
}))
</script>
</body></html>`
}
