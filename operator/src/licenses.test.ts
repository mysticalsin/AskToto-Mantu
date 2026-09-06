import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { generateLicenseKey, licenseStatus } from './licenses'
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

describe('Métis ATK licenses on Operator', () => {
  it('generateLicenseKey returns ATK Crockford keys', () => {
    const key = generateLicenseKey()
    expect(key).toMatch(/^ATK-[0-9A-HJKMNP-TV-Z]{20}$/)
    expect(licenseStatus(null, NOW)).toBe('invalid')
  })

  it('admin can mint, list, activate, heartbeat, and revoke end to end', async () => {
    const store = memoryStore()

    const created = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyName: 'Amaris Lab', seatCap: 2, contactName: 'Tony' })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(created.status).toBe(201)
    const minted = (await created.json()) as { ok: boolean; licenseKey: string }
    expect(minted.ok).toBe(true)
    expect(minted.licenseKey).toMatch(/^ATK-/)

    const list = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const listed = (await list.json()) as { licenses: { licenseKey: string; companyName: string }[] }
    expect(listed.licenses.some((l) => l.licenseKey === minted.licenseKey)).toBe(true)

    const activate = await handleRequest(
      new Request('https://operator.test/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          licenseKey: minted.licenseKey,
          machineId: 'machine-a',
          machineName: 'Tony Mac'
        })
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(activate.status).toBe(200)
    expect(await activate.json()).toEqual({
      ok: true,
      companyName: 'Amaris Lab',
      seatCap: 2,
      seatsUsed: 1,
      expiresAt: null
    })

    const beat = await handleRequest(
      new Request('https://operator.test/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ licenseKey: minted.licenseKey, machineId: 'machine-a' })
      }),
      env(),
      {},
      { store, now: NOW + 60_000 }
    )
    expect((await beat.json() as { ok: boolean }).ok).toBe(true)

    await handleRequest(
      new Request('https://operator.test/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ licenseKey: minted.licenseKey, machineId: 'machine-b' })
      }),
      env(),
      {},
      { store, now: NOW + 120_000 }
    )

    const capped = await handleRequest(
      new Request('https://operator.test/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ licenseKey: minted.licenseKey, machineId: 'machine-c' })
      }),
      env(),
      {},
      { store, now: NOW + 180_000 }
    )
    expect(await capped.json()).toEqual({ ok: false, error: 'seat_limit_reached' })

    const revoked = await handleRequest(
      new Request(
        `https://operator.test/v1/admin/licenses/${encodeURIComponent(minted.licenseKey)}/revoke`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
      ),
      env(),
      { access: tony },
      { store, now: NOW + 200_000 }
    )
    expect(revoked.status).toBe(200)

    const after = await handleRequest(
      new Request('https://operator.test/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ licenseKey: minted.licenseKey, machineId: 'machine-a' })
      }),
      env(),
      {},
      { store, now: NOW + 260_000 }
    )
    expect(await after.json()).toEqual({ ok: false, error: 'revoked' })
  })

  it('console HTML includes Licenses nav and generator', async () => {
    const store = memoryStore()
    const home = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain('data-page="licenses"')
    expect(html).toContain('id="lic-create"')
    expect(html).toContain('>Licenses<')
  })
})
