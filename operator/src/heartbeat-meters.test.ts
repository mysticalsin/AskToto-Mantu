import { beforeEach, describe, expect, it } from 'vitest'
import { generateOperatorLicense } from '../../src/shared/operator-license'
import { sha256Hex } from './crypto'
import { heartbeat, NOW } from './enroll/enroll-test-kit'
import { utcMidnight } from './meters'
import { memoryStore, type OperatorStore } from './store'
import { TEST_INGEST_SECRET } from './test-fixtures'

let store: OperatorStore
beforeEach(() => {
  store = memoryStore()
})

async function licensedDevice(device: string): Promise<string> {
  const lic = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: 'eeeeeeeeeeeeeeee' })
  await store.putIssuedLicense({
    ...lic.claims,
    key_hash: await sha256Hex(lic.token),
    last4: lic.last4,
    days: 30,
    revoked: 0,
    created_at: NOW,
    created_by: 'owner@example.test',
    tier: 'metis'
  })
  return lic.token
}

describe('heartbeat meters (G79)', () => {
  it('heartbeat response carries meters when a daily budget is set', async () => {
    const device = 'enroll-device-0001'
    const token = await licensedDevice(device)
    await store.putSetting('dailyTokenBudgetPerSeat', '5000', 'owner', NOW)
    await store.insertAsk({
      id: 'hb-ask',
      device_id: device,
      ts: utcMidnight(NOW) + 5,
      mode: 'answer',
      skill_id: null,
      skill_version: null,
      provider: 'cloudflare',
      model: null,
      ttft_ms: null,
      total_ms: null,
      input_tokens: 40,
      output_tokens: 2,
      cache_read: null,
      cache_write: null,
      cache_uncached: null,
      cache_status: null,
      cache_ttl: null,
      outcome: 'answered',
      rating: null,
      prompt_cipher: null,
      prompt_iv: null,
      preview: null,
      question_type: null,
      path_tag: 'portal-cf'
    })
    const res = await heartbeat(store, token, device)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { meters?: Array<Record<string, unknown>> }
    expect(json.meters).toHaveLength(1)
    expect(json.meters?.[0]).toMatchObject({ id: 'managed_tokens', limit: 5000, used: 42, window: 'day' })
  })

  it('heartbeat response has no meters when no budget is set', async () => {
    const device = 'enroll-device-0001'
    const token = await licensedDevice(device)
    const res = await heartbeat(store, token, device)
    expect(((await res.json()) as { meters?: unknown[] }).meters).toEqual([])
  })
})
