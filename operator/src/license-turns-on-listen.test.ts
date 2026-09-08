/**
 * A key generated on the console's Licenses page must turn Listen on in Métis.
 *
 * Tony hit the opposite: heartbeats arriving and answered, yet recording refused with "your Métis
 * license does not include Listen". The seat had no license at all -- the key had gone into the
 * Identity card, which checks a key against a service that is not open yet and returns it unused --
 * so the Worker granted no tier and no entitlements, and the refusal named a license he did not
 * hold.
 *
 * Nothing pinned the whole chain, so this does: mint through the real admin route, heartbeat through
 * the real seat route with the `licenseId` field src/main/operator-ingest.ts actually sends, and
 * assert Listen comes back entitled. Both ends go through `handleRequest`, so a break anywhere
 * between the Licenses page and the Listen gate fails here.
 */
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
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

/** The Generate button on the Licenses page. */
async function mintLicense(store: OperatorStore, body: Record<string, unknown> = { days: 30 }) {
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
  return (await res.json()) as { license: string; jti: string; last4: string }
}

/** A seat heartbeat, carrying exactly the fields src/main/operator-ingest.ts sends. */
async function heartbeat(store: OperatorStore, nonce: string, extra: Record<string, unknown> = {}) {
  const deviceId = 'seat-listen-test'
  const bodyText = JSON.stringify({ seatHash: deviceId, os: 'darwin', appVersion: '1.8.9', queued: 0, dropped: 0, ...extra })
  const ts = String(NOW)
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText)))
  const res = await handleRequest(
    new Request('https://operator.test/v1/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_HMAC_HEADERS.ts]: ts,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce,
        [OPERATOR_HMAC_HEADERS.device]: deviceId,
        [OPERATOR_HMAC_HEADERS.sig]: sig
      },
      body: bodyText
    }),
    env(),
    {},
    { store, now: NOW }
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { tier?: string | null; entitlements?: string[]; approved?: boolean }
}

describe('a license generated on the Licenses page turns Listen on', () => {
  it('grants no tier and no Listen until a license is actually activated', async () => {
    const store = memoryStore()
    const body = await heartbeat(store, 'hb-none', { license: 'trial' })
    // This is the state Tony was stuck in, and the state the gate copy has to describe honestly.
    expect(body.tier ?? null).toBeNull()
    expect(body.entitlements ?? []).not.toContain('listen')
  })

  it('grants the Métis tier and Listen once the seat reports the license id', async () => {
    const store = memoryStore()
    const lic = await mintLicense(store)
    expect(lic.license.startsWith('METIS-OP-1.')).toBe(true)

    // `licenseId` is what activation stores as operatorLicenseJti and the heartbeat then sends.
    const body = await heartbeat(store, 'hb-licensed', { license: 'licensed', licenseId: lic.jti })
    expect(body.tier).toBe('metis')
    expect(body.entitlements).toContain('listen')
    // The rest of what a full Métis seat is owed, so a narrowed tier cannot pass unnoticed.
    expect(body.entitlements).toEqual(
      expect.arrayContaining(['ask', 'listen', 'recap', 'crm_push', 'operator_keys', 'intelligence', 'integrations'])
    )
    expect(body.approved).toBe(true)
  })

  it('a Métis Light license still withholds Listen, so the tier split stays real', async () => {
    const store = memoryStore()
    const lic = await mintLicense(store)
    await store.updateIssuedLicense(lic.jti, { tier: 'metis-light' })
    const body = await heartbeat(store, 'hb-light', { license: 'licensed', licenseId: lic.jti })
    expect(body.tier).toBe('metis-light')
    expect(body.entitlements).toContain('ask')
    expect(body.entitlements).not.toContain('listen')
  })

  it('a revoked license takes Listen away again', async () => {
    const store = memoryStore()
    const lic = await mintLicense(store)
    expect((await heartbeat(store, 'hb-a', { license: 'licensed', licenseId: lic.jti })).entitlements).toContain('listen')
    await store.revokeIssuedLicense(lic.jti, NOW)
    const after = await heartbeat(store, 'hb-b', { license: 'licensed', licenseId: lic.jti })
    expect(after.tier ?? null).toBeNull()
    expect(after.entitlements ?? []).not.toContain('listen')
  })
})
