#!/usr/bin/env node
/**
 * smoke.mjs — read-only post-deploy smoke test for the Métis Operator Worker.
 *
 * Every check below is a GET (or an unauthenticated/unsigned POST that is expected to be
 * rejected) — nothing here mutates state, so it is safe to run against the live production
 * Worker at any time, not only right after a deploy. `deploy.mjs` runs this automatically after
 * `wrangler deploy`; it can also be run by hand:
 *
 *   node operator/scripts/smoke.mjs --url https://metis-operator.tony-walteur.workers.dev
 *
 * The checks are exported as small, independently testable functions (each takes an injected
 * `fetchImpl` instead of calling the global `fetch`) so operator/scripts/smoke.contract.test.ts
 * can exercise every pass/fail branch with a fake fetch and no network access. `runSmoke` is the
 * pure orchestrator; `main` is the only part that touches argv, the real network, and
 * process.exit.
 *
 * Known pre-deploy gap (see plan section 9d / P4.0 verification): `/health` on the CURRENT live
 * deployment has no `version` field yet (operator/src/index.ts only returns
 * `{ ok, service, configured }`). The health check below will therefore legitimately fail
 * against the live Worker until a deploy carrying `OPERATOR_VERSION` lands — that is expected,
 * not a bug in this script.
 */
export const DEFAULT_TEAM_DOMAIN = 'https://tony-walteur.cloudflareaccess.com'
const FETCH_TIMEOUT_MS = 10_000

/** Every check gets a bounded timeout so a hung connection cannot hang the whole smoke run.
 *  A fake fetch used by tests can ignore `signal` entirely; the timer is always cleared. */
async function timedFetch(fetchImpl, url, init) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${FETCH_TIMEOUT_MS}ms`)),
    FETCH_TIMEOUT_MS
  )
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function result(name, ok, detail) {
  return { name, ok, detail }
}

export async function checkHealth(fetchImpl, baseUrl) {
  const name = 'GET /health (200, ok:true, version)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/health`)
    let body = null
    try {
      body = await res.json()
    } catch {
      /* non-JSON body handled below via hasVersion=false */
    }
    const hasVersion = Boolean(body && typeof body.version === 'string' && body.version.trim().length > 0)
    const ok = res.status === 200 && body?.ok === true && hasVersion
    return result(
      name,
      ok,
      `status=${res.status} ok=${body?.ok ?? 'missing'} version=${body?.version ?? 'missing'}`
    )
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}

export async function checkAssetIndexJs(fetchImpl, baseUrl) {
  const name = 'GET /assets/index.js (200, JS, > 40 KB)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/assets/index.js`)
    const contentType = res.headers.get('content-type') || ''
    const text = await res.text()
    const bytes = Buffer.byteLength(text, 'utf8')
    const isJs = /javascript/i.test(contentType)
    const bigEnough = bytes > 40 * 1024
    const ok = res.status === 200 && isJs && bigEnough
    return result(name, ok, `status=${res.status} type=${contentType || 'missing'} bytes=${bytes}`)
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}

export async function checkWorldSvg(fetchImpl, baseUrl) {
  const name = 'GET /assets/world.svg (200, svg)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/assets/world.svg`)
    const contentType = res.headers.get('content-type') || ''
    const isSvg = /svg/i.test(contentType)
    const ok = res.status === 200 && isSvg
    return result(name, ok, `status=${res.status} type=${contentType || 'missing'}`)
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}

export async function checkAccessRedirect(fetchImpl, baseUrl, teamDomain) {
  const name = '/ (302 -> Access team domain)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/`, { redirect: 'manual' })
    const location = res.headers.get('location') || ''
    const ok = res.status === 302 && location.startsWith(teamDomain)
    return result(name, ok, `status=${res.status} location=${location || 'missing'}`)
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}

export async function checkAdminDashboardUnauth(fetchImpl, baseUrl) {
  const name = 'GET /v1/admin/dashboard (401 JSON, unauthenticated)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/v1/admin/dashboard`)
    let body = null
    try {
      body = await res.json()
    } catch {
      /* handled by ok=false below */
    }
    const ok = res.status === 401 && body?.ok === false
    return result(name, ok, `status=${res.status} body=${body ? JSON.stringify(body) : 'non-JSON'}`)
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}

export async function checkIngestGetNever200(fetchImpl, baseUrl) {
  const name = 'GET /v1/ingest (405 or 401, never 200)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/v1/ingest`)
    const ok = res.status === 405 || res.status === 401
    const detail =
      res.status === 200
        ? `status=200 — FAIL: an unauthenticated/unsigned GET must never succeed`
        : `status=${res.status}`
    return result(name, ok, detail)
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}

export async function checkHeartbeatNoHmac(fetchImpl, baseUrl) {
  const name = 'POST /v1/heartbeat without HMAC (401)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/v1/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    const ok = res.status === 401
    return result(name, ok, `status=${res.status}`)
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}


export async function checkIntegrationsNoHmac(fetchImpl, baseUrl) {
  const name = 'GET /v1/integrations without HMAC (401, not Access HTML)'
  try {
    const res = await timedFetch(fetchImpl, `${baseUrl}/v1/integrations`, { method: 'GET' })
    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    const isAccessHtml = res.status === 302 || ctype.includes('text/html')
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const ok =
      res.status === 401 &&
      !isAccessHtml &&
      body &&
      body.ok === false &&
      typeof body.error === 'string' &&
      /hmac/i.test(body.error)
    const detail = isAccessHtml
      ? `status=${res.status} type=${ctype || 'missing'} — FAIL: Cloudflare Access wrapped HMAC route`
      : `status=${res.status} error=${body?.error ?? 'missing'}`
    return result(name, ok, detail)
  } catch (err) {
    return result(name, false, `request failed: ${err.message}`)
  }
}

/** Pure orchestrator: no argv, no process.exit, no console — just runs every check against the
 *  injected fetch and returns the results. Safe to unit-test with a fake fetch. */
export async function runSmoke({ baseUrl, teamDomain = DEFAULT_TEAM_DOMAIN, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, '')
  const checks = await Promise.all([
    checkHealth(fetchImpl, base),
    checkAssetIndexJs(fetchImpl, base),
    checkWorldSvg(fetchImpl, base),
    checkAccessRedirect(fetchImpl, base, teamDomain),
    checkAdminDashboardUnauth(fetchImpl, base),
    checkIngestGetNever200(fetchImpl, base),
    checkHeartbeatNoHmac(fetchImpl, base),
    checkIntegrationsNoHmac(fetchImpl, base)
  ])
  return { baseUrl: base, checks, allOk: checks.every((c) => c.ok) }
}

export function parseArgs(argv) {
  const args = { url: null, teamDomain: DEFAULT_TEAM_DOMAIN, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--url') args.url = argv[++i]
    else if (a === '--team-domain') args.teamDomain = argv[++i]
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function printHelp() {
  console.log(`Usage: node operator/scripts/smoke.mjs --url <https://worker-url> [--team-domain <url>] [--json]

Read-only post-deploy smoke checks for the Métis Operator Worker. Exits non-zero if any check
fails. Every check is a GET or an unauthenticated/unsigned request expected to be rejected — safe
to run against the live production Worker at any time.`)
}

function printReport({ baseUrl, checks, allOk }) {
  console.log(`Métis Operator smoke — ${baseUrl}`)
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    console.log(`        ${c.detail}`)
  }
  console.log(allOk ? 'All checks passed.' : 'One or more checks FAILED.')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.url) {
    printHelp()
    process.exit(args.help ? 0 : 1)
  }
  const report = await runSmoke({ baseUrl: args.url, teamDomain: args.teamDomain })
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printReport(report)
  }
  process.exit(report.allOk ? 0 : 1)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
