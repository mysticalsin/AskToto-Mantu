#!/usr/bin/env node
/**
 * Proves the thing the licence work exists for: a seat that holds ONLY a licence key comes online.
 *
 * No shared ingest secret anywhere on the seat side. Everything is a real HTTP round trip against a
 * real `wrangler dev --local` Worker with real D1 -- the licence is minted through the console's own
 * admin route, and the heartbeat is signed exactly the way src/main/operator-hmac-sign.ts signs it,
 * so what is exercised is the wire contract rather than a helper in a unit test.
 *
 *   node operator/e2e/prove-license-only.mjs
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { bootWorker } from './boot.mjs'
import { adminClient } from './lib/admin.mjs'

const SEAT_KEY_INFO = 'metis-seat-key-v1'
const H = { ts: 'x-metis-ts', nonce: 'x-metis-nonce', device: 'x-metis-device', sig: 'x-metis-sig', license: 'x-metis-license' }

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Byte-for-byte the desktop's seatKeyFromLicense + operatorHmacHeaders. */
const seatKey = (token) => createHmac('sha256', token).update(SEAT_KEY_INFO, 'utf8').digest('hex')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

function licenseHeaders(token, deviceId, body) {
  const jti = token.split('.')[1]
  const ts = String(Date.now())
  const nonce = randomUUID()
  const canonical = `${ts}.${nonce}.${deviceId}.${sha256(body)}`
  return {
    'content-type': 'application/json',
    [H.ts]: ts,
    [H.nonce]: nonce,
    [H.device]: deviceId,
    [H.license]: jti,
    [H.sig]: createHmac('sha256', seatKey(token)).update(canonical, 'utf8').digest('hex')
  }
}

async function beat(baseUrl, token, deviceId, extra = {}) {
  const jti = token.split('.')[1]
  const body = JSON.stringify({ os: 'darwin', appVersion: '1.8.8', license: 'licensed', licenseId: jti, ...extra })
  const res = await fetch(`${baseUrl}/v1/heartbeat`, { method: 'POST', headers: licenseHeaders(token, deviceId, body), body })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const ctx = await bootWorker({ log: (m) => console.log(`  ${m}`) })
try {
  const admin = adminClient(ctx)
  console.log('\n1. Mint a licence in the console, exactly as the Generate button does')
  const minted = await admin.json('/v1/admin/licenses/generate', { method: 'POST', body: { days: 30 } })
  const token = minted.json?.license
  check('licence minted', Boolean(token), token ? `${minted.json.last4} · expires in 30d` : JSON.stringify(minted.json))

  console.log('\n2. A seat holding ONLY that licence heartbeats (no ingest secret anywhere)')
  const first = await beat(ctx.baseUrl, token, 'prove-seat-01')
  check('heartbeat accepted', first.status === 200, `HTTP ${first.status}`)
  check('seat authorised for platform keys', first.json?.approved === true, `approved=${first.json?.approved}`)

  console.log('\n3. The console now shows that seat, and the licence as activated')
  const dash = await admin.json('/v1/admin/dashboard')
  const seat = (dash.json?.profiles || []).find((p) => p.deviceId === 'prove-seat-01')
  check('seat appears in the fleet', Boolean(seat), seat ? `live=${seat.live} os=${seat.os}` : 'not found')
  const lic = (dash.json?.licenses?.issued || []).find((l) => l.jti === minted.json.jti)
  check('licence recorded against the machine', Boolean(lic), lic ? `jti ${lic.jti}` : 'not found')

  console.log('\n4. A seat that holds one licence cannot sign as another')
  const other = await admin.json('/v1/admin/licenses/generate', { method: 'POST', body: { days: 30 } })
  const otherJti = other.json.jti
  const body = JSON.stringify({ os: 'darwin', appVersion: '1.8.8', license: 'licensed', licenseId: otherJti })
  const headers = licenseHeaders(token, 'prove-liar', body)
  headers[H.license] = otherJti
  const forged = await fetch(`${ctx.baseUrl}/v1/heartbeat`, { method: 'POST', headers, body })
  check('impersonation refused', forged.status === 401, `HTTP ${forged.status}`)

  console.log('\n5. Revoking the licence cuts the seat off at the door')
  await admin.json(`/v1/admin/licenses/${minted.json.jti}/revoke`, { method: 'POST', body: {} })
  const after = await beat(ctx.baseUrl, token, 'prove-seat-01')
  check('revoked licence can no longer sign', after.status === 401, `HTTP ${after.status}`)
} finally {
  await ctx.stop?.()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${'='.repeat(64)}`)
console.log(failed.length ? `FAILED: ${failed.length}/${results.length}` : `PROVEN: ${results.length}/${results.length} checks, licence alone brings a seat online.`)
process.exit(failed.length ? 1 : 0)
