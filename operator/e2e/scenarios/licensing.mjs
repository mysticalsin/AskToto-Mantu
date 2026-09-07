/**
 * licensing: generate an Operator-issued license through the real admin route, activate it on a
 * seat (the seat sends the license's jti back on its next heartbeat, exactly like
 * `src/main/operator-license-activate.ts` + `operator-ingest.ts` do on the desktop), assert the
 * heartbeat response reports it approved with its tier/entitlements; revoke it and assert the
 * following heartbeat loses them; then a batch of 5 licenses, each verified with the real
 * `verifyOperatorLicense` (src/shared/operator-license.ts), never a reimplementation of it.
 */
import '../lib/http.mjs'
import { Check } from '../lib/assert.mjs'
import { adminClient } from '../lib/admin.mjs'
import { loadLicense } from '../lib/license.mjs'
import { Seat } from '../seat.mjs'

const DEVICE_ID = 'e2e-lic-seat-01'

export async function run(ctx) {
  const startedAt = Date.now()
  const check = new Check()
  const admin = adminClient(ctx)
  const seat = new Seat({
    baseUrl: ctx.baseUrl,
    secret: ctx.ingestSecret,
    deviceId: DEVICE_ID,
    seatHash: 'e2e-lic-seathash-01',
    os: 'win32',
    appVersion: '1.9.0-e2e',
    hostname: 'e2e-win-licensing',
    ssoEmail: 'licensing@example.com',
    cf: { country: 'DE', city: 'Berlin', region: 'Berlin' },
    hmac: ctx.hmac
  })

  // Baseline: unlicensed seat, no tier.
  const hb0 = await seat.heartbeat()
  check.that(hb0.status === 200, 'baseline heartbeat returns 200', { actual: hb0.status })
  check.that(hb0.json?.approved === false, 'unlicensed seat is not approved', { actual: hb0.json?.approved })
  check.that(hb0.json?.tier === null, 'unlicensed seat has no tier', { actual: hb0.json?.tier })

  // Generate a license through the real admin route.
  const generated = await admin.post('/v1/admin/licenses/generate', { days: 30 })
  check.that(generated.status === 200 && generated.json?.ok === true, 'POST /v1/admin/licenses/generate returns 200 ok:true', {
    file: 'operator/src/routes/admin-core.ts',
    line: 389,
    actual: { status: generated.status, body: generated.json }
  })
  const jti = generated.json?.jti
  check.that(typeof jti === 'string' && /^[a-f0-9]{16}$/.test(jti), 'generated license has a 16-hex jti', { actual: jti })
  check.that(typeof generated.json?.license === 'string' && generated.json.license.startsWith('METIS-OP-1.'), 'generated license token has the METIS-OP-1 shape', {
    actual: generated.json?.license?.slice(0, 20)
  })

  // Activate it on the seat: the real desktop client only ever learns and sends the jti (a local,
  // unsigned parse of the pasted token — see src/main/operator-license-activate.ts), never the raw
  // token itself, over the wire.
  seat.licenseId = jti
  const hb1 = await seat.heartbeat()
  check.that(hb1.status === 200, 'heartbeat after activation returns 200', { actual: hb1.status })
  check.that(hb1.json?.approved === true, 'seat is approved once its heartbeat carries an active issued license jti', {
    file: 'operator/src/fleet.ts',
    line: 95,
    expected: true,
    actual: hb1.json?.approved
  })
  check.that(hb1.json?.tier === 'metis', 'seat resolves to the metis tier from the license', {
    file: 'operator/src/tiers.ts',
    line: 26,
    expected: 'metis',
    actual: hb1.json?.tier
  })
  check.that(Array.isArray(hb1.json?.entitlements) && hb1.json.entitlements.includes('ask'), 'seat carries the metis tier entitlements', {
    actual: hb1.json?.entitlements
  })

  // Revoke it.
  const revoke = await admin.post(`/v1/admin/licenses/${encodeURIComponent(jti)}/revoke`, undefined)
  check.that(revoke.status === 200 && revoke.json?.ok === true && revoke.json?.revoked === true, 'revoking the issued license returns ok:true, revoked:true', {
    file: 'operator/src/routes/admin-core.ts',
    line: 178,
    actual: revoke.json
  })

  const hb2 = await seat.heartbeat()
  check.that(hb2.status === 200, 'heartbeat after revoke returns 200', { actual: hb2.status })
  check.that(hb2.json?.approved === false, 'seat loses approval once the license is revoked', {
    file: 'operator/src/fleet.ts',
    line: 89,
    expected: false,
    actual: hb2.json?.approved
  })
  check.that(hb2.json?.tier === null, 'seat loses its tier once the license is revoked', { expected: null, actual: hb2.json?.tier })
  check.that(Array.isArray(hb2.json?.entitlements) && hb2.json.entitlements.length === 0, 'seat loses its entitlements once the license is revoked', {
    actual: hb2.json?.entitlements
  })

  // Batch of 5.
  const batch = await admin.post('/v1/admin/licenses/generate-batch', { count: 5, days: 7 })
  check.that(batch.status === 200 && batch.json?.ok === true, 'POST /v1/admin/licenses/generate-batch returns 200 ok:true', {
    file: 'operator/src/routes/licenses-batch.ts',
    line: 13,
    actual: { status: batch.status, body: batch.json }
  })
  const licenses = batch.json?.licenses ?? []
  check.that(licenses.length === 5, 'batch mints exactly 5 licenses', { actual: licenses.length })
  const jtis = new Set(licenses.map((l) => l.jti))
  check.that(jtis.size === 5, 'all 5 batch jtis are distinct', { actual: [...jtis] })

  const { verifyOperatorLicense } = await loadLicense(ctx.scratchDir)
  let verifiedCount = 0
  for (const l of licenses) {
    const result = await verifyOperatorLicense(ctx.ingestSecret, l.license, Date.now())
    if (result.ok && result.claims.jti === l.jti) verifiedCount++
  }
  check.that(verifiedCount === 5, 'all 5 batch tokens verify against OPERATOR_INGEST_SECRET with the matching jti', {
    file: 'src/shared/operator-license.ts',
    line: 109,
    expected: 5,
    actual: verifiedCount
  })

  return check.result('licensing', startedAt, { jti, batchId: batch.json?.batchId })
}
