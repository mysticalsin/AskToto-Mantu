/**
 * auth and privacy: the four hard rules from operator/README.md's "Hard rules, never violated" plus
 * the HMAC replay contract from src/shared/operator-hmac.ts's doc comment, all exercised as real HTTP
 * calls against the booted Worker (never unit-tested against the store directly):
 *
 *  - console GET without a cookie is a 302 to Access
 *  - /v1/admin/dashboard without a cookie is 401 JSON
 *  - a cross-site POST is 403
 *  - a seat request with a bad signature is 401 and does not burn the nonce
 *  - no ask text and no secret-shaped string anywhere an admin can read: dashboard/keys JSON, the
 *    console HTML, or a CSV/XLSX export
 */
import '../lib/http.mjs'
import { Check } from '../lib/assert.mjs'
import { adminClient } from '../lib/admin.mjs'
import { Seat } from '../seat.mjs'

const DEVICE_ID = 'e2e-auth-seat-01'
const UNIQ = Date.now().toString(36)
const VAULT_SECRET = `E2E-VAULT-SECRET-MARKER-${UNIQ}-do-not-leak`
const ASK_TEXT_MARKER = `E2E-ASK-TEXT-MARKER-${UNIQ} the unreleased Nightingale pricing model`

function includesEither(haystack, needles) {
  return needles.filter((n) => typeof haystack === 'string' && haystack.includes(n))
}

export async function run(ctx) {
  const startedAt = Date.now()
  const check = new Check()
  const admin = adminClient(ctx)

  // 1. Console GET without a cookie is a 302 to Access.
  const consoleNoCookie = await admin.raw('/', { cookie: null, redirect: 'manual' })
  check.that(consoleNoCookie.status === 302, 'unauthenticated console GET is a 302', {
    file: 'operator/src/index.ts',
    line: 239,
    expected: 302,
    actual: consoleNoCookie.status
  })
  const location = consoleNoCookie.headers.get('location') || ''
  check.that(location.includes('/cdn-cgi/access/login/'), 'the 302 points at the Cloudflare Access login path', {
    file: 'operator/src/access.ts',
    line: 113,
    expected: 'a Location containing /cdn-cgi/access/login/',
    actual: location
  })

  // 2. /v1/admin/dashboard without a cookie is 401 JSON, never a redirect.
  const dashNoCookie = await admin.get('/v1/admin/dashboard', { cookie: null })
  check.that(dashNoCookie.status === 401, '/v1/admin/dashboard without a cookie is 401', {
    file: 'operator/src/access.ts',
    line: 373,
    expected: 401,
    actual: dashNoCookie.status
  })
  check.that(dashNoCookie.json?.ok === false && typeof dashNoCookie.json?.error === 'string', '401 body is JSON {ok:false, error}, not HTML', {
    actual: dashNoCookie.json
  })

  // 3. A cross-site POST is refused with 403.
  const crossSite = await admin.raw('/v1/admin/licenses/generate', {
    method: 'POST',
    body: JSON.stringify({ days: 1 }),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }
  })
  const crossSiteBody = await crossSite.text()
  let crossSiteJson = null
  try {
    crossSiteJson = JSON.parse(crossSiteBody)
  } catch {
    /* ignore */
  }
  check.that(crossSite.status === 403, 'a cross-site admin POST is refused with 403', {
    file: 'operator/src/index.ts',
    line: 226,
    expected: 403,
    actual: crossSite.status
  })
  check.that(crossSiteJson?.code === 'csrf', 'the 403 body carries code:"csrf"', {
    file: 'operator/src/index.ts',
    line: 110,
    expected: 'csrf',
    actual: crossSiteJson?.code
  })

  // 4. A bad signature is 401 and does NOT burn the nonce; the nonce is only consumed once a
  //    request that actually proves it holds the secret succeeds.
  const seat = new Seat({
    baseUrl: ctx.baseUrl,
    secret: ctx.ingestSecret,
    deviceId: DEVICE_ID,
    seatHash: 'e2e-auth-seathash-01',
    os: 'darwin',
    appVersion: '1.9.0-e2e',
    hostname: 'e2e-mbp-auth',
    ssoEmail: 'auth@example.com',
    cf: { country: 'US', city: 'Austin', region: 'Texas' },
    hmac: ctx.hmac
  })
  const sharedTs = String(Date.now())
  const sharedNonce = `e2e-nonce-${UNIQ}`
  const badSig = '0'.repeat(64)

  const badAttempt = await seat.request('/v1/heartbeat', 'POST', seat.seatMeta(), { sign: { ts: sharedTs, nonce: sharedNonce, sig: badSig } })
  check.that(badAttempt.status === 401, 'a request with a wrong signature is rejected with 401', {
    file: 'operator/src/hmac.ts',
    line: 68,
    expected: 401,
    actual: badAttempt.status
  })
  check.that(badAttempt.json?.error === 'bad HMAC signature', 'the 401 names "bad HMAC signature"', { actual: badAttempt.json?.error })

  const goodAttempt = await seat.request('/v1/heartbeat', 'POST', seat.seatMeta(), { sign: { ts: sharedTs, nonce: sharedNonce } })
  check.that(goodAttempt.status === 200 && goodAttempt.json?.ok === true, 'the SAME ts/nonce, correctly signed, still succeeds (the failed attempt did not burn the nonce)', {
    file: 'operator/src/hmac.ts',
    line: 73,
    expected: 200,
    actual: { status: goodAttempt.status, body: goodAttempt.json }
  })

  const replay = await seat.request('/v1/heartbeat', 'POST', seat.seatMeta(), { sign: { ts: sharedTs, nonce: sharedNonce } })
  check.that(replay.status === 401 && replay.json?.error === 'replay nonce', 'replaying that same now-used nonce is rejected as a replay', {
    file: 'operator/src/hmac.ts',
    line: 74,
    expected: 401,
    actual: { status: replay.status, body: replay.json }
  })

  // 5. No ask text and no secret-shaped string anywhere an admin can read.
  const vaultKey = await admin.post('/v1/admin/keys', { provider: 'anthropic', secret: VAULT_SECRET, label: 'e2e privacy check' })
  check.that(vaultKey.status === 200 && vaultKey.json?.ok === true, 'vault key write returns 200 ok:true', {
    file: 'operator/src/keys.ts',
    line: 58,
    actual: { status: vaultKey.status, body: vaultKey.json }
  })
  const vaultLast4 = vaultKey.json?.last4

  const privacySeat = new Seat({
    baseUrl: ctx.baseUrl,
    secret: ctx.ingestSecret,
    deviceId: 'e2e-auth-seat-02',
    seatHash: 'e2e-auth-seathash-02',
    os: 'win32',
    appVersion: '1.9.0-e2e',
    hostname: 'e2e-win-auth',
    ssoEmail: 'auth2@example.com',
    cf: { country: 'FR', city: 'Paris', region: 'Ile-de-France' },
    hmac: ctx.hmac
  })
  await privacySeat.heartbeat()
  const askRes = await privacySeat.ask({
    id: 'e2e-auth-ask-01',
    question: ASK_TEXT_MARKER,
    questionType: 'draft',
    mode: 'typed',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6'
  })
  check.that(askRes.status === 200 && askRes.json?.ok === true, 'the marker ask ingests fine', { actual: { status: askRes.status, body: askRes.json } })

  const secrets = [VAULT_SECRET, ASK_TEXT_MARKER]
  const surfaces = [
    ['GET /', () => admin.raw('/').then((r) => r.text())],
    ['GET /v1/admin/dashboard', () => admin.get('/v1/admin/dashboard').then((r) => r.text)],
    ['GET /v1/admin/keys', () => admin.get('/v1/admin/keys').then((r) => r.text)],
    ['GET /v1/admin/asks', () => admin.get('/v1/admin/asks').then((r) => r.text)],
    ['GET /v1/admin/events.json', () => admin.get('/v1/admin/events.json?range=24h&limit=200').then((r) => r.text)],
    ['GET /v1/admin/sessions.json', () => admin.get('/v1/admin/sessions.json?range=24h').then((r) => r.text)],
    ['GET /v1/admin/audit.json', () => admin.get('/v1/admin/audit.json?limit=200').then((r) => r.text)],
    ['GET /v1/admin/export.csv?table=asks', () => admin.get('/v1/admin/export.csv?table=asks').then((r) => r.text)],
    ['GET /v1/admin/export.csv?table=seats', () => admin.get('/v1/admin/export.csv?table=seats').then((r) => r.text)]
  ]
  for (const [label, fetcher] of surfaces) {
    const text = await fetcher()
    const leaked = includesEither(text, secrets)
    check.that(leaked.length === 0, `${label} never contains the vault secret or the raw ask text`, {
      file: 'operator/src/routes/admin-ctx.ts',
      line: 122,
      expected: 'neither marker present',
      actual: leaked
    })
  }

  // .xlsx export: operator/src/export/xlsx.ts packages entries STORED (uncompressed), so the sheet
  // XML sits byte-for-byte in the file — a raw substring search on the response bytes is a real,
  // direct check of the exported content, not a guess.
  const xlsx = await admin.bytes('/v1/admin/export.xlsx?table=asks')
  check.that(xlsx.status === 200, 'xlsx export responds 200', { actual: xlsx.status })
  const xlsxText = xlsx.buf.toString('latin1')
  const leakedXlsx = includesEither(xlsxText, secrets)
  check.that(leakedXlsx.length === 0, 'the .xlsx export bytes never contain the vault secret or the raw ask text', {
    file: 'operator/src/export/xlsx.ts',
    line: 1,
    expected: 'neither marker present',
    actual: leakedXlsx
  })

  // Positive control: the redaction is a deliberate last4, not an accidental total wipe.
  const keysAfter = await admin.get('/v1/admin/keys')
  const vaultRow = keysAfter.json?.vault?.find((v) => v.id === vaultKey.json?.id)
  check.that(
    typeof vaultLast4 === 'string' && vaultLast4.length === 4 && vaultRow?.last4 === vaultLast4 && VAULT_SECRET.endsWith(vaultLast4),
    "the key's own row in /v1/admin/keys legitimately shows its last4, matching the secret's real last 4 chars",
    { file: 'operator/src/keys.ts', line: 28, expected: vaultLast4, actual: vaultRow?.last4 }
  )

  return check.result('auth-privacy', startedAt)
}
