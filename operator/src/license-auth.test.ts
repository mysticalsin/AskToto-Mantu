/**
 * The thing Tony actually asked for: generate a licence in the console, paste it into Métis, and
 * that alone brings the seat online. No OPERATOR_INGEST_SECRET typed into Settings.
 *
 * These go through the real `handleRequest` seat gate, signing the way
 * src/main/operator-hmac-sign.ts signs, so what is proven here is the wire contract rather than a
 * helper in isolation.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { OPERATOR_SEAT_KEY_INFO, parseOperatorLicense } from '../../src/shared/operator-license'
import { memoryStore, type OperatorStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

/** Exactly what the desktop derives (src/main/operator-hmac-sign.ts). */
function seatKey(token: string): string {
  return createHmac('sha256', token).update(OPERATOR_SEAT_KEY_INFO, 'utf8').digest('hex')
}

async function mint(store: OperatorStore, body: Record<string, unknown> = { days: 30 }) {
  const res = await handleRequest(
    new Request('https://operator.test/v1/admin/licenses/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    env(),
    { access: tony },
    { store, now: NOW }
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { license: string; jti: string; last4: string; exp: number }
}

/** A heartbeat signed with a licence and no shared secret, as a licensed seat sends it. */
async function beatWithLicense(
  store: OperatorStore,
  deviceId: string,
  nonce: string,
  token: string,
  now = NOW,
  overrides: { jtiHeader?: string; key?: string } = {}
) {
  const parsed = parseOperatorLicense(token)!
  const bodyText = JSON.stringify({ os: 'darwin', appVersion: '1.8.7', license: 'licensed', licenseId: parsed.jti })
  const ts = String(now)
  const key = overrides.key ?? seatKey(token)
  const sig = await hmacHex(key, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText)))
  return handleRequest(
    new Request('https://operator.test/v1/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_HMAC_HEADERS.ts]: ts,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce,
        [OPERATOR_HMAC_HEADERS.device]: deviceId,
        [OPERATOR_HMAC_HEADERS.license]: overrides.jtiHeader ?? parsed.jti,
        [OPERATOR_HMAC_HEADERS.sig]: sig
      },
      body: bodyText
    }),
    env(),
    {},
    { store, now }
  )
}

describe('a licence is enough to bring a seat online', () => {
  it('accepts a heartbeat signed with the licence alone, and the seat lands in the fleet', async () => {
    const store = memoryStore()
    const lic = await mint(store)

    const res = await beatWithLicense(store, 'device-licensed', 'hb-1', lic.license)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; approved?: boolean; tier?: string }
    expect(body.ok).toBe(true)
    // The licence authorises platform keys, so the seat is genuinely online, not merely accepted.
    expect(body.approved).toBe(true)

    const seat = await store.getSeat('device-licensed')
    expect(seat?.device_id).toBe('device-licensed')
    // ...and the same beat records the activation, so the console shows which machine holds it.
    expect((await store.getIssuedLicense(lic.jti))?.activated_device).toBe('device-licensed')
  })

  it('rejects a seat that names a licence it cannot sign for', async () => {
    const store = memoryStore()
    const a = await mint(store)
    const b = await mint(store)
    // Holds licence A, claims to be licence B: the exact escalation the shared secret used to allow.
    const res = await beatWithLicense(store, 'device-liar', 'hb-liar', a.license, NOW, { jtiHeader: b.jti })
    expect(res.status).toBe(401)
    expect((await res.json()) as { error: string }).toEqual({ ok: false, error: 'bad HMAC signature' })
  })

  it('rejects a licence this Worker never issued, with one message that reveals nothing', async () => {
    const store = memoryStore()
    const lic = await mint(store)
    const res = await beatWithLicense(store, 'device-unknown', 'hb-unknown', lic.license, NOW, {
      jtiHeader: 'ffffffffffffffff'
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'license cannot sign', code: 'license' })
  })

  it('a revoked licence can no longer sign, so revoking really cuts the seat off', async () => {
    const store = memoryStore()
    const lic = await mint(store)
    expect((await beatWithLicense(store, 'device-rev', 'hb-a', lic.license)).status).toBe(200)

    await store.revokeIssuedLicense(lic.jti, NOW)
    const after = await beatWithLicense(store, 'device-rev', 'hb-b', lic.license, NOW + 60_000)
    expect(after.status).toBe(401)
    expect(await after.json()).toEqual({ ok: false, error: 'license cannot sign', code: 'license' })
  })

  it('the shared ingest secret still signs, so seats that predate this keep working', async () => {
    const store = memoryStore()
    const bodyText = JSON.stringify({ os: 'darwin', appVersion: '1.8.7', license: 'trial' })
    const ts = String(NOW)
    const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, 'hb-legacy', 'device-legacy', await sha256Hex(bodyText)))
    const res = await handleRequest(
      new Request('https://operator.test/v1/heartbeat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPERATOR_HMAC_HEADERS.ts]: ts,
          [OPERATOR_HMAC_HEADERS.nonce]: 'hb-legacy',
          [OPERATOR_HMAC_HEADERS.device]: 'device-legacy',
          [OPERATOR_HMAC_HEADERS.sig]: sig
        },
        body: bodyText
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
  })

  it('the shared secret cannot be used to sign as a licence it does not hold', async () => {
    const store = memoryStore()
    const lic = await mint(store)
    // Knowing OPERATOR_INGEST_SECRET no longer lets a caller claim any licence id it likes: once the
    // header names a licence, only that licence's derived key verifies.
    const res = await beatWithLicense(store, 'device-secret', 'hb-secret', lic.license, NOW, {
      key: TEST_INGEST_SECRET
    })
    expect(res.status).toBe(401)
  })
})
