#!/usr/bin/env node
/**
 * Seeds a local `wrangler dev` metis-operator Worker with realistic HMAC-signed traffic so the
 * console can be screenshotted (plan section 7.3): 12 seats across 6 countries, hostnames, SSO
 * emails, a spread of license states, ~300 asks over N days with question types, recaps, listen
 * events, and CRM rows.
 *
 * HMAC signing mirrors src/shared/operator-hmac.ts + src/main/operator-hmac-sign.ts exactly
 * (canonical string `${ts}.${nonce}.${deviceId}.${sha256Hex(body)}`, HMAC-SHA256 hex) so these
 * requests are indistinguishable from a real desktop seat to operator/src/hmac.ts.
 *
 * Geo is a documented exception: the Worker only trusts Cloudflare's own `request.cf` for country
 * / city (operator/src/geo.ts), which a local `wrangler dev` process does not populate with varied
 * per-request geo (every request enters from the same machine). To get 6 distinct countries for a
 * screenshot, this script seeds seats over HTTP first (proving the real ingest path end to end),
 * then patches seats.country/city/region/lat/lon directly via `wrangler d1 execute --local` for
 * exactly those 12 rows. That patch is best-effort and skipped with a warning against --remote.
 *
 * Usage:
 *   node operator/scripts/seed-dev.mjs --url http://127.0.0.1:8787 --secret <OPERATOR_INGEST_SECRET> --days 7
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const QUESTION_TYPES = [
  'factual', 'how-to', 'explain', 'compare', 'summarize', 'draft', 'translate',
  'code', 'estimate', 'decision', 'screen', 'behavioral', 'other'
]

const HMAC_HEADERS = { ts: 'x-metis-ts', nonce: 'x-metis-nonce', device: 'x-metis-device', sig: 'x-metis-sig' }

/** Mirrors src/shared/operator-hmac.ts ingestCanonical exactly. */
function ingestCanonical(ts, nonce, deviceId, bodySha256Hex) {
  return `${ts}.${nonce}.${deviceId}.${bodySha256Hex}`
}

function sha256Hex(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

function signHeaders(secret, deviceId, body, now = Date.now()) {
  const ts = String(now)
  const nonce = randomUUID()
  const sig = createHmac('sha256', secret).update(ingestCanonical(ts, nonce, deviceId, sha256Hex(body))).digest('hex')
  return {
    [HMAC_HEADERS.ts]: ts,
    [HMAC_HEADERS.nonce]: nonce,
    [HMAC_HEADERS.device]: deviceId,
    [HMAC_HEADERS.sig]: sig,
    'content-type': 'application/json'
  }
}

async function post(baseUrl, secret, path, deviceId, body) {
  const text = JSON.stringify(body)
  const res = await fetch(new URL(path, baseUrl), { method: 'POST', headers: signHeaders(secret, deviceId, text), body: text })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${path} -> ${res.status} ${detail.slice(0, 200)}`)
  }
  return res.json().catch(() => ({}))
}

const COUNTRIES = [
  { country: 'CA', city: 'Longueuil', region: 'Quebec', lat: 45.532, lon: -73.518 },
  { country: 'US', city: 'Austin', region: 'Texas', lat: 30.267, lon: -97.743 },
  { country: 'GB', city: 'London', region: 'England', lat: 51.507, lon: -0.128 },
  { country: 'DE', city: 'Berlin', region: 'Berlin', lat: 52.52, lon: 13.405 },
  { country: 'FR', city: 'Paris', region: 'Ile-de-France', lat: 48.857, lon: 2.352 },
  { country: 'AU', city: 'Sydney', region: 'New South Wales', lat: -33.868, lon: 151.209 }
]

const HOSTS = ['MacBook-Pro', 'ThinkPad-X1', 'Surface-Laptop', 'iMac-Studio', 'XPS-15', 'Latitude-7420']
const FIRST_NAMES = ['tony', 'amara', 'lucas', 'nadia', 'oren', 'priya', 'sasha', 'ines', 'marco', 'yuki', 'elin', 'diego']
const LICENSES = ['licensed', 'trial', 'unlicensed', 'grace']
const PROVIDERS = ['anthropic', 'claude-cli', 'openai']
const MODES = ['answer', 'interview', 'screen']

function seatProfiles() {
  const seats = []
  for (let i = 0; i < 12; i++) {
    const geo = COUNTRIES[i % COUNTRIES.length]
    const name = FIRST_NAMES[i]
    seats.push({
      deviceId: `seed-${geo.country.toLowerCase()}-${i}`,
      os: i % 2 === 0 ? 'darwin' : 'win32',
      appVersion: '1.8.5',
      hostname: `${name[0].toUpperCase()}${name.slice(1)}-${HOSTS[i % HOSTS.length]}`,
      ssoEmail: `${name}@amaris.com`,
      license: LICENSES[i % LICENSES.length],
      geo
    })
  }
  return seats
}

function randomBetween(a, b) {
  return a + Math.random() * (b - a)
}

async function seedHeartbeats(url, secret, seats) {
  for (const seat of seats) {
    await post(url, secret, '/v1/heartbeat', seat.deviceId, {
      os: seat.os,
      appVersion: seat.appVersion,
      hostname: seat.hostname,
      ssoEmail: seat.ssoEmail,
      license: seat.license,
      path: '/'
    })
  }
  console.log(`Métis Operator seed: ${seats.length} heartbeats sent.`)
}

async function seedAsks(url, secret, seats, days, totalAsks) {
  const now = Date.now()
  const spanMs = days * 24 * 60 * 60 * 1000
  for (let i = 0; i < totalAsks; i++) {
    const seat = seats[i % seats.length]
    const ts = Math.round(now - randomBetween(0, spanMs))
    const provider = PROVIDERS[i % PROVIDERS.length]
    const cacheRead = Math.round(randomBetween(0, 2000))
    const cacheUncached = Math.round(randomBetween(50, 500))
    await post(url, secret, '/v1/ingest', seat.deviceId, {
      id: `seed-ask-${seat.deviceId}-${i}`,
      ts,
      mode: MODES[i % MODES.length],
      provider,
      model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-6',
      ttftMs: Math.round(randomBetween(150, 900)),
      totalMs: Math.round(randomBetween(1000, 20000)),
      cacheRead,
      cacheUncached,
      cacheStatus: cacheRead > 0 ? 'hit' : 'write',
      questionType: QUESTION_TYPES[i % QUESTION_TYPES.length],
      outcome: i % 23 === 0 ? 'error' : null
    })
  }
  console.log(`Métis Operator seed: ${totalAsks} asks sent over ${days}d.`)
}

async function seedRecapsAndListens(url, secret, seats) {
  let n = 0
  for (const seat of seats) {
    await post(url, secret, '/v1/ingest', seat.deviceId, { id: `seed-listen-${seat.deviceId}`, event: 'listen', minutes: Math.round(randomBetween(5, 45)) })
    await post(url, secret, '/v1/ingest', seat.deviceId, { id: `seed-recap-${seat.deviceId}`, event: 'recap', minutes: Math.round(randomBetween(10, 60)) })
    n += 2
  }
  console.log(`Métis Operator seed: ${n} listen/recap events sent.`)
}

async function seedCrm(url, secret, seats) {
  const statuses = ['success', 'failed', 'pending', 'submitted']
  let n = 0
  for (const seat of seats) {
    for (let i = 0; i < 2; i++) {
      await post(url, secret, '/v1/ingest', seat.deviceId, {
        id: `seed-crm-${seat.deviceId}-${i}`,
        event: 'crm',
        status: statuses[(n + i) % statuses.length],
        connector: 'hubspot',
        title: `${seat.hostname} meeting recap`
      })
      n++
    }
  }
  console.log(`Métis Operator seed: ${n} CRM rows sent.`)
}

function patchGeoLocal(seats) {
  console.log('Métis Operator seed: patching seats.country/city/region/lat/lon on the local D1 (request.cf has no per-request geo under `wrangler dev`).')
  for (const seat of seats) {
    const { country, city, region, lat, lon } = seat.geo
    const sql = `UPDATE seats SET country='${country}', city='${city}', region='${region}', lat=${lat}, lon=${lon} WHERE device_id='${seat.deviceId}'`
    try {
      execFileSync('npx', ['wrangler', 'd1', 'execute', 'metis-operator', '--local', '--command', sql], { stdio: 'pipe' })
    } catch (err) {
      console.warn(`  skip geo patch for ${seat.deviceId}: ${String(err.message || err).slice(0, 200)}`)
    }
  }
}

function parseArgs(argv) {
  const out = { url: 'http://127.0.0.1:8787', secret: '', days: 7, skipGeoPatch: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--url') out.url = argv[++i]
    else if (arg === '--secret') out.secret = argv[++i]
    else if (arg === '--days') out.days = Number(argv[++i]) || 7
    else if (arg === '--skip-geo-patch') out.skipGeoPatch = true
  }
  return out
}

async function main() {
  const { url, secret, days, skipGeoPatch } = parseArgs(process.argv.slice(2))
  if (!secret) {
    console.error('Usage: node operator/scripts/seed-dev.mjs --url http://127.0.0.1:8787 --secret <OPERATOR_INGEST_SECRET> [--days 7] [--skip-geo-patch]')
    process.exit(1)
  }
  const seats = seatProfiles()
  await seedHeartbeats(url, secret, seats)
  await seedAsks(url, secret, seats, days, 300)
  await seedRecapsAndListens(url, secret, seats)
  await seedCrm(url, secret, seats)
  const isLocalUrl = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)
  if (!skipGeoPatch && isLocalUrl) patchGeoLocal(seats)
  else if (!isLocalUrl) console.log('Métis Operator seed: --url is not local; skipping the D1 geo patch (request.cf will reflect the real edge).')
  console.log('Métis Operator seed: done. Open the console and sign in to see the seeded fleet.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
