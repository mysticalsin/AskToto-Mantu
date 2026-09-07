/**
 * The loop a license actually travels: minted in the console, pasted into Métis, reported on the
 * seat's next heartbeat. Everything up to the paste already had tests; the last hop did not, which
 * is how `issued_licenses.activated_device` stayed unwritten while the Licenses page rendered a
 * column for it. These tests walk the whole path through the real Worker, so the console's answer to
 * "which machine is this license on" is proven end to end rather than assumed.
 */
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore, type OperatorStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000
const DAY = 86_400_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

/** Mints through the real admin route, exactly as the console's Generate button does. */
async function mint(store: OperatorStore, body: Record<string, unknown>, now = NOW) {
  const res = await handleRequest(
    new Request('https://operator.test/v1/admin/licenses/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    env(),
    { access: tony },
    { store, now }
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { license: string; jti: string; last4: string; exp: number }
}

/** A real signed seat beat: same HMAC the desktop's operator-hmac-sign.ts produces. */
async function beat(
  store: OperatorStore,
  deviceId: string,
  nonce: string,
  body: Record<string, unknown>,
  now = NOW
) {
  const bodyText = JSON.stringify(body)
  const ts = String(now)
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText)))
  return handleRequest(
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
    { store, now }
  )
}

function seatBody(lic: { jti: string; last4: string }, extra: Record<string, unknown> = {}) {
  return {
    os: 'darwin',
    appVersion: '1.8.7',
    license: 'licensed',
    licenseLast4: lic.last4,
    licenseId: lic.jti,
    ...extra
  }
}

describe('license activation (console -> Métis -> heartbeat)', () => {
  it('stamps activated_device and activated_at on the first heartbeat that carries the license', async () => {
    const store = memoryStore()
    const lic = await mint(store, { days: 30 })

    // Freshly minted: issued, never used. This is what the Licenses page reads as "Not yet activated".
    const beforeRow = await store.getIssuedLicense(lic.jti)
    expect(beforeRow?.activated_device ?? null).toBeNull()
    expect(beforeRow?.activated_at ?? null).toBeNull()

    const res = await beat(store, 'device-alpha', 'hb-1', seatBody(lic))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { approved?: boolean }).approved).toBe(true)

    const afterRow = await store.getIssuedLicense(lic.jti)
    expect(afterRow?.activated_device).toBe('device-alpha')
    expect(afterRow?.activated_at).toBe(NOW)

    // And the console can see it happen, filed with the mint and revoke rows.
    const audit = await store.listAudit(50)
    const row = audit.find((a) => a.action === 'activate-license')
    expect(row).toBeTruthy()
    expect(row?.actor).toBe('device-alpha')
    expect(row?.detail).toContain(lic.last4)
    // The token itself never reaches the audit trail, only its last4.
    expect(JSON.stringify(audit)).not.toContain(lic.license)
  })

  it('records the tier on a group-issued license so the audit row says what was granted', async () => {
    const store = memoryStore()
    const lic = await mint(store, { days: 30 })
    // The plain `/v1/admin/licenses/generate` route mints without a tier; a tier is only attached by
    // the per-group route (routes/groups.ts), which passes it through to the same mint core. Setting
    // it on the row here produces exactly the row that route writes, without standing up a group.
    await store.updateIssuedLicense(lic.jti, { tier: 'metis-light' })

    const res = await beat(store, 'device-light', 'hb-tier', seatBody(lic))
    expect(((await res.json()) as { tier?: string }).tier).toBe('metis-light')
    const row = (await store.listAudit(50)).find((a) => a.action === 'activate-license')
    expect(row?.detail).toContain('metis-light')
  })

  it('says nothing about a tier for a plainly-minted license, rather than guessing one', async () => {
    const store = memoryStore()
    const lic = await mint(store, { days: 30 })
    await beat(store, 'device-plainlic', 'hb-plainlic', seatBody(lic))
    const row = (await store.listAudit(50)).find((a) => a.action === 'activate-license')
    expect(row?.detail).toBe(`${lic.last4} activated`)
  })

  it('keeps the first device: a second machine presenting the same token does not take it over', async () => {
    const store = memoryStore()
    const lic = await mint(store, { days: 30 })
    await beat(store, 'device-first', 'hb-first', seatBody(lic))
    await beat(store, 'device-second', 'hb-second', seatBody(lic), NOW + 60_000)

    const row = await store.getIssuedLicense(lic.jti)
    expect(row?.activated_device).toBe('device-first')
    expect(row?.activated_at).toBe(NOW)
    // Exactly one activation, however many seats present the token.
    expect((await store.listAudit(50)).filter((a) => a.action === 'activate-license')).toHaveLength(1)
  })

  it('does not re-stamp or re-audit on every subsequent beat from the same seat', async () => {
    const store = memoryStore()
    const lic = await mint(store, { days: 30 })
    for (let i = 0; i < 4; i += 1) {
      await beat(store, 'device-alpha', `hb-rep-${i}`, seatBody(lic), NOW + i * 60_000)
    }
    const row = await store.getIssuedLicense(lic.jti)
    expect(row?.activated_at).toBe(NOW)
    expect((await store.listAudit(50)).filter((a) => a.action === 'activate-license')).toHaveLength(1)
  })

  it('leaves an expired license unactivated: presenting a dead token grants nothing to date', async () => {
    const store = memoryStore()
    const lic = await mint(store, { days: 1 })
    const afterExpiry = lic.exp * 1000 + DAY

    const res = await beat(store, 'device-late', 'hb-late', seatBody(lic), afterExpiry)
    expect(((await res.json()) as { approved?: boolean }).approved).toBe(false)

    const row = await store.getIssuedLicense(lic.jti)
    expect(row?.activated_device ?? null).toBeNull()
    expect(row?.activated_at ?? null).toBeNull()
  })

  it('leaves a revoked license alone and keeps the seat locked out', async () => {
    const store = memoryStore()
    const lic = await mint(store, { days: 30 })
    await store.revokeIssuedLicense(lic.jti, NOW)

    const res = await beat(store, 'device-revoked', 'hb-revoked', seatBody(lic), NOW + 60_000)
    expect(((await res.json()) as { approved?: boolean }).approved).toBe(false)

    const row = await store.getIssuedLicense(lic.jti)
    expect(row?.activated_device ?? null).toBeNull()
  })

  it('ignores a well-formed jti this Worker never issued, without inventing a row', async () => {
    const store = memoryStore()
    const res = await beat(store, 'device-foreign', 'hb-foreign', {
      os: 'darwin',
      appVersion: '1.8.7',
      license: 'licensed',
      licenseLast4: 'ab12',
      licenseId: 'ffffffffffffffff'
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { approved?: boolean }).approved).toBe(false)
    expect(await store.getIssuedLicense('ffffffffffffffff')).toBeNull()
    expect((await store.listAudit(50)).filter((a) => a.action === 'activate-license')).toHaveLength(0)
  })

  it('an unlicensed seat never touches the licenses table at all', async () => {
    const store = memoryStore()
    await mint(store, { days: 30 })
    await beat(store, 'device-plain', 'hb-plain', { os: 'darwin', appVersion: '1.8.7', license: 'trial' })
    expect((await store.listAudit(50)).filter((a) => a.action === 'activate-license')).toHaveLength(0)
    const all = await store.listIssuedLicenses()
    expect(all.every((r) => !r.activated_device)).toBe(true)
  })
})
