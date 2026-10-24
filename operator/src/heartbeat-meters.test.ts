import { beforeEach, describe, expect, it } from 'vitest'
import { generateOperatorLicense } from '../../src/shared/operator-license'
import { sha256Hex } from './crypto'
import { baseEnv, heartbeat, NOW } from './enroll/enroll-test-kit'
import { hmacHex } from './hmac'
import { handleRequest } from './index'
import { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER } from '../../src/shared/operator-hmac'
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

  it('seat B heartbeat never reports seat A usage even when body names A', async () => {
    const seatA = 'enroll-device-0001'
    const seatB = 'enroll-device-0002'
    const lic = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: 'ffffffffffffffff' })
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
    await store.putSetting('dailyTokenBudgetPerSeat', '5000', 'owner', NOW)
    await store.insertAsk({
      id: 'seat-a-ask',
      device_id: seatA,
      ts: utcMidnight(NOW) + 5,
      mode: 'answer',
      skill_id: null,
      skill_version: null,
      provider: 'cloudflare',
      model: null,
      ttft_ms: null,
      total_ms: null,
      input_tokens: 4000,
      output_tokens: 0,
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
    const bodyText = JSON.stringify({
      os: 'darwin',
      appVersion: '2.12.0',
      deviceId: seatA,
      device_id: seatA,
      seat: seatA
    })
    const sig = await hmacHex(lic.token, ingestCanonical(String(NOW), 'seat-b-nonce', seatB, await sha256Hex(bodyText)))
    const res = await handleRequest(
      new Request('https://operator.test/v1/heartbeat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPERATOR_LICENSE_HEADER]: lic.token,
          [OPERATOR_HMAC_HEADERS.device]: seatB,
          [OPERATOR_HMAC_HEADERS.ts]: String(NOW),
          [OPERATOR_HMAC_HEADERS.nonce]: 'seat-b-nonce',
          [OPERATOR_HMAC_HEADERS.sig]: sig
        },
        body: bodyText
      }),
      baseEnv(),
      {},
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const meters = ((await res.json()) as { meters: Array<{ used: number | null }> }).meters
    expect(meters).toHaveLength(1)
    expect(meters[0].used).toBe(0)
  })

  it('heartbeat response has no meters when no budget is set', async () => {
    const device = 'enroll-device-0001'
    const token = await licensedDevice(device)
    const res = await heartbeat(store, token, device)
    expect(((await res.json()) as { meters?: unknown[] }).meters).toEqual([])
  })
})
